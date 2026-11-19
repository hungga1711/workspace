import { createHash, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import type { Principal } from "@workspace/shared";
import type { AskQuestion } from "./agent-ask.js";
import { Conflict, NotFound } from "./errors.js";
import { answerRun, approveRun, canAnswer, canApprove, type Engine, type RunRow } from "./workflows.js";
import { TASK_COLS, type TaskRow } from "./tasks.js";

/**
 * Acting on a waiting run from the notification that announced it: a push about an approval carries
 * "Approve", one about a single either/or question carries its two options. Pressing one never opens the app.
 *
 * What stands behind a button is a token made for one person, one wait and one action:
 *
 * - the home module asks for it only for people who turned quick actions on (off by default: a notification's buttons
 *   can be pressed on a locked phone), at the moment it sends the push, so tokens are never in an event, the audit
 *   trail or a webhook; they exist in the push payload (encrypted to the device) and here as a SHA-256;
 * - it works once, for an hour, and only for the wait it was made for: a step that was sent back and waits again is
 *   another wait, so an old notification can never approve newer work;
 * - redeeming it needs that person's own session as well (the service worker's request carries the cookie): a copied
 *   payload is worth nothing elsewhere, and someone signed out everywhere cannot act;
 * - the action then goes through `approveRun` / `answerRun` as that person, with the permissions they hold now.
 *
 * Sending work back needs a note and several questions need a form: those open the app.
 */
export const QUICK_TTL_MIN = 60;
/** What fits on a notification button. */
const OPTION_MAX = 40;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const newToken = () => `wqa_${randomBytes(32).toString("base64url")}`;

export interface QuickAction {
  action: "approve" | "answer";
  /** answer: the option, shown as the button. */
  label?: string;
  token: string;
}

type Wait = { runId: string; waitId?: string | undefined; questionId?: string | undefined };

async function runAndTask(c: PoolClient, runId: string) {
  const r = (await c.query<RunRow>("SELECT * FROM task_agent_runs WHERE id = $1", [runId])).rows[0];
  if (!r) return null;
  const t = (await c.query<TaskRow>(`SELECT ${TASK_COLS} FROM tasks WHERE id = $1`, [r.task_id])).rows[0];
  return t ? { r, t } : null;
}

/**
 * The buttons a notification about this wait may carry for this person, each with a fresh token; none when the wait
 * is over, is not theirs to act on, or needs more than a button. `detail`: the task and the step (or the question),
 * for the notification's second line: the person chose to see it there by turning quick actions on.
 */
export async function mintQuickActions(e: Engine, c: PoolClient, userId: string, w: Wait): Promise<{ detail: string; actions: QuickAction[] }> {
  const none = { detail: "", actions: [] };
  const found = await runAndTask(c, w.runId);
  if (!found) return none;
  const { r, t } = found;
  const who = await e.resolve(userId).catch(() => null);
  if (!who) return none;
  let waitId: string;
  let detail: string;
  let made: { action: "approve" | "answer"; label?: string; answer?: Record<string, string> }[];
  if (w.questionId) {
    const q = (
      await c.query<{ id: string; step_index: number; questions: AskQuestion[]; closed_at: Date | null }>(
        "SELECT id, step_index, questions, closed_at FROM task_agent_run_questions WHERE id = $1 AND run_id = $2",
        [w.questionId, r.id],
      )
    ).rows[0];
    if (!q || q.closed_at || r.status !== "waiting_input" || r.current_step !== q.step_index || !canAnswer(who, r, t)) return none;
    const only = q.questions.length === 1 ? q.questions[0]! : null;
    const options = only?.kind === "choice" ? (only.options ?? []) : [];
    // Two buttons is what phones show; anything else is answered in the app.
    if (!only || options.length !== 2 || options.some((o) => !o.trim() || o.length > OPTION_MAX)) return none;
    waitId = q.id;
    detail = `${t.code} · ${only.text}`.slice(0, 160);
    made = options.map((o) => ({ action: "answer" as const, label: o, answer: { [only.id]: o } }));
  } else {
    const s = r.steps[r.current_step];
    if (!w.waitId || r.status !== "waiting_approval" || s?.waitId !== w.waitId || !canApprove(who, r, t)) return none;
    waitId = w.waitId;
    detail = `${t.code} · ${s.title}`.slice(0, 160);
    made = [{ action: "approve" }];
  }
  // One live set of buttons per person and wait; what has expired goes as new ones are made.
  await c.query("DELETE FROM agent_quick_actions WHERE (user_id = $1 AND wait_id = $2 AND used_at IS NULL) OR expires_at < now() - interval '1 day'", [userId, waitId]);
  const actions: QuickAction[] = [];
  for (const m of made) {
    const token = newToken();
    await c.query(
      `INSERT INTO agent_quick_actions (token_hash, user_id, run_id, wait_id, action, answer, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(mins => $7))`,
      [sha(token), userId, r.id, waitId, m.action, m.answer ? JSON.stringify(m.answer) : null, QUICK_TTL_MIN],
    );
    actions.push({ action: m.action, ...(m.label ? { label: m.label } : {}), token });
  }
  return { detail, actions };
}

/**
 * A button was pressed: the token is spent and the action done as the signed-in person. A token that is unknown,
 * someone else's, used or expired answers the same "not found" (nothing to learn from trying); one whose wait has
 * moved on answers "conflict". Either way the notification opens the app instead. A failed action spends nothing
 * (the transaction rolls back), and nothing was done.
 */
export async function redeemQuickAction(c: PoolClient, p: Principal, token: string): Promise<{ action: "approve" | "answer"; run: RunRow }> {
  if (p.type !== "user" || !token.startsWith("wqa_")) throw new NotFound("this action is no longer available");
  const row = (
    await c.query<{ run_id: string; wait_id: string; action: "approve" | "answer"; answer: Record<string, string> | null }>(
      `UPDATE agent_quick_actions SET used_at = now()
        WHERE token_hash = $1 AND user_id = $2 AND used_at IS NULL AND expires_at > now()
        RETURNING run_id, wait_id, action, answer`,
      [sha(token), p.id],
    )
  ).rows[0];
  if (!row) throw new NotFound("this action is no longer available");
  if (row.action === "answer") return { action: "answer", run: await answerRun(c, p, row.wait_id, { answers: row.answer ?? {} }) };
  const now = (await c.query<RunRow>("SELECT * FROM task_agent_runs WHERE id = $1 FOR UPDATE", [row.run_id])).rows[0];
  if (!now || now.status !== "waiting_approval" || now.steps[now.current_step]?.waitId !== row.wait_id) throw new Conflict("this was already decided");
  return { action: "approve", run: await approveRun(c, p, row.run_id, "") };
}
