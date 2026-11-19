import type { LinkPreview } from "./unfurl.js";
import type { Pool, PoolClient } from "pg";
import { appendToOutbox, getRequestContext, newId, withTransaction, type Principal } from "@workspace/shared";
import type { EventPayloadInput, EventType } from "@workspace/contracts";

export class NotFound extends Error {
  override name = "NotFound";
}
export class Forbidden extends Error {
  override name = "Forbidden";
}
export class Invalid extends Error {
  override name = "Invalid";
}

export interface ChannelRow {
  id: string;
  kind: "public" | "private" | "dm" | "group";
  name: string | null;
  /** How people read it ("Kỹ thuật"); null shows `name`. */
  display_name?: string | null;
  topic: string;
  last_seq: string;
  archived: boolean;
  created_by: string;
}

export interface MessageDto {
  id: string;
  channelId: string;
  seq: number;
  threadRootId: string | null;
  authorId: string;
  authorType: string;
  /** Imported history: the author's name in the old tool when they are not a member here. */
  importAuthor: string | null;
  body: string;
  mentions: string[];
  attachments: unknown[];
  replyCount: number;
  lastReplyAt: string | null;
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  clientMsgId: string | null;
  /** `users`: who reacted, first 20 in the order they did (the tooltip names them; `count` is the total). */
  reactions: { emoji: string; count: number; mine: boolean; users: string[] }[];
  /** Link preview cards (unfurl.ts); empty while being fetched, or when the author hid them. */
  linkPreviews: LinkPreview[];
  /** Pinned in its conversation; saved by the person asking. */
  pinned?: boolean;
  saved?: boolean;
  /** Forwarded from another conversation: its author, conversation and time. */
  forwardOf?: ForwardOf | null;
}
export interface ForwardOf {
  messageId: string;
  channelId: string;
  channelKind: string;
  channelName: string | null;
  authorId: string;
  createdAt: string;
}

const MENTION = /<@([A-Za-z0-9_-]{1,64})>/g;

/** Mentions are written as <@userId> by clients; @AI and agents use <@agent:ID>. */
export function parseMentions(body: string): string[] {
  return [...new Set([...body.matchAll(MENTION)].map((m) => m[1]!))];
}

export async function emit<T extends EventType>(c: PoolClient, eventType: T, aggregateType: string, aggregateId: string, payload: EventPayloadInput<T>) {
  const { actorId } = getRequestContext();
  await appendToOutbox(c, {
    eventId: newId(),
    eventType,
    version: 1,
    aggregateType,
    aggregateId,
    actorId,
    occurredAt: new Date().toISOString(),
    payload,
  });
}

export async function getChannel(c: PoolClient, channelId: string): Promise<ChannelRow> {
  const r = await c.query<ChannelRow>("SELECT id, kind, name, display_name, topic, last_seq, archived, created_by FROM channels WHERE id = $1", [channelId]);
  if (!r.rows[0]) throw new NotFound("channel not found");
  return r.rows[0];
}

export async function membership(c: PoolClient, channelId: string, userId: string): Promise<{ role: string; last_read_seq: string } | null> {
  const r = await c.query<{ role: string; last_read_seq: string }>("SELECT role, last_read_seq FROM channel_members WHERE channel_id = $1 AND user_id = $2", [channelId, userId]);
  return r.rows[0] ?? null;
}

/**
 * Read access: members always; anyone with channel.read may read public channels.
 * Private channels, DMs and groups are member-only regardless of role.
 */
export async function assertCanRead(c: PoolClient, p: Principal, channelId: string): Promise<ChannelRow> {
  const ch = await getChannel(c, channelId);
  if (await membership(c, channelId, p.id)) return ch;
  if (ch.kind === "public" && p.grants.some((g) => g.permission === "channel.read")) return ch;
  throw new Forbidden("not a member of this channel");
}

export async function assertMember(c: PoolClient, p: Principal, channelId: string): Promise<ChannelRow> {
  const ch = await getChannel(c, channelId);
  if (!(await membership(c, channelId, p.id))) throw new Forbidden("not a member of this channel");
  if (ch.archived) throw new Forbidden("channel is archived");
  return ch;
}

export async function memberIds(c: PoolClient, channelId: string): Promise<string[]> {
  return (await c.query<{ user_id: string }>("SELECT user_id FROM channel_members WHERE channel_id = $1", [channelId])).rows.map((r) => r.user_id);
}

