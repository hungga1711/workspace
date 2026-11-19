import type { PoolClient } from "pg";
import type { Principal } from "@workspace/shared";
import { relatedForTask, type Related } from "./related.js";
import type { TaskRow } from "./tasks.js";

/**
 * What a workflow step knows about its task besides the title and description: the
 * project, the parent task, subtasks, recent comments, attached files, documents the task names and how similar
 * tasks were done. Read as the person who started the run, so nothing they cannot open reaches the model. Gathered
 * before the first AI step, so the run asks only what none of this says; capped, so a local model stays fast.
 */

/** The whole block's budget in characters (about 2k tokens): a small local model answers in seconds, not minutes. */
export const CONTEXT_MAX = 6000;

export interface ContextParts {
  related: Pick<Related, "project" | "goals" | "parent" | "docs" | "similar"> | null;
  subtasks: { code: string; title: string; status: string }[];
  comments: { body: string }[];
  files: { name: string }[];
  /**
   * The task's project this week: what finished in the last 7 days, what is in progress, what is overdue.
   * A weekly report or status step otherwise asks people what the workspace already knows (seen live: five questions).
   */
  project?: { done: ProjectTask[]; doing: ProjectTask[]; late: ProjectTask[] } | undefined;
}
type ProjectTask = { code: string; title: string; due: string | null };

const line = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

/** The context block as the model reads it; "" when there is nothing to add. Pure, unit-tested. */
export function contextText(x: ContextParts, max = CONTEXT_MAX): string {
  const out: string[] = [];
  const r = x.related;
  if (r?.project) out.push(`Project: ${r.project.code} · ${r.project.name}${r.project.description ? ` — ${line(r.project.description, 600)}` : ""}`);
  const pt = (t: ProjectTask) => `- ${t.code} ${line(t.title, 100)}${t.due ? `, due ${t.due}` : ""}`;
  if (x.project && (x.project.done.length || x.project.doing.length || x.project.late.length))
    out.push(
      [
        `Project this week (${x.project.done.length} done in the last 7 days, ${x.project.doing.length} in progress, ${x.project.late.length} overdue):`,
        x.project.done.length ? `Done:\n${x.project.done.map(pt).join("\n")}` : "",
        x.project.doing.length ? `In progress:\n${x.project.doing.map(pt).join("\n")}` : "",
        x.project.late.length ? `Overdue:\n${x.project.late.map(pt).join("\n")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  if (r?.goals.length) out.push(`Goals: ${r.goals.map((g) => `${g.goal} (${g.keyResult})`).join("; ")}`);
  if (r?.parent) out.push(`Parent task: ${r.parent.code} · ${r.parent.title}${r.parent.description ? ` — ${line(r.parent.description, 500)}` : ""}`);
  if (x.subtasks.length)
    out.push(
      `Subtasks:\n${x.subtasks
        .slice(0, 15)
        .map((s) => `- ${s.code} ${line(s.title, 120)} [${s.status}]`)
        .join("\n")}`,
    );
  if (x.files.length)
    out.push(
      `Attached files: ${x.files
        .slice(0, 10)
        .map((f) => f.name)
        .join(", ")}`,
    );
  if (x.comments.length)
    out.push(
      `Recent comments:\n${x.comments
        .slice(0, 5)
        .map((c) => `- ${line(c.body, 300)}`)
        .join("\n")}`,
    );
  if (r?.docs.length)
    out.push(
      `Related documents:\n${r.docs
        .slice(0, 4)
        .map((d) => `- ${d.code} ${d.title}${d.excerpt ? `: ${line(d.excerpt, 400)}` : ""}`)
        .join("\n")}`,
    );
  const done = r?.similar.filter((s) => s.completedAt && s.how) ?? [];
  if (done.length)
    out.push(
      `How similar tasks were done:\n${done
        .slice(0, 3)
        .map((s) => `- ${s.code} ${line(s.title, 100)}: ${line(s.how!, 250)}`)
        .join("\n")}`,
    );
  if (!out.length) return "";
  const text = `Context from the workspace:\n${out.join("\n\n")}`;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Reads the parts for one task as `p`. Best effort: a part that fails to read is left out, the run goes on. */
export async function taskContext(c: PoolClient, p: Principal, t: Pick<TaskRow, "id">): Promise<string> {
  const safe = async <T>(f: () => Promise<T>, empty: T): Promise<T> => {
    try {
      // A failed read inside the run's transaction would abort it: each read gets its own savepoint.
      await c.query("SAVEPOINT wf_ctx");
      const v = await f();
      await c.query("RELEASE SAVEPOINT wf_ctx");
      return v;
    } catch {
      await c.query("ROLLBACK TO SAVEPOINT wf_ctx").catch(() => undefined);
      return empty;
    }
  };
  // No chat search here: messages and search hits would slow every step; the task's own links and project are enough.
  const related = await safe(() => relatedForTask(c, p, t.id, async () => []), null);
  const subtasks = await safe(
    async () =>
      (await c.query<{ code: string; title: string; status: string }>("SELECT code, title, status FROM tasks WHERE parent_id = $1 ORDER BY created_at LIMIT 15", [t.id])).rows,
    [],
  );
  // People's comments, newest first; a workflow's own results are not context for the next run.
  const comments = await safe(
    async () => (await c.query<{ body: string }>("SELECT body FROM task_comments WHERE task_id = $1 AND agent IS NULL ORDER BY created_at DESC LIMIT 5", [t.id])).rows,
    [],
  );
  const files = await safe(
    async () => (await c.query<{ name: string }>("SELECT name FROM files WHERE attached_type = 'task' AND attached_id = $1 AND status = 'active' LIMIT 10", [t.id])).rows,
    [],
  );
  const projectId = related?.project?.id;
  const project = projectId
    ? await safe(async () => {
        const q = (where: string, order: string) =>
          c
            .query<ProjectTask>(
              `SELECT code, title, to_char(due_at, 'YYYY-MM-DD') AS due FROM tasks
                WHERE project_id = $1 AND parent_id IS NULL AND ${where} ORDER BY ${order} LIMIT 8`,
              [projectId],
            )
            .then((x) => x.rows);
        return {
          done: await q("completed_at > now() - interval '7 days'", "completed_at DESC"),
          doing: await q("status IN ('in_progress','review')", "updated_at DESC"),
          late: await q("due_at < now() AND status NOT IN ('done','cancelled')", "due_at"),
        };
      }, undefined)
    : undefined;
  return contextText({ related, subtasks, comments, files, project });
}
