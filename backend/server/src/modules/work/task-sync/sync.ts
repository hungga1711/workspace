import { newId, runWithContext, withTransaction, type Principal } from "@workspace/shared";
import { logger, secretBox } from "@workspace/service-kit";
import type { Pool, PoolClient } from "pg";
import { emit } from "../common.js";
import { createProject } from "../projects.js";
import { announceStatusChanges, eventPayload, insertTask, TASK_COLS, type TaskRow, type TaskStatus } from "../tasks.js";
import { CONNECTORS } from "./connectors/index.js";
import { PROVIDER_LABEL, type Credentials, type ExternalTask, type Fetcher, type Provider } from "./types.js";

/**
 * Task sync: reads tasks from Asana, ClickUp, Linear or Jira Cloud into our projects so AI Insights can
 * compare work done with and without AI on the tool a team already uses. Read-only and incremental: each run asks for
 * tasks updated since the last one, creates or updates ours, and never writes back. Tasks deleted at the source stay
 * here (a later version may archive them).
 */

/** Tokens are AES-GCM like AI connection keys; TASK_SYNC_SECRETS_KEY overrides the derived key. */
const box = secretBox("task-sync/v1", "TASK_SYNC_SECRETS_KEY");
export const encryptToken = (plain: string) => box.encrypt(plain);
export const decryptToken = (enc: string) => box.decrypt(enc);

export interface SyncDeps {
  pool: Pool;
  fetch: Fetcher;
  /** Members by email (lower-case) → user id, from the identity module. */
  members: (emails: string[]) => Promise<Map<string, string>>;
}

export interface ConnectionRow {
  id: string;
  provider: Provider;
  name: string;
  site: string | null;
  account_email: string | null;
  secret_enc: string;
  scope: string[];
  enabled: boolean;
  created_by: string;
  cursor_at: Date | null;
}

export interface RunResult {
  fetched: number;
  created: number;
  updated: number;
  unmatched: number;
  error: string | null;
}

/** The source key becomes our code when it looks like one (ENG-123, DEV-42) and nothing else has it. */
const KEY = /^[A-Z][A-Z0-9_]{0,15}-\d{1,9}$/;

/** Acts as the connection's creator for project ownership; may create projects whatever their own role grants. */
function syncPrincipal(ownerId: string): Principal {
  return { type: "service", id: ownerId, teamIds: [], departmentId: null, grants: [{ permission: "project.create", scope: "WORKSPACE" }] };
}

export function credentialsOf(row: Pick<ConnectionRow, "secret_enc" | "site" | "account_email">): Credentials {
  return { token: decryptToken(row.secret_enc), site: row.site, email: row.account_email };
}