/** Only people who belong to this workspace can be put in a conversation (known_members). */
export async function assertKnownMembers(c: PoolClient, userIds: string[]): Promise<void> {
  const want = [...new Set(userIds)];
  if (!want.length) return;
  const known = new Set((await c.query<{ user_id: string }>("SELECT user_id FROM known_members WHERE user_id = ANY($1)", [want])).rows.map((r) => r.user_id));
  const missing = want.filter((u) => !known.has(u));
  if (missing.length) throw new Invalid(`not members of this workspace: ${missing.join(", ")}`);
}

/**
 * Chat learns members from identity events, which can trail an invite by a few seconds. Before a
 * request that adds people, wait (outside any transaction, one short query per try) until they are
 * known or ~10s pass; the transaction then checks once with assertKnownMembers.
 */
export async function waitForKnownMembers(pool: Pool, userIds: string[], tries = 20): Promise<void> {
  const want = [...new Set(userIds)];
  for (let i = 0; i < tries && want.length; i++) {
    const n = (await withTransaction(pool, (c) => c.query<{ n: number }>("SELECT count(*)::int AS n FROM known_members WHERE user_id = ANY($1)", [want]))).rows[0]!.n;
    if (n === want.length) return;
    await new Promise((r) => setTimeout(r, 500));
  }
}

export async function createChannel(
  c: PoolClient,
  p: Principal,
  input: { kind: "public" | "private" | "group"; name: string | null; displayName?: string | undefined; topic: string; memberIds: string[] },
) {
  const id = newId();
  const members = [...new Set([p.id, ...input.memberIds])];
  await assertKnownMembers(
    c,
    input.memberIds.filter((u) => u !== p.id),
  );
  await c.query("INSERT INTO channels (id, kind, name, display_name, topic, created_by) VALUES ($1,$2,$3,$4,$5,$6)", [
    id,
    input.kind,
    input.name,
    input.displayName && input.displayName !== input.name ? input.displayName : null,
    input.topic,
    p.id,
  ]);
  for (const u of members) {
    await c.query("INSERT INTO channel_members (channel_id, user_id, role) VALUES ($1,$2,$3)", [id, u, u === p.id ? "admin" : "member"]);
  }
  await emit(c, "chat.channel.created.v1", "chat.channel", id, { channelId: id, kind: input.kind, name: input.name, topic: input.topic, memberIds: members });
  return { id, members };
}

/** Find-or-create a DM; the sorted pair is a unique key, so concurrent creates converge. */
export async function openDm(c: PoolClient, p: Principal, otherUserId: string) {
  if (otherUserId === p.id) throw new Invalid("cannot DM yourself");
  await assertKnownMembers(c, [otherUserId]);
  const key = [p.id, otherUserId].sort().join(":");
  const existing = await c.query<{ id: string }>("SELECT id FROM channels WHERE dm_key = $1", [key]);
  if (existing.rows[0]) return { id: existing.rows[0].id, created: false };
  const id = newId();
  const ins = await c.query("INSERT INTO channels (id, kind, dm_key, created_by) VALUES ($1,'dm',$2,$3) ON CONFLICT (dm_key) DO NOTHING", [id, key, p.id]);
  if (!ins.rowCount) {
    const again = await c.query<{ id: string }>("SELECT id FROM channels WHERE dm_key = $1", [key]);
    return { id: again.rows[0]!.id, created: false };
  }
  for (const u of [p.id, otherUserId]) await c.query("INSERT INTO channel_members (channel_id, user_id) VALUES ($1,$2)", [id, u]);
  await emit(c, "chat.channel.created.v1", "chat.channel", id, { channelId: id, kind: "dm", name: null, memberIds: [p.id, otherUserId] });
  return { id, created: true };
}

export interface PostInput {
  channelId: string;
  body: string;
  clientMsgId: string | null;
  threadRootId: string | null;
  attachments: { fileId: string; name: string; size: number; contentType: string }[];
  author: { id: string; type: "user" | "agent" | "system" };
  /** A forward copies someone else's words: it keeps their @mentions as text but notifies nobody again. */
  forwardOf?: ForwardOf | undefined;
  /** Binds uploaded files to the new message and returns their trusted metadata (replaces `attachments`). */
  bindAttachments?: ((messageId: string) => Promise<PostInput["attachments"]>) | undefined;
}

/**
 * Posts a message. Idempotent on clientMsgId (retries and double-submits return
 * the original). seq comes from an UPDATE ... RETURNING on the channel row, so
 * concurrent posts in a channel serialize and seq is gap-free and ordered.
 */
