import { createHash, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { newId, runWithContext, withTransaction, workspaceTimeZone, type Principal } from "@workspace/shared";
import { logger } from "@workspace/service-kit";
import { activity } from "./common.js";
import { Forbidden, Invalid, NotFound } from "./errors.js";
import { canReadTask, createTask, getTask, onTaskChange, type TaskRow } from "./tasks.js";
import { canEditWorkflow, configOf, getWorkflow, kickServerRun, startRun, type Engine, type RunRow, type WorkflowRow } from "./workflows.js";
import {
  currentOrigin,
  dueSlot,
  linkedTriggerMatches,
  payloadText,
  taskTitle,
  taskTriggerMatches,
  TRIGGER_LIMITS,
  withOrigin,
  type Origin,
  type Trigger,
} from "./workflows/triggers.js";

/**
 * Workflows that start by themselves, the part that fires. The model is workflows/triggers.ts.
 *
 * A fire is two steps, so nothing slow or risky happens inside someone else's transaction:
 *
 *   1. What happened is written down where it happened: a task created or moved (in that task's transaction, through
 *      tasks.ts onTaskChange), a schedule that came due, a post to a workflow's address, linked work that changed
 *      (linkedWorkChanged, called by the integrations hub). One `workflow_trigger_fires` row, 'pending'.
 *   2. The trigger job (every few seconds) takes pending rows and starts the run as the person the workflow acts as,
 *      through the same startRun a person's Run goes through, so the same permissions, limits and "one run at a time
 *      per task" hold. What cannot start is kept as 'refused' with the reason; the workflow's page lists both.
 *
 * What stops loops: a fire remembers the workflow whose run (or whose trigger) made the change behind it. A workflow
 * never starts from its own doing, a chain of workflows ends after TRIGGER_LIMITS.depth links, and a workflow starts
 * at most TRIGGER_LIMITS.perHour times an hour by trigger.
 */

interface FireRow {
  id: string;
  workflow_id: string;
  trigger_id: string;
  kind: Trigger["kind"];
  task_id: string | null;
  status: "pending" | "started" | "refused";
  reason: string | null;
  detail: string | null;
  payload: string | null;
  run_id: string | null;
  origin_workflow_id: string | null;
  depth: number;
  slot: string | null;
  created_at: Date;
  done_at: Date | null;
}

type Triggered = Pick<WorkflowRow, "id" | "name" | "config" | "runner" | "created_by" | "updated_at">;
/** The workflows that have a trigger at all: few, read through a partial index. */
async function triggered(c: PoolClient | Pool): Promise<Triggered[]> {
  return (await c.query<Triggered>("SELECT id, name, config, runner, created_by, updated_at FROM agent_workflows WHERE triggered AND NOT archived")).rows;
}

async function enqueue(
  c: PoolClient | Pool,
  f: { workflowId: string; trigger: Trigger; taskId?: string | null; detail?: string; payload?: string; origin?: Origin | undefined; slot?: string },
): Promise<boolean> {
  const r = await c.query(
    `INSERT INTO workflow_trigger_fires (id, workflow_id, trigger_id, kind, task_id, detail, payload, origin_workflow_id, depth, slot)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
    [
      newId(),
      f.workflowId,
      f.trigger.id,
      f.trigger.kind,
      f.taskId ?? null,
      f.detail?.slice(0, 300) ?? null,
      f.payload || null,
      f.origin?.workflowId || null,
      f.origin ? f.origin.depth + 1 : 0,
      f.slot ?? null,
    ],
  );
  return (r.rowCount ?? 0) > 0;
}

// A task was created or moved. Subtasks are part of their parent's work, and tasks synced from another tool are
// read-only here: neither starts a workflow.
onTaskChange(async (c, t, from) => {
  if (t.parent_id || (t.source as { type?: string } | null)?.type === "sync") return;
  const rows = await triggered(c);
  for (const w of rows) {
    const hit = configOf(w).triggers.find((x) => taskTriggerMatches(x, { projectId: t.project_id, labels: t.labels ?? [], status: t.status }, from));
    if (hit) await enqueue(c, { workflowId: w.id, trigger: hit, taskId: t.id, detail: from === null ? "created" : `${from} → ${t.status}`, origin: currentOrigin() });
  }
});

/**
 * Linked work on a task changed (the integrations hub calls this when a pull or merge request linked to the task is
 * first seen open, or seen merged): workflows waiting for that start on the task. `what` names it for the record
 * ("acme/web#12 · Fix login"); with `linkId` the same link starts a workflow once per event, however many readers
 * refresh its card at the same moment. Returns how many fires were written.
 */
export async function linkedWorkChanged(c: PoolClient | Pool, taskId: string, event: "opened" | "merged", what = "", linkId?: string): Promise<number> {
  const t = (await c.query<Pick<TaskRow, "id" | "project_id" | "parent_id">>("SELECT id, project_id, parent_id FROM tasks WHERE id = $1", [taskId])).rows[0];
  if (!t) return 0;
  let n = 0;
  for (const w of await triggered(c)) {
    const hit = configOf(w).triggers.find((x) => linkedTriggerMatches(x, { projectId: t.project_id }, event));
    if (
      hit &&
      (await enqueue(c, {
        workflowId: w.id,
        trigger: hit,
        taskId: t.id,
        detail: `${event}${what ? `: ${what}` : ""}`,
        origin: currentOrigin(),
        ...(linkId ? { slot: `${event}:${linkId}` } : {}),
      }))
    )
      n++;
  }
  return n;
}

/**
 * What a linked pull or merge request's card says now against what it said before, as an event workflows wait for:
 * "opened" the first time it is seen open, "merged" when it turns merged (or is first seen merged within a day of
 * merging: a request merged between two looks still counts, one linked long after does not). Null: nothing happened.
 */
export function linkedEvent(before: { state: string } | null | undefined, now: { kind?: string; state: string; updatedAt?: string | undefined }): "opened" | "merged" | null {
  if (now.kind && now.kind !== "review") return null;
  if (now.state === "merged" && before?.state !== "merged") {
    if (before) return "merged";
    const at = now.updatedAt ? Date.parse(now.updatedAt) : NaN;
    return Number.isFinite(at) && Date.now() - at < 24 * 3600_000 ? "merged" : null;
  }
  return !before && now.state === "open" ? "opened" : null;
}

/** Schedules that came due since the last look: one fire per schedule and day, however often this runs. */
export async function enqueueSchedules(pool: Pool, now = new Date()): Promise<number> {
  const rows = await triggered(pool);
  if (!rows.some((w) => configOf(w).triggers.some((t) => t.kind === "schedule"))) return 0;
  const tz = await withTransaction(pool, workspaceTimeZone);
  let n = 0;
  for (const w of rows)
    for (const t of configOf(w).triggers) {
      if (t.kind !== "schedule") continue;
      const slot = dueSlot(t, now, tz);
      if (!slot) continue;
      // A schedule saved after today's time has not missed it: it starts tomorrow, not the moment it is saved.
      const [h, m] = t.time.split(":").map(Number) as [number, number];
      if (w.updated_at.getTime() > now.getTime() - dueLateMs(now, tz, h, m)) continue;
      if (await enqueue(pool, { workflowId: w.id, trigger: t, detail: `${t.time}`, slot })) n++;
    }
  return n;
}

/** How long ago today's `h:m` was, in the workspace's zone (ms). */
function dueLateMs(now: Date, tz: string, h: number, m: number): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const at = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return ((at("hour") - h) * 60 + (at("minute") - m)) * 60_000 + at("second") * 1000;
}

// ── The address a system outside posts to ────────────────────────────────────────────────────────────

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * Makes (or replaces) the secret address of a workflow's "from another system" trigger. The token is returned this
 * once; only its hash is kept. Whoever may edit the workflow.
 */
export async function makeHookAddress(c: PoolClient, p: Principal, workflowId: string, triggerId: string) {
  const w = await getWorkflow(c, workflowId);
  if (w.archived) throw new NotFound("workflow not found");
  if (!canEditWorkflow(p, w)) throw new Forbidden("only its creator or an AI admin can change how this workflow starts");
  if (!configOf(w).triggers.some((t) => t.id === triggerId && t.kind === "hook")) throw new Invalid("save the workflow first: this way of starting is not part of it yet");
  const token = `wfh_${randomBytes(24).toString("base64url")}`;
  await c.query(
    `INSERT INTO workflow_hooks (workflow_id, trigger_id, token_hash, hint, created_by) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (workflow_id, trigger_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, hint = EXCLUDED.hint, created_by = EXCLUDED.created_by, created_at = now(), last_used_at = NULL`,
    [workflowId, triggerId, hash(token), token.slice(-4), p.id],
  );
  return { triggerId, path: `/api/hooks/${token}`, hint: token.slice(-4) };
}

/**
 * A system outside posted to a workflow's address. The token is the whole credential: unknown or stale, and the
 * answer is "not found" like any other wrong address. Nothing runs here; the post is written down and answered.
 */
export async function receiveHook(c: PoolClient, token: string, body: unknown) {
  if (!/^wfh_[A-Za-z0-9_-]{20,80}$/.test(token)) throw new NotFound("not found");
  const h = (await c.query<{ workflow_id: string; trigger_id: string }>("SELECT workflow_id, trigger_id FROM workflow_hooks WHERE token_hash = $1", [hash(token)])).rows[0];
  if (!h) throw new NotFound("not found");
  const w = await getWorkflow(c, h.workflow_id);
  const trigger = configOf(w).triggers.find((t) => t.id === h.trigger_id && t.kind === "hook");
  if (w.archived || !trigger) throw new NotFound("not found");
  await c.query("UPDATE workflow_hooks SET last_used_at = now() WHERE workflow_id = $1 AND trigger_id = $2", [h.workflow_id, h.trigger_id]);
  await enqueue(c, { workflowId: w.id, trigger, payload: payloadText(body) });
  return { ok: true };
}

// ── Firing ───────────────────────────────────────────────────────────────────────────────────────────

const refuse = (pool: Pool, id: string, reason: string) =>
  pool.query("UPDATE workflow_trigger_fires SET status = 'refused', reason = $2, done_at = now() WHERE id = $1 AND status = 'pending'", [id, reason.slice(0, 500)]);

/** Takes one pending fire to its end: a run started, or the reason it was not. */
async function fireOne(e: Engine, f: FireRow): Promise<void> {
  const w = (await e.pool.query<WorkflowRow>("SELECT * FROM agent_workflows WHERE id = $1", [f.workflow_id])).rows[0];
  if (!w || w.archived) return void (await refuse(e.pool, f.id, "the workflow was removed"));
  const conf = configOf(w);
  const trigger = conf.triggers.find((t) => t.id === f.trigger_id);
  if (!trigger) return void (await refuse(e.pool, f.id, "this way of starting was removed from the workflow"));
  if (f.origin_workflow_id === w.id) return void (await refuse(e.pool, f.id, "the workflow's own doing: it does not start itself again"));
  if (f.depth > TRIGGER_LIMITS.depth) return void (await refuse(e.pool, f.id, `a chain of more than ${TRIGGER_LIMITS.depth} workflows starting each other`));
  const recent = await e.pool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM workflow_trigger_fires WHERE workflow_id = $1 AND status = 'started' AND done_at > now() - interval '1 hour'",
    [w.id],
  );
  if ((recent.rows[0]?.n ?? 0) >= TRIGGER_LIMITS.perHour)
    return void (await refuse(e.pool, f.id, `over the limit: a workflow starts by itself at most ${TRIGGER_LIMITS.perHour} times an hour`));
  const who = conf.runAs || w.created_by;
  let actor: Principal;
  try {
    actor = await e.resolve(who);
  } catch {
    return void (await refuse(e.pool, f.id, "the person this workflow runs as is no longer an active member"));
  }
  const requestId = newId();
  const run = await runWithContext({ actorId: actor.id, requestId }, () =>
    withTransaction(e.pool, async (c): Promise<RunRow | null> => {
      const mine = await c.query("SELECT 1 FROM workflow_trigger_fires WHERE id = $1 AND status = 'pending' FOR UPDATE SKIP LOCKED", [f.id]);
      if (!mine.rowCount) return null;
      try {
        await c.query("SAVEPOINT wf_fire");
        // Everything the start changes (the task it makes, the workflow put on the task) carries this workflow as
        // its origin, so its own "task created" trigger does not answer it.
        const started = await withOrigin({ workflowId: w.id, depth: f.depth }, async () => {
          let taskId = f.task_id;
          if (trigger.kind === "schedule" || trigger.kind === "hook") {
            const tz = await workspaceTimeZone(c);
            const t = await createTask(c, actor, {
              title: taskTitle(trigger.title, w.name, new Date(), tz),
              description: "",
              assigneeId: actor.id,
              projectId: trigger.projectId || null,
              priority: "medium",
              dueAt: null,
              labels: [],
              customFields: {},
              parentId: null,
              source: { type: "workflow_trigger", workflowId: w.id, kind: trigger.kind },
            });
            taskId = t.id;
          }
          if (!taskId) throw new Invalid("there is no task to run on");
          // As the person the workflow acts as: a task they cannot read is "not found" to them, and startRun asks
          // for the right to edit it.
          const t = await getTask(c, actor, taskId);
          if (t.workflow_id !== w.id) {
            await c.query("UPDATE tasks SET workflow_id = $2 WHERE id = $1", [t.id, w.id]);
            await activity(c, "task", t.id, "workflow_set", { workflowId: w.id, trigger: trigger.kind });
          }
          return startRun(
            c,
            actor,
            t.id,
            {},
            { kind: trigger.kind, id: trigger.id, depth: f.depth, ...(f.detail ? { detail: f.detail } : {}), ...(f.payload ? { payload: f.payload } : {}) },
          );
        });
        await c.query("RELEASE SAVEPOINT wf_fire");
        await c.query("UPDATE workflow_trigger_fires SET status = 'started', run_id = $2, task_id = $3, done_at = now() WHERE id = $1", [f.id, started.id, started.task_id]);
        return started;
      } catch (err) {
        await c.query("ROLLBACK TO SAVEPOINT wf_fire").catch(() => undefined);
        const reason = err instanceof Forbidden ? `the person it runs as may not do this: ${err.message}` : (err as Error).message || "could not start";
        await c.query("UPDATE workflow_trigger_fires SET status = 'refused', reason = $2, done_at = now() WHERE id = $1", [f.id, reason.slice(0, 500)]);
        return null;
      }
    }),
  );
  if (run?.runner === "server") kickServerRun(e, actor, run.id, requestId);
}

/** Starts what is waiting to start. One fire failing (the database, the identity module) never holds up the others. */
export async function fireTriggers(e: Engine, limit = 25): Promise<number> {
  const pending = await e.pool.query<FireRow>("SELECT * FROM workflow_trigger_fires WHERE status = 'pending' ORDER BY created_at LIMIT $1", [limit]);
  for (const f of pending.rows) {
    try {
      await fireOne(e, f);
    } catch (err) {
      logger.warn({ err, fire: f.id }, "workflow trigger could not be fired; it stays pending");
    }
  }
  return pending.rows.length;
}

let lastMinute = -1;
/** The trigger job's turn: schedules once a minute, pending fires every time, old records once an hour. */
export async function runTriggers(e: Engine, now = new Date()): Promise<void> {
  const minute = Math.floor(now.getTime() / 60_000);
  if (minute !== lastMinute) {
    lastMinute = minute;
    await enqueueSchedules(e.pool, now);
    if (minute % 60 === 0) await e.pool.query("DELETE FROM workflow_trigger_fires WHERE created_at < now() - interval '90 days'");
  }
  await fireTriggers(e);
}

// ── For the workflow's page ──────────────────────────────────────────────────────────────────────────

/**
 * How a workflow has started by itself lately: each fire with what came of it, the addresses made for it (never the
 * token) and who its runs act as. A task the reader may not open is left out of the line, which still shows.
 */
export async function triggerActivity(c: PoolClient, p: Principal, workflowId: string) {
  const w = await getWorkflow(c, workflowId);
  const fires = await c.query<
    FireRow & { code: string | null; title: string | null; project_id: string | null; owner_id: string | null; assignee_id: string | null; team_id: string | null }
  >(
    `SELECT f.*, t.code, t.title, t.project_id, t.owner_id, t.assignee_id, t.team_id
       FROM workflow_trigger_fires f LEFT JOIN tasks t ON t.id = f.task_id
      WHERE f.workflow_id = $1 ORDER BY f.created_at DESC LIMIT 20`,
    [workflowId],
  );
  const hooks = await c.query<{ trigger_id: string; hint: string; created_at: Date; last_used_at: Date | null }>(
    "SELECT trigger_id, hint, created_at, last_used_at FROM workflow_hooks WHERE workflow_id = $1",
    [workflowId],
  );
  const conf = configOf(w);
  return {
    runAs: conf.triggers.length ? conf.runAs || w.created_by : null,
    limits: { perHour: TRIGGER_LIMITS.perHour },
    hooks: hooks.rows.map((h) => ({ triggerId: h.trigger_id, hint: h.hint, createdAt: h.created_at, lastUsedAt: h.last_used_at })),
    fires: fires.rows.map((f) => {
      const readable = f.code && canReadTask(p, { project_id: f.project_id, owner_id: f.owner_id!, assignee_id: f.assignee_id, team_id: f.team_id });
      return {
        id: f.id,
        triggerId: f.trigger_id,
        kind: f.kind,
        status: f.status,
        reason: f.reason,
        detail: f.detail,
        runId: readable ? f.run_id : null,
        task: readable ? { id: f.task_id!, code: f.code!, title: f.title! } : null,
        at: f.created_at,
      };
    }),
  };
}
