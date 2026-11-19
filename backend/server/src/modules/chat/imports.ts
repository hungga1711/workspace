import type { PoolClient } from "pg";
import { newId, type Principal } from "@workspace/shared";
import { emit } from "./domain.js";

export interface ImportedMessage {
  /** The message's id in the old tool (Slack "ts"); replies point at their root with threadKey. */
  key: string;
  threadKey: string | null;
  at: string;
  text: string;
  /** A workspace member when the export's person matched one (email or name), else null. */
  userId: string | null;
  authorName: string;
}

const slug = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70) || "slack";

/**
 * One Slack channel with its history becomes a public channel here. Messages keep their time and
 * order, replies stay in their threads, and matched people appear as themselves; the rest keep
 * their Slack name. Each message is announced as an update (search indexes it) rather than as new,
 * so a history import never sends notifications.
 */
export async function importChannel(c: PoolClient, p: Principal, input: { name: string; topic: string; source: "slack"; messages: ImportedMessage[] }) {
  const base = slug(input.name);
  let name = base;
  for (let i = 1; (await c.query("SELECT 1 FROM channels WHERE kind IN ('public','private') AND lower(name) = $1", [name])).rowCount; i++)
    name = `${base}-${input.source}${i > 1 ? `-${i}` : ""}`;
  const known = new Set(
    (
      await c.query<{ user_id: string }>("SELECT user_id FROM known_members WHERE user_id = ANY($1)", [
        [...new Set(input.messages.map((m) => m.userId).filter((x): x is string => !!x))],
      ])
    ).rows.map((r) => r.user_id),
  );
  const id = newId();
  await c.query("INSERT INTO channels (id, kind, name, topic, created_by) VALUES ($1,'public',$2,$3,$4)", [id, name, input.topic.slice(0, 250), p.id]);
  const members = [...new Set([p.id, ...known])];
  for (const u of members) await c.query("INSERT INTO channel_members (channel_id, user_id, role) VALUES ($1,$2,$3)", [id, u, u === p.id ? "admin" : "member"]);
  await emit(c, "chat.channel.created.v1", "chat.channel", id, { channelId: id, kind: "public", name, topic: input.topic, memberIds: members });

  const ordered = [...input.messages].filter((m) => m.text.trim()).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const byKey = new Map<string, string>();
  let seq = 0;
  for (const m of ordered) {
    const root = m.threadKey && m.threadKey !== m.key ? byKey.get(m.threadKey) : undefined;
    if (m.threadKey && m.threadKey !== m.key && !root) continue; // a reply whose root was not exported
    const mid = newId();
    seq++;
    const me = m.userId && known.has(m.userId);
    const body = m.text.slice(0, 20000);
    await c.query(
      `INSERT INTO messages (id, channel_id, seq, thread_root_id, author_id, author_type, body, import_author, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [mid, id, seq, root ?? null, me ? m.userId : p.id, me ? "user" : "import", body, me ? null : m.authorName.slice(0, 120), m.at],
    );
    if (root) await c.query("UPDATE messages SET reply_count = reply_count + 1, last_reply_at = greatest(coalesce(last_reply_at, $2), $2) WHERE id = $1", [root, m.at]);
    else byKey.set(m.key, mid);
    await emit(c, "chat.message.updated.v1", "chat.message", mid, { messageId: mid, channelId: id, channelKind: "public", channelName: name, body });
  }
  await c.query("UPDATE channels SET last_seq = $2 WHERE id = $1", [id, seq]);
  await c.query("UPDATE channel_members SET last_read_seq = $2 WHERE channel_id = $1", [id, seq]);
  return { channelId: id, name, imported: seq };
}
