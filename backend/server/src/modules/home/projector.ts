import type { PoolClient } from "pg";
import type { EventEnvelope } from "@workspace/contracts";
import { newId, projectWorkspaceTimeZone } from "@workspace/shared";
import { logger } from "@workspace/service-kit";
import { MUTE_GROUPS } from "./digest.js";
import { isMsg, msg, renderMsg, textsFor, type Msg, type Texts } from "./texts.js";
import { groupKeyOf } from "./notifications.js";

/**
 * Builds the Home read model from domain events:
 *
 *   work.task.*            → "task" items for the assignee (open until done/cancelled)
 *   work.approval.*        → "approval" items for the approver; result notice to requester
 *   chat.message.created   → "mention" items + notices; "dm" unanswered items for recipients
 *   work.meeting.scheduled → "meeting" items for attendees
 *   work.decision.proposed → "decision" items for the named decider
 *   task blockedReason     → "blocker" items for the task owner
 *   activity rows          → "AI did while you were away" (extracted/AI tasks, decisions,
 *                            document changes, agent results)
 *
 * Out-of-order safety: task items carry source_version; an event with a
 * lower version than stored is ignored, so a late "created" never reopens a done task.
 */
type P = Record<string, any>;
/**
 * Text written for one person: fixed (user content), a stored message (rendered again in whoever reads it's language:
 * notifications keep it), or built once in that person's language.
 */
type Txt = string | Msg | ((t: Texts) => string);
/** What a queued push is about, when it is a waiting agent run (push_outbox.ref). */
export type PushRef = { runId: string; waitId?: string; questionId?: string };
const say = async (c: PoolClient, userId: string, v: Txt | undefined): Promise<string | undefined> => {
  if (typeof v === "function") return v(await textsFor(c, userId));
  if (isMsg(v)) return renderMsg(await textsFor(c, userId), v) ?? "";
  return v;
};

async function upsertItem(
  c: PoolClient,
  userId: string,
  item: {
    kind: string;
    refId: string;
    title: Txt;
    subtitle?: Txt;
    url: string;
    dueAt?: string | null;
    startsAt?: string | null;
    needsAction: boolean;
    priority?: string | null;
    version?: number;
    resolved?: boolean;
  },
) {
  await c.query(
    `INSERT INTO home_items (user_id, kind, ref_id, title, subtitle, url, due_at, starts_at, needs_action, priority, source_version, resolved_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, CASE WHEN $12 THEN now() END)
     ON CONFLICT (user_id, kind, ref_id) DO UPDATE SET
       title = EXCLUDED.title, subtitle = EXCLUDED.subtitle, url = EXCLUDED.url, due_at = EXCLUDED.due_at, starts_at = EXCLUDED.starts_at,
       needs_action = EXCLUDED.needs_action, priority = EXCLUDED.priority, source_version = EXCLUDED.source_version,
       resolved_at = EXCLUDED.resolved_at, updated_at = now()
     WHERE home_items.source_version <= EXCLUDED.source_version`,
    [
      userId,
      item.kind,
      item.refId,
      await say(c, userId, item.title),
      (await say(c, userId, item.subtitle)) ?? "",
      item.url,
      item.dueAt ?? null,
      item.startsAt ?? null,
      item.needsAction,
      item.priority ?? null,
      item.version ?? 0,
      item.resolved ?? false,
    ],
  );
}

/**
 * Whether this person already has the notice for this wait or question. A waiting run tells each person once, and the
 * notice may carry buttons that act on the run, so a second delivery of the event must not make a second one.
 */
const told = async (c: PoolClient, userId: string, kind: string, refId: unknown) =>
  !!refId && !!(await c.query("SELECT 1 FROM notifications WHERE user_id = $1 AND kind = $2 AND ref_id = $3 LIMIT 1", [userId, kind, String(refId)])).rowCount;