export async function postMessage(c: PoolClient, input: PostInput): Promise<{ message: MessageDto; created: boolean; channel: ChannelRow }> {
  if (input.clientMsgId) {
    // Serialize concurrent submits of the same client message (double click, two tabs):
    // the second waits for the first to commit, then finds it below and returns it.
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${input.channelId}:${input.clientMsgId}`]);
    const dup = await c.query("SELECT id FROM messages WHERE channel_id = $1 AND client_msg_id = $2", [input.channelId, input.clientMsgId]);
    if (dup.rows[0]) return { message: await loadMessage(c, dup.rows[0].id, input.author.id), created: false, channel: await getChannel(c, input.channelId) };
  }
  if (input.threadRootId) {
    const root = await c.query<{ channel_id: string; thread_root_id: string | null }>("SELECT channel_id, thread_root_id FROM messages WHERE id = $1", [input.threadRootId]);
    if (!root.rows[0] || root.rows[0].channel_id !== input.channelId) throw new Invalid("thread root not in this channel");
    if (root.rows[0].thread_root_id) throw new Invalid("replies cannot have replies");
  }
  const seqRow = await c.query<{ last_seq: string }>("UPDATE channels SET last_seq = last_seq + 1 WHERE id = $1 RETURNING last_seq", [input.channelId]);
  const seq = seqRow.rows[0]!.last_seq;
  const id = newId();
  const mentions = input.forwardOf ? [] : parseMentions(input.body);
  const attachments = input.bindAttachments ? await input.bindAttachments(id) : input.attachments;
  await c.query(
    `INSERT INTO messages (id, channel_id, seq, thread_root_id, author_id, author_type, body, mentions, attachments, client_msg_id, forward_of)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      id,
      input.channelId,
      seq,
      input.threadRootId,
      input.author.id,
      input.author.type,
      input.body,
      mentions,
      JSON.stringify(attachments),
      input.clientMsgId,
      input.forwardOf ? JSON.stringify(input.forwardOf) : null,
    ],
  );
  if (input.threadRootId) {
    await c.query("UPDATE messages SET reply_count = reply_count + 1, last_reply_at = now() WHERE id = $1", [input.threadRootId]);
  }
  // The author has read their own message.
  await c.query("UPDATE channel_members SET last_read_seq = GREATEST(last_read_seq, $3) WHERE channel_id = $1 AND user_id = $2", [input.channelId, input.author.id, seq]);
  const channel = await getChannel(c, input.channelId);
  const members = await memberIds(c, input.channelId);
  // Who asked for quiet (muted, for now or for good, or "nothing") and who wants every message.
  const prefs = (
    await c.query<{ user_id: string; quiet: boolean; everything: boolean }>(
      `SELECT user_id, (muted OR coalesce(muted_until > now(), false) OR coalesce(notify, '') = 'none') AS quiet, coalesce(notify, '') = 'all' AS everything
         FROM channel_members WHERE channel_id = $1 AND user_id <> $2`,
      [input.channelId, input.author.id],
    )
  ).rows;
  await emit(c, "chat.message.created.v1", "chat.message", id, {
    messageId: id,
    channelId: input.channelId,
    channelKind: channel.kind,
    channelName: channel.name,
    seq: Number(seq),
    threadRootId: input.threadRootId,
    authorId: input.author.id,
    authorType: input.author.type,
    body: input.body,
    mentions,
    attachments: attachments.map((a) => ({ fileId: a.fileId, name: a.name, contentType: a.contentType, size: a.size })),
    // DM/group recipients feed "unanswered messages" on Home.
    recipients: channel.kind === "dm" || channel.kind === "group" ? members.filter((m) => m !== input.author.id) : [],
    quiet: prefs.filter((x) => x.quiet).map((x) => x.user_id),
    everyMessage: channel.kind === "public" || channel.kind === "private" ? prefs.filter((x) => x.everything && !x.quiet).map((x) => x.user_id) : [],
  });
  return { message: await loadMessage(c, id, input.author.id), created: true, channel };
}

export async function loadMessage(c: PoolClient, id: string, viewerId: string): Promise<MessageDto> {
  const rows = await selectMessages(c, "m.id = $1", [id], viewerId, "seq ASC", 1);
  if (!rows[0]) throw new NotFound("message not found");
  return rows[0];
}

