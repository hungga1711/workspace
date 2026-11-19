import type { PoolClient } from "pg";
import { asKnown, type EventEnvelope } from "@workspace/contracts";
import { newId, projectWorkspaceTimeZone } from "@workspace/shared";
import { emit, postMessage } from "./domain.js";

export const ONBOARDING_TOPICS = ["workspace.platform.workspace", "workspace.identity.member"];

export type TeamType = "product" | "sales" | "ops";

type Lang = "vi" | "en";

/** Starter channels per team type chosen at signup, in the signup language. */
const TEAM_CHANNELS: Record<Lang, Record<TeamType, { name: string; displayName?: string; topic: string }[]>> = {
  vi: {
    product: [
      { name: "san-pham", displayName: "Sản phẩm", topic: "Lộ trình và yêu cầu sản phẩm" },
      { name: "thiet-ke", displayName: "Thiết kế", topic: "Thiết kế và phản hồi" },
      { name: "phat-hanh", displayName: "Phát hành", topic: "Lịch phát hành và sự cố" },
    ],
    sales: [
      { name: "khach-hang", displayName: "Khách hàng", topic: "Cập nhật từ khách hàng" },
      { name: "co-hoi", displayName: "Cơ hội", topic: "Cơ hội bán hàng đang theo" },
      { name: "bao-gia", displayName: "Báo giá", topic: "Báo giá và hợp đồng" },
    ],
    ops: [
      { name: "van-hanh", displayName: "Vận hành", topic: "Việc vận hành hằng ngày" },
      { name: "nhan-su", displayName: "Nhân sự", topic: "Tuyển dụng và nhân sự" },
      { name: "mua-sam", displayName: "Mua sắm", topic: "Đề xuất mua sắm" },
    ],
  },
  en: {
    product: [
      { name: "product", topic: "Roadmap and product requests" },
      { name: "design", topic: "Design and feedback" },
      { name: "releases", topic: "Release schedule and incidents" },
    ],
    sales: [
      { name: "customers", topic: "Customer updates" },
      { name: "deals", topic: "Open sales opportunities" },
      { name: "quotes", topic: "Quotes and contracts" },
    ],
    ops: [
      { name: "operations", topic: "Day-to-day operations" },
      { name: "people", topic: "Hiring and HR" },
      { name: "purchasing", topic: "Purchase requests" },
    ],
  },
};

/**
 * The welcome thread is ordinary messages authored by "system". Replies are
 * written so the thread summary yields one decision and two tasks; no @mentions,
 * so it does not create "needs you" items on the owner's first Home.
 */
const WELCOME: Record<Lang, { general: string; root: (owner: string, company: string, ai: boolean) => string; replies: string[]; you: string }> = {
  vi: {
    general: "Kênh chung của cả công ty",
    root: (owner, company, ai) =>
      `Chào mừng mọi người tới ${company} trên workspace (${owner} vừa tạo workspace). Đây là #general, kênh chung của cả công ty. ` +
      (ai
        ? `Luồng bên dưới là một cuộc thảo luận mẫu: bấm "Thử: @AI tạo việc từ luồng này" để xem AI biến thảo luận thành việc cần làm.`
        : `Luồng bên dưới là một cuộc thảo luận mẫu: mở luồng và tạo việc từ một tin nhắn để xem thảo luận được biến thành việc cần làm thế nào.`),
    replies: [
      "Chúng ta thống nhất họp giao ban lúc 9h sáng thứ Hai hằng tuần.",
      "Cần mời các trưởng nhóm vào workspace trước 15/10.",
      "Hãy tạo một kênh riêng cho từng dự án đang chạy.",
    ],
    you: "bạn",
  },
  en: {
    general: "The whole company's channel",
    root: (owner, company, ai) =>
      `Welcome, everyone, to ${company} on workspace (${owner} just set it up). This is #general, the channel for the whole company. ` +
      (ai
        ? `The thread below is a sample discussion: click "Try: @AI create tasks from this thread" to see AI turn a discussion into tasks.`
        : `The thread below is a sample discussion: open it and create a task from a message to see how a discussion becomes work.`),
    replies: [
      "We agreed to hold the weekly sync at 9am every Monday.",
      "Team leads need to be invited to the workspace by Oct 15.",
      "Let's create a separate channel for each active project.",
    ],
    you: "there",
  },
};

