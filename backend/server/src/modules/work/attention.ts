import type { PoolClient } from "pg";
import { authorize, type Principal } from "@workspace/shared";
import { canReadTask } from "./tasks.js";
import { integrationOf } from "./integrations/registry.js";

/**
 * What an admin has to look at in Work (the admin overview's "Needs you" list): agent runs that failed
 * or have waited long for a person, runs waiting for a computer that is not there, and task-sync connections that
 * fail or have gone quiet. Read from what the module already keeps (`task_agent_runs`, `agent_runners`,
 * `sync_connections`); nothing is stored for it, so an item is gone as soon as its cause is.
 *
 * Missing data is "unknown", never healthy: a sync that has not reported for hours is listed as unknown.
 */
export interface AttentionItem {
  id: string;
  kind: string;
  severity: "broken" | "warning" | "unknown";
  since: string | null;
  name: string;
  detail?: string;
  ownerId?: string;
  /** A run's task, as the app links to it. */
  taskCode?: string;
  taskTitle?: string;
  /** A workflow's own page (a trigger that keeps being refused). */
  workflowId?: string;
}

export interface RunLite {
  id: string;
  workflow_name: string;
  status: "failed" | "waiting_approval" | "waiting_input" | "queued";
  error: string | null;
  started_by: string;
  updated_at: Date;
  finished_at: Date | null;
  host: "person" | "company";
  /** The run's sandbox asks for a container. */
  container: boolean;
  code: string;
  title: string;
  owner_id: string;
  assignee_id: string | null;
  team_id: string | null;
  project_id: string | null;
}
export interface RunnerLite {
  user_id: string;
  shared: boolean;
  docker: boolean;
  online: boolean;
}
export interface SyncLite {
  id: string;
  name: string;
  created_by: string;
  created_at: Date;
  last_run_at: Date | null;
  last_ok_at: Date | null;
  last_error: string | null;
}

/** A run that waits this long for an approval or an answer is worth an admin's nudge. */
export const WAITING_HOURS = 24;
/** A run queued this long with no computer to take it is stuck, not starting. */
export const QUEUED_MINUTES = 10;
/** Task sync runs every 15 minutes: silent this long, nobody knows whether it still works. */
export const SYNC_SILENT_HOURS = 2;
const MAX = 25;

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const clip = (s: string | null | undefined) => (s?.trim() ? s.trim().slice(0, 300) : undefined);

/**
 * Runs for whoever manages the company's agents, each only when they may read its task. `runs` holds each task's
 * latest run when it failed in the last week, and every run that waits or is queued.
 */
export function runItems(p: Principal, runs: RunLite[], runners: RunnerLite[], now = Date.now()): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const r of runs) {
    if (!canReadTask(p, r)) continue;
    const base = { name: r.workflow_name, ownerId: r.started_by, taskCode: r.code, taskTitle: r.title };
    const quiet = now - r.updated_at.getTime();
    if (r.status === "failed") {
      const detail = clip(r.error);
      out.push({ ...base, id: `work.run.failed:${r.id}`, kind: "work.run.failed", severity: "broken", since: iso(r.finished_at ?? r.updated_at), ...(detail ? { detail } : {}) });
    } else if (r.status === "waiting_approval" || r.status === "waiting_input") {
      if (quiet < WAITING_HOURS * 3600_000) continue;
      out.push({
        ...base,
        id: `work.run.waiting:${r.id}`,
        kind: r.status === "waiting_approval" ? "work.run.approval" : "work.run.question",
        severity: "warning",
        since: iso(r.updated_at),
      });
    } else if (r.status === "queued") {
      if (quiet < QUEUED_MINUTES * 60_000) continue;
      // The computers that could take it: the company's, or the starter's own; with Docker when it runs in a container.
      const fit = runners.some((x) => x.online && (r.host === "company" ? x.shared : x.user_id === r.started_by) && (!r.container || x.docker));
      if (fit) continue;
      out.push({
        ...base,
        id: `work.run.computer:${r.id}`,
        kind: r.host === "company" ? "work.run.noCompanyComputer" : "work.run.noComputer",
        severity: "warning",
        since: iso(r.updated_at),
      });
    }
  }
  return out.slice(0, MAX);
}

/** Enabled task-sync connections: the last run failed, or there has been none for too long (or ever). */
export function syncItems(rows: SyncLite[], now = Date.now()): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const r of rows) {
    const base = { name: r.name, ownerId: r.created_by };
    const detail = clip(r.last_error);
    if (r.last_error)
      out.push({ ...base, id: `work.sync.failed:${r.id}`, kind: "work.sync.failed", severity: "broken", since: iso(r.last_ok_at ?? r.last_run_at), ...(detail ? { detail } : {}) });
    else if (now - (r.last_run_at ?? r.created_at).getTime() > SYNC_SILENT_HOURS * 3600_000)
      out.push({ ...base, id: `work.sync.silent:${r.id}`, kind: "work.sync.silent", severity: "unknown", since: iso(r.last_run_at) });
  }
  return out;
}

