import type { PoolClient } from "pg";
import { asKnown, type EventEnvelope } from "@workspace/contracts";
import { newId, projectWorkspaceTimeZone } from "@workspace/shared";
import { emit, postMessage } from "./domain.js";

export const ONBOARDING_TOPICS = ["workspace.platform.workspace", "workspace.identity.member"];

type Lang = "vi" | "en";

/**
 * A new workspace starts with #general and one welcome message from "system", nothing else: no sample discussion and no
 * starter channels, so the company's chat holds only what its people write. The message says where AI comes in.
 */
const WELCOME: Record<Lang, { topic: string; body: (company: string, ai: boolean) => string }> = {
  vi: {
    topic: "Kênh chung của cả công ty",
    body: (company, ai) =>
      `Chào mừng mọi người tới ${company} trên workspace. Đây là #general, kênh chung của cả công ty.` +
      (ai ? ` Gõ @AI trong tin nhắn để hỏi AI hoặc nhờ AI tạo việc từ cuộc trò chuyện; chưa có AI thì kết nối ở AI › Kết nối.` : ""),
  },
  en: {
    topic: "The whole company's channel",
    body: (company, ai) =>
      `Welcome to ${company} on workspace. This is #general, the channel for the whole company.` +
      (ai ? ` Type @AI in a message to ask AI or have it turn a conversation into tasks; no AI yet? Connect one in AI › Connect.` : ""),
  },
};

const SYSTEM = { id: "system", type: "system" as const };

async function insertChannel(c: PoolClient, name: string, topic: string, ownerId: string): Promise<string> {
  const id = newId();
  // The default channel: everyone who joins later is added to it.
  await c.query("INSERT INTO channels (id, kind, name, topic, created_by, is_default, auto_join) VALUES ($1,'public',$2,$3,$4,true,true)", [id, name, topic, ownerId]);
  await c.query("INSERT INTO channel_members (channel_id, user_id, role) VALUES ($1,$2,'admin')", [id, ownerId]);
  await emit(c, "chat.channel.created.v1", "chat.channel", id, { channelId: id, kind: "public", name, topic, memberIds: [ownerId] });
  return id;
}

/** Creates #general and its welcome message. Safe to re-run. */
async function provisionWorkspace(c: PoolClient, input: { companyName: string; ownerId: string; locale?: Lang; ai?: boolean }): Promise<string> {
  const w = WELCOME[input.locale ?? "vi"];
  const existing = await c.query<{ id: string }>("SELECT id FROM channels WHERE kind = 'public' AND lower(name) = 'general'");
  if (existing.rows[0]) return existing.rows[0].id;
  const general = await insertChannel(c, "general", w.topic, input.ownerId);
  // Members whose "joined" event arrived before this one (topics are not ordered) join #general now.
  await c.query("INSERT INTO known_members (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [input.ownerId]);
  await c.query(`INSERT INTO channel_members (channel_id, user_id) SELECT $1, user_id FROM known_members WHERE user_id <> $2 ON CONFLICT DO NOTHING`, [general, input.ownerId]);
  await postMessage(c, {
    channelId: general,
    threadRootId: null,
    attachments: [],
    author: SYSTEM,
    clientMsgId: "onboarding-welcome",
    body: w.body(input.companyName, input.ai ?? true),
  });
  return general;
}

export async function handleOnboardingEvent(event: EventEnvelope, c: PoolClient): Promise<void> {
  // The workspace's time zone (workspace_settings), for day boundaries in usage statistics.
  await projectWorkspaceTimeZone(event, c);
  const e = asKnown(event);
  if (e?.eventType === "platform.workspace.created.v1") {
    const p = e.payload;
    const locale: Lang = p.locale === "vi" ? "vi" : "en";
    // An event without `ai` keeps the @AI line. Its teamType once picked starter channels; nothing reads it now.
    await provisionWorkspace(c, { companyName: p.name, ownerId: p.ownerUserId, locale, ai: p.ai?.assistant ?? true });
    return;
  }
  // Invited people can be added to channels before they first sign in; disabled people cannot.
  if (e?.eventType === "identity.member.invited.v1" || e?.eventType === "identity.member.enabled.v1") {
    await c.query("INSERT INTO known_members (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [e.payload.userId]);
    return;
  }
  if (e?.eventType === "identity.member.disabled.v1") {
    await c.query("DELETE FROM known_members WHERE user_id = $1", [e.payload.userId]);
    return;
  }
  if (e?.eventType === "identity.member.joined.v1") {
    const p = e.payload;
    if (p.owner) return; // the owner is added when the workspace is provisioned
    await c.query("INSERT INTO known_members (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [p.userId]);
    const defaults = await c.query<{ id: string; last_seq: string }>("SELECT id, last_seq FROM channels WHERE (is_default OR auto_join) AND kind = 'public' AND NOT archived");
    for (const ch of defaults.rows) {
      // New members start "caught up" so day one is not a wall of unread history.
      await c.query("INSERT INTO channel_members (channel_id, user_id, last_read_seq) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [ch.id, p.userId, ch.last_seq]);
    }
  }
}