async function notify(
  c: PoolClient,
  e: EventEnvelope,
  userId: string,
  n: {
    grp: "action" | "update";
    kind: string;
    title: string | Msg;
    body?: string | Msg;
    url: string;
    refId?: string;
    params?: Record<string, unknown>;
    /** A waiting agent run this is about: the push may carry buttons to act on it (push.ts, for people who allow it). */
    run?: PushRef;
  },
) {
  // Muted categories never reach the inbox (Needs You on Home still shows what needs action).
  const muted = (await c.query<{ muted: string[] }>("SELECT muted FROM user_prefs WHERE user_id = $1", [userId])).rows[0]?.muted ?? [];
  if (muted.some((g) => (MUTE_GROUPS[g] ?? []).includes(n.kind))) return;
  // title/body hold the text in the recipient's current language (push, chat, and the fallback); the *_msg columns
  // let the inbox write it again in whatever language the reader uses when they open it.
  const actor = e.actorId.startsWith("user:") ? actorUser(e) : null;
  await c.query(
    `INSERT INTO notifications (user_id, id, grp, kind, title, body, url, ref_id, title_msg, body_msg, actor_id, group_key, params)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      userId,
      newId(),
      n.grp,
      n.kind,
      (await say(c, userId, n.title)) ?? "",
      (await say(c, userId, n.body)) ?? "",
      n.url,
      n.refId ?? null,
      isMsg(n.title) ? JSON.stringify(n.title) : null,
      isMsg(n.body) ? JSON.stringify(n.body) : null,
      actor,
      groupKeyOf(n.kind, n.refId ?? null, n.url),
      JSON.stringify(n.params ?? {}),
    ],
  );
  // Things that need the person also go out as an instant push (sent by the push job, quiet hours applied there).
  // Lock screens show only the kind of item, never its content.
  if (n.grp === "action") await queuePush(c, userId, (t) => t.push[n.kind] ?? t.pushDefault, n.url, n.run);
}

/**
 * The thing a "needs action" notification asked for is settled (decided, cancelled, handed to someone else): it
 * leaves the Needs action tab and becomes a read update, so the tab only lists what still waits for the person.
 */
async function settleActionNotes(c: PoolClient, refId: string, exceptUserId?: string) {
  await c.query(
    `UPDATE notifications SET grp = 'update', read_at = coalesce(read_at, now())
      WHERE grp = 'action' AND ref_id = $1 AND ($2::text IS NULL OR user_id <> $2)`,
    [refId, exceptUserId ?? null],
  );
}

/**
 * The task or page a notice points at was deleted: what still waits leaves Needs action, and every notice about it
 * stays readable but says so instead of linking to a page that no longer opens.
 */
async function tombstone(c: PoolClient, url: string) {
  await c.query(
    `UPDATE notifications SET gone_at = now(), grp = 'update', read_at = CASE WHEN grp = 'action' THEN coalesce(read_at, now()) ELSE read_at END
      WHERE (url = $1 OR url LIKE $1 || '?%' OR url LIKE $1 || '#%') AND gone_at IS NULL`,
    [url],
  );
  await c.query("DELETE FROM push_outbox WHERE url = $1", [url]);
}

/**
 * Queues an instant push if the person can get one: push on with a device. Do not disturb holds it; the push job
 * applies quiet hours.
 */
async function queuePush(c: PoolClient, userId: string, title: Txt, url: string, ref?: PushRef) {
  await c.query(
    `INSERT INTO push_outbox (id, user_id, title, url, ref)
     SELECT $1, $2, $3, $4, $5 FROM user_prefs u WHERE u.user_id = $2 AND (u.dnd_until IS NULL OR u.dnd_until < now())
       AND u.push_enabled AND EXISTS (SELECT 1 FROM push_subscriptions WHERE user_id = $2)`,
    [newId(), userId, await say(c, userId, title), url, ref ? JSON.stringify(ref) : null],
  );
}

/** One line in the "while you were away" feed; the same key bumps the existing line instead of adding another. */
async function record(c: PoolClient, e: EventEnvelope, userId: string, a: { key: string; kind: string; title: Txt; body?: string; url: string }) {
  await c.query(
    `INSERT INTO activity (user_id, key, kind, title, body, url, actor_id) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (user_id, key) DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body, actor_id = EXCLUDED.actor_id,
       count = activity.count + 1, created_at = now()`,
    [userId, a.key, a.kind, (await say(c, userId, a.title))!.slice(0, 300), (a.body ?? "").slice(0, 500), a.url, e.actorId],
  );
}

const actorUser = (e: EventEnvelope) => e.actorId.replace(/^(user|agent|service):/, "");

/** The workspace's language next to its time zone (workspace_settings.locale), from the same two platform events. */
async function projectWorkspaceLocale(e: EventEnvelope, c: PoolClient): Promise<void> {
  const raw = e.eventType === "platform.workspace.created.v1" ? (e.payload as { locale?: unknown }).locale : (e.payload as { config?: { locale?: unknown } }).config?.locale;
  if (raw !== "vi" && raw !== "en") return;
  // The time-zone projection inserts the row on creation (ON CONFLICT DO NOTHING), so this only ever updates it.
  await c.query("UPDATE workspace_settings SET locale = $1 WHERE locale <> $1", [raw]);
}

export async function project(e: EventEnvelope, c: PoolClient): Promise<void> {
  const p = e.payload as P;
  const lagMs = Date.now() - Date.parse(e.occurredAt);
  logger.debug({ eventType: e.eventType, lagMs }, "home projection");
  switch (e.eventType) {
    case "platform.workspace.created.v1":
    case "platform.workspace.config_changed.v1":
      await projectWorkspaceTimeZone(e, c);
      await projectWorkspaceLocale(e, c);
      break;
    case "work.task.created.v1":
    case "work.task.updated.v1":
    case "work.task.completed.v1": {
      const open = !["done", "cancelled"].includes(p.status);
      // The task leaves any previous assignee's Home.
      await c.query(
        "UPDATE home_items SET resolved_at = now(), source_version = $3 WHERE kind = 'task' AND ref_id = $1 AND user_id <> $2 AND resolved_at IS NULL AND source_version < $3",
        [p.taskId, p.assigneeId ?? "", p.version ?? 0],
      );
      if (p.assigneeId) {
        await upsertItem(c, p.assigneeId, {
          kind: "task",
          refId: p.taskId,
          title: p.title,
          subtitle: p.code,
          url: `/app/work/tasks/${p.taskId}`,
          dueAt: p.dueAt,
          needsAction: open,
          priority: p.priority,
          version: p.version ?? 0,
          resolved: !open,
        });
        if (e.eventType === "work.task.created.v1" && p.assigneeId !== actorUser(e)) {
          await notify(c, e, p.assigneeId, {
            grp: "action",
            kind: "task.assigned",
            title: msg("taskAssigned", p.title),
            url: `/app/work/tasks/${p.taskId}`,
            refId: p.taskId,
            params: { code: p.code },
          });
        }
      }
      // Tasks created by an agent or pulled out of a conversation show up in "while you were away".
      if (e.eventType === "work.task.created.v1") {
        const byAgent = e.actorId.startsWith("agent:");
        const fromChat = p.source?.type === "chat.message";
        for (const userId of new Set([p.assigneeId, p.ownerId].filter((x): x is string => !!x && x !== actorUser(e)))) {
          if (byAgent || fromChat) {
            await record(c, e, userId, {
              key: `task:${p.taskId}`,
              kind: byAgent ? "ai_task" : "extracted_task",
              url: `/app/work/tasks/${p.taskId}`,
              title: (t) => (byAgent ? t.taskByAi(p.title) : t.taskFromChat(p.title)),
              body: p.code,
            });
          }
        }
      }
      if (e.eventType === "work.task.completed.v1" && p.ownerId && p.ownerId !== actorUser(e)) {
        await record(c, e, p.ownerId, { key: `done:${p.taskId}`, kind: "task_done", title: (t) => t.done(p.title), body: p.code, url: `/app/work/tasks/${p.taskId}` });
      }
      // Blockers: the owner (who can usually unblock) sees it in Needs You until it clears.
      if (p.ownerId && p.ownerId !== p.assigneeId) {
        const blocked = !!p.blockedReason && open;
        await upsertItem(c, p.ownerId, {
          kind: "blocker",
          refId: p.taskId,
          title: (t) => t.blocked(p.title),
          subtitle: p.blockedReason ?? "",
          url: `/app/work/tasks/${p.taskId}`,
          needsAction: blocked,
          version: p.version ?? 0,
          resolved: !blocked,
        });
      }
      if (e.eventType === "work.task.completed.v1" && p.ownerId && p.ownerId !== actorUser(e)) {
        await notify(c, e, p.ownerId, { grp: "update", kind: "task.completed", title: msg("done", p.title), url: `/app/work/tasks/${p.taskId}`, refId: p.taskId });
      }
      // People following the task hear it is done too (not the owner, told above, nor whoever finished it).
      if (e.eventType === "work.task.completed.v1") {
        for (const userId of new Set((p.watchers as string[] | undefined) ?? [])) {
          if (userId === p.ownerId || userId === actorUser(e)) continue;
          await notify(c, e, userId, { grp: "update", kind: "task.completed", title: msg("done", p.title), url: `/app/work/tasks/${p.taskId}`, refId: p.taskId });
        }
      }
      return;
    }
    case "work.task.deleted.v1":
      await c.query("UPDATE home_items SET resolved_at = now() WHERE kind IN ('task', 'blocker') AND ref_id = $1", [p.taskId]);
      await tombstone(c, `/app/work/tasks/${p.taskId}`);
      return;
    case "work.document.deleted.v1":
      await tombstone(c, `/app/work/docs/${p.documentId}`);
      return;
    case "work.run.asked.v1":
      // A task's agent stopped to ask (work/agent-ask.ts): whoever started it and the assignee are asked to answer.
      for (const userId of new Set<string>((p.recipientIds as string[] | undefined) ?? [])) {
        if (await told(c, userId, "task.agent_ask", p.questionId)) continue;
        await notify(c, e, userId, {
          grp: "action",
          kind: "task.agent_ask",
          title: msg("agentAsked", p.code, Number(p.count) || 1),
          body: String(p.title ?? ""),
          url: `/app/chat/ask/${p.runId}`,
          refId: p.questionId,
          run: { runId: p.runId, questionId: p.questionId },
        });
      }
      return;
    case "work.run.answered.v1":
      // Answered by anyone, left to the AI or cancelled: the question no longer waits for anybody.
      await settleActionNotes(c, p.questionId);
      await c.query("DELETE FROM push_outbox WHERE ref->>'questionId' = $1", [p.questionId]);
      return;
    case "work.run.waiting.v1":
      // A run reached an approval step: the people who can give it are told, once for this wait.
      if (!p.waitId) return;
      for (const userId of new Set<string>((p.recipientIds as string[] | undefined) ?? [])) {
        if (await told(c, userId, "task.agent_approval", p.waitId)) continue;
        await notify(c, e, userId, {
          grp: "action",
          kind: "task.agent_approval",
          title: msg("agentApproval", p.code, String(p.step ?? "")),
          body: String(p.title ?? ""),
          url: `/app/chat/ask/${p.runId}`,
          refId: p.waitId,
          run: { runId: p.runId, waitId: p.waitId },
        });
      }
      return;
    case "work.run.decided.v1":
      // Approved, sent back or stopped, by anyone: it no longer waits for the others, and a push not sent yet is dropped.
      await settleActionNotes(c, p.waitId);
      await c.query("DELETE FROM push_outbox WHERE ref->>'waitId' = $1", [p.waitId]);
      return;
    case "work.task.commented.v1": {
      // Owner and assignee hear about new comments; people @mentioned get an action item (title withheld:
      // they may not be able to open the task, and the link says so).
      const url = `/app/work/tasks/${p.taskId}`;
      const mentioned = new Set<string>((p.mentions as string[] | undefined) ?? []);
      // Watchers (task_watchers) hear about comments like the owner and assignee.
      for (const userId of [...new Set([p.ownerId, p.assigneeId, ...((p.watchers as string[] | undefined) ?? [])].filter(Boolean) as string[])]) {
        if (userId === p.authorId || mentioned.has(userId)) continue;
        await notify(c, e, userId, { grp: "update", kind: "task.commented", title: msg("commented", p.code, p.title), url, refId: p.taskId, params: { code: p.code } });
      }
      for (const userId of mentioned) {
        await notify(c, e, userId, { grp: "action", kind: "task.mention", title: msg("taskMention", p.code), url, refId: p.commentId, params: { code: p.code } });
      }
      return;
    }
    case "work.task.comment_edited.v1": {
      // Only people the edit mentions for the first time; nobody else hears about an edit.
      const url = `/app/work/tasks/${p.taskId}`;
      for (const userId of new Set<string>((p.mentions as string[] | undefined) ?? [])) {
        await notify(c, e, userId, { grp: "action", kind: "task.mention", title: msg("taskMention", p.code), url, refId: p.commentId, params: { code: p.code } });
      }
      return;
    }
    case "work.task.comment_deleted.v1":
      // A deleted comment's mentions point at nothing: they leave the inbox.
      await c.query("DELETE FROM notifications WHERE kind = 'task.mention' AND ref_id = $1", [p.commentId]);
      return;
    case "work.approval.requested.v1":
      // Handed over (handover or out-of-office delegation): the previous approver's item goes away.
      await c.query("UPDATE home_items SET resolved_at = now() WHERE kind = 'approval' AND ref_id = $1 AND user_id <> $2 AND resolved_at IS NULL", [p.approvalId, p.approverId]);
      await settleActionNotes(c, p.approvalId, p.approverId);
      await upsertItem(c, p.approverId, {
        kind: "approval",
        refId: p.approvalId,
        title: p.title,
        subtitle: (t) => (p.onBehalfOf ? t.approvalOnBehalf : t.approvalWaiting),
        url: `/app/work/approvals/${p.approvalId}`,
        needsAction: true,
      });
      await notify(c, e, p.approverId, {
        grp: "action",
        kind: "approval.requested",
        title: msg("approvalNeeded", p.title),
        url: `/app/work/approvals/${p.approvalId}`,
        refId: p.approvalId,
      });
      return;
    case "work.approval.decided.v1":
      await c.query("UPDATE home_items SET resolved_at = now(), needs_action = false WHERE kind = 'approval' AND ref_id = $1", [p.approvalId]);
      await settleActionNotes(c, p.approvalId);
      if (p.decision === "cancelled") return; // the requester withdrew it themselves
      await notify(c, e, p.requesterId, {
        grp: "update",
        kind: "approval.decided",
        title: msg("approvalDecided", p.decision === "approved", p.title),
        url: `/app/work/approvals/${p.approvalId}`,
        refId: p.approvalId,
      });
      return;
    case "work.approval.commented.v1":
      // A question from the approver or an answer from the requester: the other side hears about it.
      await notify(c, e, p.recipientId, {
        grp: "action",
        kind: "approval.commented",
        title: msg("approvalCommented", p.title),
        body: String(p.body ?? ""),
        url: `/app/work/approvals/${p.approvalId}`,
        refId: p.approvalId,
      });
      return;
    case "chat.status.set.v1":
      // Do not disturb from the chat status: no pushes until it ends (the inbox still fills).
      await c.query(
        `INSERT INTO user_prefs (user_id, dnd_until) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET dnd_until = EXCLUDED.dnd_until`,
        [p.userId, p.dndUntil ?? null],
      );
      return;
    case "chat.message.created.v1": {
      const url = `/app/chat/${p.channelId}?m=${p.messageId}`;
      // People who muted this conversation (for a while, for good, or chose "nothing") get no push.
      const quiet = new Set((p.quiet as string[] | undefined) ?? []);
      for (const userId of (p.mentions as string[]).filter((m) => m !== p.authorId && !m.startsWith("agent:"))) {
        await upsertItem(c, userId, {
          kind: "mention",
          refId: p.messageId,
          title: String(p.body).slice(0, 140),
          subtitle: p.channelName ? `#${p.channelName}` : (t) => t.message,
          url,
          needsAction: true,
        });
        if (!quiet.has(userId))
          await notify(c, e, userId, {
            grp: "action",
            kind: "mention",
            title: msg("mentioned"),
            body: String(p.body).slice(0, 200),
            url,
            refId: p.messageId,
            params: { channel: p.channelName ?? null },
          });
      }
      // "Every message" in a channel: one content-free push per channel per 10 minutes.
      for (const userId of ((p.everyMessage as string[] | undefined) ?? []).filter((u) => !(p.mentions as string[]).includes(u))) {
        const fresh = await c.query(
          `INSERT INTO push_recent (user_id, key, at) VALUES ($1,$2, now())
           ON CONFLICT (user_id, key) DO UPDATE SET at = now() WHERE push_recent.at < now() - interval '10 minutes' RETURNING 1`,
          [userId, `ch:${p.channelId}`],
        );
        if (fresh.rowCount) await queuePush(c, userId, (t) => t.pushChannel(String(p.channelName ?? "")), `/app/chat/${p.channelId}`);
      }
      // Unanswered DMs: open for each recipient; the recipient replying resolves theirs.
      for (const userId of p.recipients as string[]) {
        await upsertItem(c, userId, { kind: "dm", refId: p.channelId, title: String(p.body).slice(0, 140), subtitle: (t) => t.dmWaiting, url, needsAction: true });
        // One content-free push per conversation per 10 minutes, unless the person muted direct messages.
        const muted = (await c.query<{ muted: string[] }>("SELECT muted FROM user_prefs WHERE user_id = $1", [userId])).rows[0]?.muted ?? [];
        if (muted.includes("dm") || quiet.has(userId)) continue;
        const fresh = await c.query(
          `INSERT INTO push_recent (user_id, key, at) VALUES ($1,$2, now())
           ON CONFLICT (user_id, key) DO UPDATE SET at = now() WHERE push_recent.at < now() - interval '10 minutes' RETURNING 1`,
          [userId, `dm:${p.channelId}`],
        );
        if (fresh.rowCount) await queuePush(c, userId, (t) => t.pushDm, `/app/chat/${p.channelId}`);
      }
      if (p.channelKind === "dm" || p.channelKind === "group") {
        await c.query("UPDATE home_items SET resolved_at = now(), needs_action = false WHERE kind = 'dm' AND ref_id = $1 AND user_id = $2", [p.channelId, p.authorId]);
      }
      return;
    }
    case "work.meeting.scheduled.v1":
      // A reschedule re-sends the full attendee list: people taken off the invite lose the item.
      await c.query("UPDATE home_items SET resolved_at = now() WHERE kind = 'meeting' AND ref_id = $1 AND NOT (user_id = ANY($2)) AND resolved_at IS NULL", [
        p.eventId,
        p.attendeeIds,
      ]);
      for (const userId of p.attendeeIds as string[]) {
        await upsertItem(c, userId, {
          kind: "meeting",
          refId: p.eventId,
          title: p.title,
          subtitle: p.location ?? "",
          url: `/app/work/meetings/${p.eventId}`,
          startsAt: p.startsAt,
          needsAction: false,
        });
        // A recurring series is announced once, by its first meeting; the rest only land in Today and the calendar.
        const laterInSeries = typeof p.seriesIndex === "number" && p.seriesIndex > 0 && !p.rescheduled;
        if (userId !== p.organizerId && !laterInSeries)
          await notify(c, e, userId, {
            grp: "update",
            kind: p.rescheduled ? "meeting.updated" : "meeting.invited",
            title: msg("meeting", Boolean(p.rescheduled), p.seriesId ? String(p.recurrence ?? "") : null, p.title),
            url: `/app/work/meetings/${p.eventId}`,
            refId: p.eventId,
          });
      }
      return;
    case "employee.leave.requested.v1":
      await upsertItem(c, p.approverId, {
        kind: "approval",
        refId: p.requestId,
        title: (t) => t.leaveItem(p.displayName, p.days),
        subtitle: (t) => t.leaveRange(p.startDate, p.endDate),
        url: `/app/me?tab=team`,
        needsAction: true,
      });
      await notify(c, e, p.approverId, {
        grp: "action",
        kind: "leave.requested",
        title: msg("leaveRequested", p.displayName, p.days),
        url: `/app/me?tab=team`,
        refId: p.requestId,
      });
      return;
    case "employee.leave.reminded.v1":
      await notify(c, e, p.approverId, {
        grp: "action",
        kind: "leave.requested",
        title: msg("leaveReminder", p.displayName, p.days),
        url: `/app/me?tab=team`,
        refId: p.requestId,
      });
      return;
    case "employee.leave.decided.v1":
      await c.query("UPDATE home_items SET resolved_at = now(), needs_action = false WHERE kind = 'approval' AND ref_id = $1", [p.requestId]);
      await settleActionNotes(c, p.requestId);
      if (p.decision !== "cancelled")
        await notify(c, e, p.userId, {
          grp: "update",
          kind: "leave.decided",
          title: msg("leaveDecided", p.decision === "approved"),
          url: "/app/me?tab=leave",
          refId: p.requestId,
        });
      return;
    case "ai.activity.flagged.v1":
      // Sensitive data went into an AI: the workspace's AI admins, once per conversation and kind.
      for (const userId of p.recipients as string[]) {
        await notify(c, e, userId, {
          grp: "action",
          kind: "ai.flagged",
          title: msg("aiFlagged", p.kinds as string[], p.source as string),
          body: msg("aiFlaggedBody"),
          url: "/app/ai/adoption/usage",
          refId: p.conversationId,
        });
      }
      return;
    case "ai.extension.reminded.v1":
      for (const userId of p.recipients as string[])
        await notify(c, e, userId, { grp: "action", kind: "ai.extension", title: msg("aiExtension"), body: msg("aiExtensionBody"), url: "/app/ai/connect" });
      return;
    case "employee.announcement.published.v1":
      // Every targeted employee, once (refId dedups a replayed event); read on Thông báo công ty.
      for (const userId of (p.recipients as string[] | undefined) ?? [])
        await notify(c, e, userId, {
          grp: "update",
          kind: "announcement",
          title: msg("announcement", p.title),
          url: `/app/announcements?open=${encodeURIComponent(p.announcementId as string)}`,
          refId: p.announcementId as string,
        });
      return;
    case "employee.announcement.deleted.v1":
      await c.query("DELETE FROM notifications WHERE kind = 'announcement' AND ref_id = $1", [p.announcementId]);
      return;
    case "ai.policy.changed.v1":
      for (const userId of p.recipients as string[])
        await notify(c, e, userId, {
          grp: "update",
          kind: "ai.policy",
          title: msg("aiPolicy"),
          body: msg("aiPolicyBody", p.detail, !!p.captureResponses, p.retentionDays),
          url: "/app/me?tab=ai",
        });
      return;
    case "ai.quota.threshold_reached.v1":
      // Owner + AI policy admins, once per threshold per period (dedup is upstream).
      for (const userId of p.recipients as string[]) {
        await notify(c, e, userId, {
          grp: "action",
          kind: "ai.quota",
          url: "/admin/workspace",
          title: msg("quota", p.threshold),
          body: msg("quotaBody"),
        });
      }
      return;
    case "work.decision.proposed.v1":
      await upsertItem(c, p.deciderId, {
        kind: "decision",
        refId: p.decisionId,
        title: p.title,
        subtitle: (t) => t.decisionWaiting,
        url: "/app/work/tasks",
        needsAction: true,
      });
      await notify(c, e, p.deciderId, {
        grp: "action",
        kind: "decision.proposed",
        title: msg("decisionNeeded", p.title),
        url: "/app/work/tasks",
        refId: p.decisionId,
      });
      return;
    case "work.decision.withdrawn.v1":
      await c.query("UPDATE home_items SET resolved_at = now(), needs_action = false WHERE kind = 'decision' AND ref_id = $1", [p.decisionId]);
      return;
    case "work.decision.created.v1": {
      await c.query("UPDATE home_items SET resolved_at = now(), needs_action = false WHERE kind = 'decision' AND ref_id = $1", [p.decisionId]);
      // Decisions are workspace-visible (the decision log has no per-user ACL), so everyone's feed gets them.
      const url = p.source?.channelId ? `/app/chat/${p.source.channelId}?m=${p.source.messageId}` : "/app/work/tasks";
      // Workspace-wide line: stored as the bare title; Home adds "Decided:" in each reader's language.
      await record(c, e, "*", { key: `decision:${p.decisionId}`, kind: "decision", title: p.title, url });
      if (p.proposedBy && p.proposedBy !== p.decidedBy)
        await notify(c, e, p.proposedBy, { grp: "update", kind: "decision.decided", title: msg("decided", p.title), url, refId: p.decisionId });
      return;
    }
    case "work.document.updated.v1":
    case "work.document.created.v1":
      for (const userId of new Set((p.sharedWith as string[] | undefined) ?? [])) {
        if (userId === actorUser(e)) continue;
        await record(c, e, userId, {
          key: `doc:${p.documentId}`,
          kind: "doc_change",
          url: `/app/work/docs/${p.documentId}`,
          title: (t) => (e.eventType === "work.document.created.v1" ? t.docCreated(p.title) : t.docUpdated(p.title)),
          body: p.code ?? "",
        });
      }
      // Watchers of the page (Theo dõi trang) get a notice, at most one unread per page per 30 minutes,
      // so an hour of autosaves is one line, not fifty.
      for (const userId of new Set((p.watchers as string[] | undefined) ?? [])) {
        const recent = await c.query(
          "SELECT 1 FROM notifications WHERE user_id = $1 AND kind = 'doc.updated' AND ref_id = $2 AND read_at IS NULL AND created_at > now() - interval '30 minutes'",
          [userId, p.documentId],
        );
        if (recent.rowCount) continue;
        await notify(c, e, userId, { grp: "update", kind: "doc.updated", title: msg("docUpdated", p.title), url: `/app/work/docs/${p.documentId}`, refId: p.documentId });
      }
      return;
    case "work.document.commented.v1": {
      // The page's owner, its last editor and anyone @mentioned (the work module resolves `notify`, the author left out).
      // One unread line per page and person for a burst of comments.
      const url = `/app/work/docs/${p.documentId}`;
      for (const userId of new Set((p.notify as string[] | undefined) ?? [])) {
        if (userId === p.authorId) continue;
        const recent = await c.query(
          "SELECT 1 FROM notifications WHERE user_id = $1 AND kind = 'doc.commented' AND ref_id = $2 AND read_at IS NULL AND created_at > now() - interval '10 minutes'",
          [userId, p.documentId],
        );
        if (recent.rowCount) continue;
        await notify(c, e, userId, { grp: "update", kind: "doc.commented", title: msg("docCommented", p.title), url, refId: p.documentId, params: { title: p.title } });
      }
      return;
    }
    case "ai.agent.run.completed.v1":
      await record(c, e, p.askerId, {
        key: `agent:${e.eventId}`,
        kind: "agent_result",
        title: (t) => t.agentAnswered(p.agentName, p.prompt),
        body: p.answer,
        url: p.messageId ? `/app/chat/${p.channelId}?m=${p.messageId}` : `/app/chat/${p.channelId}`,
      });
      return;
    case "identity.member.joined.v1":
      // Email for the daily digest (the only personal data Home keeps besides the read model).
      if (p.email) {
        // The language stays empty here: texts follow the workspace's until the person picks one in the app.
        await c.query(`INSERT INTO user_prefs (user_id, email) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email`, [p.userId, p.email]);
      }
      return;
    case "work.event.cancelled.v1":
      await c.query("UPDATE home_items SET resolved_at = now() WHERE kind = 'meeting' AND ref_id = $1", [p.eventId]);
      return;
    default:
      return;
  }
}

export const HOME_TOPICS = [
  "workspace.work.task",
  // Agent runs: their questions (notices to the starter and assignee).
  "workspace.work.run",
  "workspace.work.approval",
  "workspace.chat.message",
  "workspace.work.calendar",
  "workspace.ai.quota",
  "workspace.employee.leave",
  "workspace.work.decision",
  "workspace.work.document",
  "workspace.ai.agent",
  "workspace.identity.member",
  "workspace.ai.activity",
  "workspace.chat.user",
  // The workspace's time zone (workspace_settings), for people who did not pick their own.
  "workspace.platform.workspace",
  // Company announcements: a notification for everyone they target.
  "workspace.employee.announcement",
];