export interface HubLite {
  id: string;
  provider: string;
  account: string;
  created_by: string;
  last_ok_at: Date | null;
  last_error: string | null;
}
/** Connections of the integrations hub (GitHub, GitLab, Figma…) whose last read failed: their cards no longer refresh. */
export function hubItems(rows: HubLite[], nameOf: (provider: string) => string): AttentionItem[] {
  return rows
    .filter((r) => r.last_error)
    .map((r) => {
      const detail = clip(r.last_error);
      return {
        id: `work.hub.failed:${r.id}`,
        kind: "work.hub.failed",
        severity: "broken" as const,
        since: iso(r.last_ok_at),
        name: r.account ? `${nameOf(r.provider)} · ${r.account}` : nameOf(r.provider),
        ownerId: r.created_by,
        ...(detail ? { detail } : {}),
      };
    });
}

export interface FireLite {
  workflow_id: string;
  name: string;
  created_by: string;
  status: "started" | "refused";
  reason: string | null;
  created_at: Date;
}
/** How many refusals in a row say a trigger is not working, rather than one start that had a reason not to happen. */
export const REFUSED_IN_A_ROW = 3;
/**
 * Workflows whose triggers keep being refused (the acting person lost access, a required input has no value, the
 * hourly cap): the latest fires, newest first per workflow, all refused. One refusal is normal (a run was already
 * going on the task), so it takes several in a row.
 */
export function triggerItems(fires: FireLite[]): AttentionItem[] {
  const by = new Map<string, FireLite[]>();
  for (const f of fires) by.set(f.workflow_id, [...(by.get(f.workflow_id) ?? []), f]);
  const out: AttentionItem[] = [];
  for (const [id, list] of by) {
    const latest = list.slice(0, REFUSED_IN_A_ROW);
    if (latest.length < REFUSED_IN_A_ROW || latest.some((f) => f.status !== "refused")) continue;
    const detail = clip(latest[0]!.reason);
    out.push({
      id: `work.trigger.refused:${id}`,
      kind: "work.trigger.refused",
      severity: "warning",
      since: iso(latest[latest.length - 1]!.created_at),
      name: latest[0]!.name,
      ownerId: latest[0]!.created_by,
      workflowId: id,
      ...(detail ? { detail } : {}),
    });
  }
  return out;
}

/** Each kind only to who may fix it: runs to people who manage the company's agents, task sync to who configures the workspace. */
export async function workAttention(c: PoolClient, p: Principal): Promise<{ items: AttentionItem[] } | null> {
  const agents = authorize(p, "ai.agent.manage").allowed;
  const configure = authorize(p, "workspace.configure").allowed;
  if (!agents && !configure) return null;
  const items: AttentionItem[] = [];
  if (agents) {
    const runs = await c.query<RunLite>(
      `SELECT r.id, r.workflow_name, r.status, r.error, r.started_by, r.updated_at, r.finished_at, r.host,
              COALESCE(r.config->'environment'->>'isolation', '') = 'container' AS container,
              t.code, t.title, t.owner_id, t.assignee_id, t.team_id, t.project_id
         FROM task_agent_runs r JOIN tasks t ON t.id = r.task_id
        WHERE (r.status IN ('waiting_approval', 'waiting_input') AND r.updated_at < now() - interval '${WAITING_HOURS} hours')
           OR (r.status = 'queued' AND r.runner = 'local' AND r.updated_at < now() - interval '${QUEUED_MINUTES} minutes')
           OR (r.status = 'failed' AND r.finished_at > now() - interval '7 days'
               AND NOT EXISTS (SELECT 1 FROM task_agent_runs n WHERE n.task_id = r.task_id AND n.created_at > r.created_at))
        ORDER BY r.updated_at DESC LIMIT 200`,
    );
    const runners = runs.rows.some((r) => r.status === "queued")
      ? await c.query<RunnerLite>(
          "SELECT user_id, shared, docker, last_seen_at > now() - interval '45 seconds' AS online FROM agent_runners WHERE last_seen_at > now() - interval '1 day'",
        )
      : { rows: [] };
    items.push(...runItems(p, runs.rows, runners.rows));
    // The latest few fires of each workflow that fired this week (ranked in SQL: a busy workflow has thousands).
    const fires = await c.query<FireLite>(
      `SELECT f.workflow_id, w.name, w.created_by, f.status, f.reason, f.created_at
         FROM (SELECT *, row_number() OVER (PARTITION BY workflow_id ORDER BY created_at DESC) AS n
                 FROM workflow_trigger_fires WHERE status IN ('started', 'refused') AND created_at > now() - interval '7 days') f
         JOIN agent_workflows w ON w.id = f.workflow_id AND NOT w.archived
        WHERE f.n <= ${REFUSED_IN_A_ROW}
        ORDER BY f.workflow_id, f.created_at DESC`,
    );
    items.push(...triggerItems(fires.rows));
  }
  if (configure) {
    const sync = await c.query<SyncLite>("SELECT id, name, created_by, created_at, last_run_at, last_ok_at, last_error FROM sync_connections WHERE enabled");
    items.push(...syncItems(sync.rows));
    const hub = await c.query<HubLite>("SELECT id, provider, account, created_by, last_ok_at, last_error FROM integration_connections WHERE enabled AND last_error IS NOT NULL");
    items.push(...hubItems(hub.rows, (id) => integrationOf(id)?.name ?? id));
  }
  return { items };
}
