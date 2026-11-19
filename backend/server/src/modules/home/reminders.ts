import type { Pool } from "pg";
import { currentRequestId, newId, runWithContext, withTransaction } from "@workspace/shared";
import { dueAt, msg, textsFor } from "./texts.js";

/**
 * Due-soon reminders: a task due within 24 hours gets one inbox notice and one
 * content-free push for its assignee, per due date. Muting "task" notices turns these off too.
 */
export async function sendDueReminders(pool: Pool, limit = 500): Promise<{ reminded: number }> {
  const rows = (await pool.query<{ user_id: string; ref_id: string; title: string; url: string; due_at: Date; timezone: string }>("SELECT * FROM due_reminders($1)", [limit])).rows;
  for (const r of rows) {
    await runWithContext({ actorId: "service:reminders", requestId: currentRequestId() ?? newId() }, () =>
      withTransaction(pool, async (c) => {
        const t = await textsFor(c, r.user_id);
        // Kept as data: the inbox writes it in the reader's language and their workspace's zone when shown.
        const when = dueAt(r.due_at, r.timezone);
        // Claim first: a concurrent run skips rows already reminded for this due date.
        const claimed = await c.query(
          "UPDATE home_items SET reminded_due = due_at WHERE user_id = $1 AND kind = 'task' AND ref_id = $2 AND reminded_due IS DISTINCT FROM due_at RETURNING 1",
          [r.user_id, r.ref_id],
        );
        if (!claimed.rowCount) return;
        // The message is kept as data too, so the inbox says it in whatever language the reader uses later.
        await c.query(
          "INSERT INTO notifications (user_id, id, grp, kind, title, body, url, ref_id, title_msg, group_key) VALUES ($1,$2,'action','task.due',$3,'',$4,$5,$6,'task.due')",
          [r.user_id, newId(), t.dueSoon(when, r.title).slice(0, 300), r.url, r.ref_id, JSON.stringify(msg("dueSoon", when, r.title))],
        );
        await c.query(
          `INSERT INTO push_outbox (id, user_id, title, url)
           SELECT $1, $2, $4, $3 WHERE EXISTS (SELECT 1 FROM user_prefs WHERE user_id = $2 AND push_enabled)
             AND EXISTS (SELECT 1 FROM push_subscriptions WHERE user_id = $2)`,
          [newId(), r.user_id, r.url, t.dueSoonPush],
        );
      }),
    );
  }
  return { reminded: rows.length };
}

/**
 * "Nhắc tôi" reminders that are due: one inbox notice (an action, so it also goes out as a push) each.
 * Claimed with sent_at first, so a reminder is never sent twice.
 */
export async function sendPersonalReminders(pool: Pool, limit = 500): Promise<{ sent: number }> {
  const rows = (await pool.query<{ id: string; user_id: string }>("SELECT * FROM due_personal_reminders($1)", [limit])).rows;
  let sent = 0;
  for (const r of rows) {
    await runWithContext({ actorId: "service:reminders", requestId: currentRequestId() ?? newId() }, () =>
      withTransaction(pool, async (c) => {
        const claimed = (await c.query<{ title: string; url: string }>("UPDATE reminders SET sent_at = now() WHERE id = $1 AND sent_at IS NULL RETURNING title, url", [r.id]))
          .rows[0];
        if (!claimed) return;
        const t = await textsFor(c, r.user_id);
        await c.query("INSERT INTO notifications (user_id, id, grp, kind, title, body, url, ref_id, title_msg) VALUES ($1,$2,'action','reminder',$3,'',$4,$5,$6)", [
          r.user_id,
          newId(),
          t.reminder(claimed.title).slice(0, 300),
          claimed.url,
          r.id,
          JSON.stringify(msg("reminder", claimed.title)),
        ]);
        await c.query(
          `INSERT INTO push_outbox (id, user_id, title, url)
           SELECT $1, $2, $4, $3 WHERE EXISTS (SELECT 1 FROM user_prefs WHERE user_id = $2 AND push_enabled)
             AND EXISTS (SELECT 1 FROM push_subscriptions WHERE user_id = $2)`,
          [newId(), r.user_id, claimed.url, t.reminderPush],
        );
        sent++;
      }),
    );
  }
  return { sent };
}