/** One connection, start to finish. Never throws: a failure is stored on the connection for the admin to read. */
export async function runConnection(deps: SyncDeps, id: string): Promise<RunResult> {
  const row = (await deps.pool.query<ConnectionRow>("SELECT * FROM sync_connections WHERE id = $1", [id])).rows[0];
  if (!row) return { fetched: 0, created: 0, updated: 0, unmatched: 0, error: "connection not found" };
  const startedAt = new Date();
  try {
    if (!row.enabled || !row.scope.length) return { fetched: 0, created: 0, updated: 0, unmatched: 0, error: null };
    const connector = CONNECTORS[row.provider];
    const cred = credentialsOf(row);
    const tasks = await connector.fetchTasks(cred, row.scope, row.cursor_at, deps.fetch);
    const known = new Set((await deps.pool.query<{ external_id: string }>("SELECT external_id FROM sync_projects WHERE connection_id = $1", [id])).rows.map((r) => r.external_id));
    const names = row.scope.some((s) => !known.has(s)) ? new Map((await connector.listProjects(cred, deps.fetch)).map((p) => [p.id, p.name])) : new Map<string, string>();
    const emails = [...new Set(tasks.flatMap((t) => (t.assigneeEmail ? [t.assigneeEmail.toLowerCase()] : [])))];
    const people = emails.length ? await deps.members(emails).catch(() => new Map<string, string>()) : new Map<string, string>();
    const result = await runWithContext({ actorId: `task-sync:${row.id}`, requestId: newId() }, () =>
      withTransaction(deps.pool, async (c) => {
        // One write at a time per connection (the 15-minute job and "Sync now" can overlap): the second waits, then
        // sees what the first created and only updates.
        await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`task-sync:${row.id}`]);
        const projects = await ensureProjects(c, row, names);
        return applyTasks(c, row, tasks, projects, people);
      }),
    );
    const newest = tasks.reduce<number>((m, t) => Math.max(m, t.updatedAt ? Date.parse(t.updatedAt) : 0), row.cursor_at?.getTime() ?? 0);
    // A minute of overlap: the source's clock and ours differ, and re-reading an unchanged task is a no-op.
    const cursor = newest ? new Date(newest - 60_000) : row.cursor_at;
    const total = (await deps.pool.query<{ n: string }>("SELECT count(*) AS n FROM sync_items WHERE connection_id = $1", [id])).rows[0]!.n;
    await deps.pool.query(
      `UPDATE sync_connections SET cursor_at = $2, last_run_at = $3, last_ok_at = now(), last_error = NULL,
              stats = jsonb_build_object('fetched', $4::int, 'created', $5::int, 'updated', $6::int, 'unmatched', $7::int, 'tasks', $8::int)
        WHERE id = $1`,
      [id, cursor, startedAt, tasks.length, result.created, result.updated, result.unmatched, Number(total)],
    );
    return { fetched: tasks.length, ...result, error: null };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.warn({ err: e, connection: id, provider: row.provider }, "task sync failed");
    await deps.pool.query("UPDATE sync_connections SET last_run_at = $2, last_error = $3 WHERE id = $1", [id, startedAt, message.slice(0, 500)]).catch(() => undefined);
    return { fetched: 0, created: 0, updated: 0, unmatched: 0, error: message };
  }
}

/** Every enabled connection, one after another (the scheduled job). */
export async function runAll(deps: SyncDeps): Promise<void> {
  const ids = (await deps.pool.query<{ id: string }>("SELECT id FROM sync_connections WHERE enabled ORDER BY created_at")).rows;
  for (const { id } of ids) await runConnection(deps, id);
}

/** External project id → our project id, creating ours the first time (named after the source's). */
async function ensureProjects(c: PoolClient, row: ConnectionRow, names: Map<string, string>): Promise<Map<string, string>> {
  const out = new Map(
    (await c.query<{ external_id: string; project_id: string }>("SELECT external_id, project_id FROM sync_projects WHERE connection_id = $1", [row.id])).rows.map((r) => [
      r.external_id,
      r.project_id,
    ]),
  );
  for (const ext of row.scope) {
    if (out.has(ext)) continue;
    const name = (names.get(ext) ?? `${PROVIDER_LABEL[row.provider]} ${ext}`).slice(0, 120);
    const p = await createProject(c, syncPrincipal(row.created_by), {
      name,
      description: `Synced from ${PROVIDER_LABEL[row.provider]} (read-only).`,
      teamId: null,
      ownerId: row.created_by,
      dueAt: null,
    });
    await c.query("INSERT INTO sync_projects (connection_id, external_id, project_id, name) VALUES ($1,$2,$3,$4)", [row.id, ext, p.id, name]);
    out.set(ext, p.id);
  }
  return out;
}

