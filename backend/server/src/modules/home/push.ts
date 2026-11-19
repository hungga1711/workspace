import type { Pool, PoolClient } from "pg";
import webpush from "web-push";
import { newId, runWithContext, withTransaction, currentRequestId } from "@workspace/shared";
import { logger } from "@workspace/service-kit";
import { textsFor } from "./texts.js";

export interface PushSender {
  send(sub: { endpoint: string; p256dh: string; auth: string }, payload: string): Promise<{ statusCode: number }>;
}

export function webPushSender(vapid: { subject: string; publicKey: string; privateKey: string }): PushSender {
  webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  return {
    async send(sub, payload) {
      try {
        const r = await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, { TTL: 4 * 3600 });
        return { statusCode: r.statusCode };
      } catch (e) {
        const statusCode = (e as { statusCode?: number }).statusCode;
        if (statusCode) return { statusCode };
        // web-push rejects malformed keys before sending; such a subscription can never work, so treat it as gone.
        if (/p256dh|auth secret|bytes long/i.test((e as Error).message)) return { statusCode: 410 };
        throw e;
      }
    },
  };
}

type Sub = { endpoint: string; p256dh: string; auth: string };

/**
 * The buttons a push about a waiting agent run may carry for one person (work/quick-actions.ts): asked of the work
 * module as the push is sent, only for people who turned quick actions on. Each button holds a single-use token for
 * that person and that wait; it is in this payload (encrypted to the device) and nowhere else.
 */
export type QuickLoader = (
  userId: string,
  ref: { runId: string; waitId?: string; questionId?: string },
) => Promise<{
  detail: string;
  actions: { action: "approve" | "answer"; label?: string; token: string }[];
}>;

/** Sends to every device of one user; dead subscriptions (404/410) are deleted. Runs inside the caller's transaction. */
async function sendToDevices(c: PoolClient, sender: PushSender, userId: string, payload: string): Promise<{ sent: number; removed: number }> {
  let sent = 0;
  let removed = 0;
  const subs = (await c.query<Sub>("SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1", [userId])).rows;
  for (const s of subs) {
    const r = await sender.send(s, payload).catch((err) => {
      logger.warn({ err }, "push send failed");
      return { statusCode: 0 };
    });
    if (r.statusCode === 404 || r.statusCode === 410) {
      await c.query("DELETE FROM push_subscriptions WHERE endpoint = $1", [s.endpoint]);
      logger.info({ userId }, "removed dead push subscription");
      removed++;
    } else if (r.statusCode >= 200 && r.statusCode < 300) sent++;
  }
  return { sent, removed };
}

/**
 * Instant pushes for things that need the person (mention, approval, assignment), queued by the
 * projector. Claiming deletes the rows, so each notice is pushed at most once; quiet hours, stale rows
 * (over 30 minutes) and people with push off are filtered out by claim_instant_pushes.
 */
export async function sendInstantPushes(pool: Pool, sender: PushSender, limit = 500, quick?: QuickLoader): Promise<{ sent: number; removed: number }> {
  const rows = (
    await pool.query<{
      user_id: string;
      title: string;
      url: string;
      push_enabled: boolean;
      ref: { runId?: string; waitId?: string; questionId?: string } | null;
      quick_actions: boolean;
    }>("SELECT * FROM claim_instant_pushes($1)", [limit])
  ).rows;
  let sent = 0;
  let removed = 0;
  for (const r of rows) {
    await runWithContext({ actorId: "service:push", requestId: currentRequestId() ?? newId() }, () =>
      withTransaction(pool, async (c) => {
        const t = await textsFor(c, r.user_id);
        // Buttons only for someone who asked for them, and only while the wait is still theirs to act on. No answer
        // from the work module: the plain push goes out, and opening the app does the rest.
        const q =
          quick && r.quick_actions && r.ref?.runId
            ? await quick(r.user_id, {
                runId: r.ref.runId,
                ...(r.ref.waitId ? { waitId: r.ref.waitId } : {}),
                ...(r.ref.questionId ? { questionId: r.ref.questionId } : {}),
              }).catch((err) => {
                logger.warn({ err }, "quick actions unavailable");
                return null;
              })
            : null;
        const actions = (q?.actions ?? []).map((a, i) => ({ action: `quick:${i}`, title: a.action === "approve" ? t.quickApprove : (a.label ?? ""), token: a.token }));
        // An approval's second button opens the app (to read the result, or to send it back with a note).
        if (actions.length === 1) actions.push({ action: "open", title: t.quickOpen, token: "" });
        const payload = {
          title: r.title,
          body: (actions.length && q?.detail) || t.pushOpen,
          url: r.url,
          tag: r.url,
          // `done`: what the notification says once a button's action went through.
          ...(actions.length ? { actions, done: t.quickDone } : {}),
        };
        const out = await sendToDevices(c, sender, r.user_id, JSON.stringify(payload));
        sent += out.sent;
        removed += out.removed;
      }),
    );
  }
  return { sent, removed };
}

/**
 * Morning brief push. The payload carries counts only: nothing sensitive on a lock screen. Dead subscriptions
 * (404/410) are deleted. The Home inbox always holds the brief, so a failed push loses nothing.
 */
export async function sendMorningPushes(pool: Pool, sender: PushSender, limit = 1000): Promise<{ sent: number; removed: number }> {
  const users = (await pool.query<{ user_id: string; timezone: string }>("SELECT * FROM push_candidates($1)", [limit])).rows;
  let sent = 0;
  let removed = 0;
  for (const u of users) {
    await runWithContext({ actorId: "service:push", requestId: currentRequestId() ?? newId() }, () =>
      withTransaction(pool, async (c) => {
        const counts = (
          await c.query<{ tasks: number; approvals: number; meetings: number }>(
            `SELECT count(*) FILTER (WHERE kind = 'task')::int AS tasks, count(*) FILTER (WHERE kind = 'approval')::int AS approvals,
                  count(*) FILTER (WHERE kind = 'meeting' AND (starts_at AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date)::int AS meetings
             FROM home_items WHERE user_id = $1 AND resolved_at IS NULL`,
            [u.user_id, u.timezone],
          )
        ).rows[0]!;
        const t = await textsFor(c, u.user_id);
        const body = t.dayCounts(counts.tasks, counts.meetings, counts.approvals);
        const payload = JSON.stringify({ title: t.dayTitle, body, url: "/app/home" });
        const out = await sendToDevices(c, sender, u.user_id, payload);
        sent += out.sent;
        removed += out.removed;
        // The brief also lands in the inbox (the fallback channel).
        await c.query("INSERT INTO notifications (user_id, id, grp, kind, title, body, url) VALUES ($1,$2,'update','daily_brief',$4,$3,'/app/home')", [
          u.user_id,
          newId(),
          body,
          t.dayTitle,
        ]);
        await c.query("UPDATE user_prefs SET last_push_date = (now() AT TIME ZONE $2)::date WHERE user_id = $1", [u.user_id, u.timezone]);
      }),
    );
  }
  return { sent, removed };
}