const SYSTEM = { id: "system", type: "system" as const };

async function insertChannel(c: PoolClient, name: string, topic: string, isDefault: boolean, ownerId: string, displayName: string | null = null): Promise<string> {
  const id = newId();
  // Starter channels: everyone who joins later is added too, so they are not empty rooms for the owner alone.
  await c.query("INSERT INTO channels (id, kind, name, topic, created_by, is_default, auto_join, display_name) VALUES ($1,'public',$2,$3,$4,$5,true,$6)", [
    id,
    name,
    topic,
    ownerId,
    isDefault,
    displayName,
  ]);
  await c.query("INSERT INTO channel_members (channel_id, user_id, role) VALUES ($1,$2,'admin')", [id, ownerId]);
  await emit(c, "chat.channel.created.v1", "chat.channel", id, { channelId: id, kind: "public", name, topic, memberIds: [ownerId] });
  return id;
}

/** Creates #general (+ welcome thread) and the team's starter channels. Safe to re-run. */
async function provisionWorkspace(
  c: PoolClient,
  input: { companyName: string; ownerId: string; ownerName: string; teamType: TeamType; locale?: Lang; ai?: boolean },
): Promise<string> {
  const w = WELCOME[input.locale ?? "vi"];
  const existing = await c.query<{ id: string }>("SELECT id FROM channels WHERE kind = 'public' AND lower(name) = 'general'");
  if (existing.rows[0]) return existing.rows[0].id;
  const general = await insertChannel(c, "general", w.general, true, input.ownerId);
  for (const ch of TEAM_CHANNELS[input.locale ?? "vi"][input.teamType]) await insertChannel(c, ch.name, ch.topic, false, input.ownerId, ch.displayName ?? null);
  // Members whose "joined" event arrived before this one (topics are not ordered) join #general now.
  await c.query("INSERT INTO known_members (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [input.ownerId]);
  await c.query(`INSERT INTO channel_members (channel_id, user_id) SELECT $1, user_id FROM known_members WHERE user_id <> $2 ON CONFLICT DO NOTHING`, [general, input.ownerId]);
  const root = await postMessage(c, {
    channelId: general,
    threadRootId: null,
    attachments: [],
    author: SYSTEM,
    clientMsgId: "onboarding-welcome",
    body: w.root(input.ownerName, input.companyName, input.ai ?? true),
  });
  for (const [i, body] of w.replies.entries()) {
    await postMessage(c, { channelId: general, threadRootId: root.message.id, attachments: [], author: SYSTEM, clientMsgId: `onboarding-welcome-${i}`, body });
  }
  return general;
}

export async function handleOnboardingEvent(event: EventEnvelope, c: PoolClient): Promise<void> {
  // The workspace's time zone (workspace_settings), for day boundaries in usage statistics.
  await projectWorkspaceTimeZone(event, c);
  const e = asKnown(event);
  if (e?.eventType === "platform.workspace.created.v1") {
    const p = e.payload;
    const locale: Lang = p.locale === "vi" ? "vi" : "en";
    const teamType: TeamType = p.teamType in TEAM_CHANNELS[locale] ? (p.teamType as TeamType) : "product";
    // An event without `ai` keeps the @AI hint.
    await provisionWorkspace(c, { companyName: p.name, ownerId: p.ownerUserId, ownerName: p.ownerName || WELCOME[locale].you, teamType, locale, ai: p.ai?.assistant ?? true });
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