async function applyTasks(c: PoolClient, row: ConnectionRow, tasks: ExternalTask[], projects: Map<string, string>, people: Map<string, string>) {
  let created = 0;
  let updated = 0;
  let unmatched = 0;
  const items = new Map(
    (
      await c.query<{ external_id: string; task_id: string; external_updated_at: Date | null }>(
        "SELECT external_id, task_id, external_updated_at FROM sync_items WHERE connection_id = $1",
        [row.id],
      )
    ).rows.map((r) => [r.external_id, r]),
  );
  for (const t of tasks) {
    const projectId = projects.get(t.projectId);
    if (!projectId) continue;
    const assigneeId = t.assigneeEmail ? (people.get(t.assigneeEmail.toLowerCase()) ?? null) : null;
    if (t.assigneeEmail && !assigneeId) unmatched++;
    const source = { type: "sync", system: row.provider, connectionId: row.id, externalId: t.id, key: t.key, url: t.url };
    const title = t.title.slice(0, 300);
    await c.query("SAVEPOINT sync_task");
    try {
      const item = items.get(t.id);
      if (!item) {
        const code = t.key && KEY.test(t.key) && !(await c.query("SELECT 1 FROM tasks WHERE code = $1", [t.key])).rowCount ? t.key : undefined;
        const task = await insertTask(c, row.created_by, null, {
          title,
          description: "",
          assigneeId,
          projectId,
          priority: "medium",
          dueAt: t.dueAt,
          labels: [],
          customFields: {},
          parentId: null,
          source,
          status: t.status,
          code,
        });
        await stampDates(c, task.id, t);
        await c.query("INSERT INTO sync_items (connection_id, external_id, task_id, external_updated_at) VALUES ($1,$2,$3,$4)", [row.id, t.id, task.id, t.updatedAt]);
        created++;
      } else {
        if (item.external_updated_at && t.updatedAt && item.external_updated_at.getTime() === Date.parse(t.updatedAt)) {
          await c.query("RELEASE SAVEPOINT sync_task");
          continue;
        }
        const before = (await c.query<TaskRow>(`SELECT ${TASK_COLS} FROM tasks WHERE id = $1`, [item.task_id])).rows[0];
        if (!before) {
          // Deleted here (by its connection being re-created, or by hand): forget it so the next run brings it back.
          await c.query("DELETE FROM sync_items WHERE connection_id = $1 AND external_id = $2", [row.id, t.id]);
        } else {
          await c.query(
            `UPDATE tasks SET title = $2, assignee_id = $3, due_at = $4, project_id = $5, status = $6, source = $7, version = version + 1, updated_at = now() WHERE id = $1`,
            [item.task_id, title, assigneeId, t.dueAt, projectId, t.status, JSON.stringify(source)],
          );
          await stampDates(c, item.task_id, t);
          if (before.status !== t.status) await announceStatusChanges(c, [{ id: item.task_id, status: before.status as TaskStatus }]);
          else {
            const after = (await c.query<TaskRow>(`SELECT ${TASK_COLS} FROM tasks WHERE id = $1`, [item.task_id])).rows[0]!;
            await emit(c, "work.task.updated.v1", "work.task", after.id, eventPayload(after));
          }
          await c.query("UPDATE sync_items SET external_updated_at = $3 WHERE connection_id = $1 AND external_id = $2", [row.id, t.id, t.updatedAt]);
          updated++;
        }
      }
      await c.query("RELEASE SAVEPOINT sync_task");
    } catch (e) {
      await c.query("ROLLBACK TO SAVEPOINT sync_task");
      logger.warn({ err: e, connection: row.id, task: t.id }, "task sync skipped a task");
    }
  }
  return { created, updated, unmatched };
}

/**
 * The source's own dates, so "added this week", cycle time and "finished with AI" read the real history rather than
 * the day the sync first ran. A second statement: the status triggers only fire on a status change.
 */
async function stampDates(c: PoolClient, taskId: string, t: ExternalTask) {
  await c.query(
    `UPDATE tasks SET
        created_at = coalesce($2::timestamptz, created_at),
        started_at = coalesce($3::timestamptz, started_at),
        completed_at = CASE WHEN status = 'done' THEN coalesce($4::timestamptz, completed_at) ELSE NULL END,
        status_changed_at = coalesce(CASE WHEN status = 'done' THEN $4::timestamptz END, $3::timestamptz, status_changed_at)
      WHERE id = $1`,
    [taskId, t.createdAt, t.startedAt, t.completedAt],
  );
}