export async function selectMessages(c: PoolClient, where: string, params: unknown[], viewerId: string, order: string, limit: number): Promise<MessageDto[]> {
  const viewerParam = `$${params.length + 1}`;
  const r = await c.query(
    `SELECT m.id, m.channel_id AS "channelId", m.seq::bigint AS seq, m.thread_root_id AS "threadRootId", m.author_id AS "authorId",
            m.author_type AS "authorType", m.import_author AS "importAuthor",
            CASE WHEN m.deleted_at IS NULL THEN m.body ELSE '' END AS body,
            m.mentions, m.attachments, m.reply_count AS "replyCount", m.last_reply_at AS "lastReplyAt",
            m.edited_at AS "editedAt", m.deleted_at AS "deletedAt", m.created_at AS "createdAt", m.client_msg_id AS "clientMsgId", m.forward_of AS "forwardOf",
            coalesce((SELECT json_agg(json_build_object('emoji', x.emoji, 'count', x.n, 'mine', x.mine, 'users', x.users) ORDER BY x.emoji)
                        FROM (SELECT emoji, count(*)::int AS n, bool_or(user_id = ${viewerParam}) AS mine,
                                     (array_agg(user_id ORDER BY created_at, user_id))[1:20] AS users
                                FROM reactions r WHERE r.message_id = m.id GROUP BY emoji) x), '[]') AS reactions,
            CASE WHEN m.deleted_at IS NULL AND NOT m.previews_hidden THEN m.link_previews ELSE '[]'::jsonb END AS "linkPreviews",
            EXISTS (SELECT 1 FROM pins pn WHERE pn.message_id = m.id) AS pinned,
            EXISTS (SELECT 1 FROM saved_messages sv WHERE sv.message_id = m.id AND sv.user_id = ${viewerParam}) AS saved,
            (SELECT json_build_object('question', pl.question, 'options', pl.options, 'multi', pl.multi, 'closed', pl.closed_at IS NOT NULL,
                    'voters', (SELECT count(DISTINCT pv.user_id)::int FROM poll_votes pv WHERE pv.message_id = m.id),
                    'votes', coalesce((SELECT json_agg(json_build_object('option', v.option_id, 'count', v.n, 'mine', v.mine))
                                         FROM (SELECT option_id, count(*)::int AS n, bool_or(user_id = ${viewerParam}) AS mine
                                                 FROM poll_votes pv WHERE pv.message_id = m.id GROUP BY option_id) v), '[]'))
               FROM polls pl WHERE pl.message_id = m.id) AS poll
       FROM messages m WHERE ${where} ORDER BY ${order} LIMIT ${limit}`,
    [...params, viewerId],
  );
  return r.rows.map((row) => ({ ...row, seq: Number(row.seq) })) as MessageDto[];
}

/**
 * Channel settings: channel admins (the creator, or anyone made admin) and workspace admins
 * with channel.manage rename, change the topic, archive and restore. An archived channel keeps its
 * history (readable, searchable by members) but takes no new messages; #general cannot be archived.
 */
export async function updateChannel(
  c: PoolClient,
  p: Principal,
  channelId: string,
  input: { name?: string | undefined; displayName?: string | undefined; topic?: string | undefined; archived?: boolean | undefined; autoJoin?: boolean | undefined },
) {
  const ch = await getChannel(c, channelId);
  if (ch.kind !== "public" && ch.kind !== "private") throw new Invalid("only channels have settings");
  const m = await membership(c, channelId, p.id);
  const admin = p.grants.some((g) => g.permission === "channel.manage");
  if (m?.role !== "admin" && !admin) throw new Forbidden("channel admin required");
  // Who every newcomer joins is a workspace decision, not a channel admin's.
  if (input.autoJoin !== undefined && !admin) throw new Forbidden("workspace admin required");
  if (input.autoJoin && ch.kind !== "public") throw new Invalid("only public channels can be joined automatically");
  const isDefault = (await c.query<{ is_default: boolean }>("SELECT is_default FROM channels WHERE id = $1", [channelId])).rows[0]?.is_default ?? false;
  if (isDefault && input.archived) throw new Invalid("the default channel cannot be archived");
  const r = await c.query<{ name: string; display_name: string | null; topic: string; archived: boolean; auto_join: boolean }>(
    `UPDATE channels SET name = coalesce($2, name), topic = coalesce($3, topic), archived = coalesce($4, archived), auto_join = coalesce($5, auto_join),
            display_name = CASE WHEN $6::boolean THEN nullif($7, '') ELSE display_name END
      WHERE id = $1 RETURNING name, display_name, topic, archived, auto_join`,
    [channelId, input.name ?? null, input.topic ?? null, input.archived ?? null, input.autoJoin ?? null, input.displayName !== undefined, input.displayName ?? null],
  );
  const u = r.rows[0]!;
  await emit(c, "chat.channel.updated.v1", "chat.channel", channelId, { channelId, kind: ch.kind, name: u.name, topic: u.topic, archived: u.archived, previousName: ch.name });
  return { id: channelId, kind: ch.kind, name: u.name, displayName: u.display_name, topic: u.topic, archived: u.archived, autoJoin: u.auto_join || isDefault };
}
