import { BadRequestException, Controller, Get, Query, Req } from "@nestjs/common";
import { assertAllowed } from "@workspace/service-kit";
import { withTransaction } from "@workspace/shared";
import type { Request } from "express";
import { outcomes } from "../outcomes.js";
import { canReadTask, TASK_COLS, type TaskRow } from "../tasks.js";

import { WorkControllerBase } from "./base.controller.js";
import { member } from "./common.js";

/** My tasks: assigned to me, or my own to-dos nobody is assigned to (as "Việc của tôi"). */
const MINE = "(assignee_id = $1 OR (owner_id = $1 AND assignee_id IS NULL))";
/** Tasks worth linking an AI conversation to: still open, or finished in the last 60 days. */
const LINKABLE = "(status IN ('todo', 'in_progress', 'review') OR (status = 'done' AND completed_at > now() - interval '60 days'))";

const brief = (t: Pick<TaskRow, "id" | "code" | "title" | "status" | "completed_at">) => ({
  id: t.id,
  code: t.code,
  title: t.title,
  status: t.status,
  completedAt: t.completed_at,
});

/**
 * Của tôi › AI asks work about the caller's own tasks (the ai module calls these as the caller, ADR 0011): which of
 * them AI helped with and how they went, and which task an AI conversation was probably for. Everything is
 * bounded by "mine", so no query reads more than one person's tasks.
 */
@Controller()
export class MeAiController extends WorkControllerBase {
  /** My tasks finished in the window with AI's help against the rest, and the helped ones (newest first). */
  @Get("me/ai-outcomes")
  async myAiOutcomes(@Req() req: Request, @Query("days") daysQ?: string) {
    const p = member(req);
    assertAllowed(p, "task.read");
    const days = [7, 30, 90].includes(Number(daysQ)) ? Number(daysQ) : 30;
    return withTransaction(this.pool, async (c) => {
      const o = await outcomes(c, [p.id], days);
      const helped = (
        await c.query<TaskRow & { days: number }>(
          `SELECT t.id, t.code, t.title, t.status, t.completed_at,
                  round((extract(epoch FROM t.completed_at - t.created_at) / 86400)::numeric, 1)::float AS days
             FROM tasks t JOIN task_ai_assists a ON a.task_id = t.id
            WHERE t.assignee_id = $1 AND t.status = 'done' AND t.completed_at > now() - make_interval(days => $2)
              AND a.first_at <= t.completed_at
            ORDER BY t.completed_at DESC LIMIT 10`,
          [p.id, days],
        )
      ).rows;
      return { days, withAi: o.withAi, helped: helped.map((t) => ({ ...brief(t), days: t.days })) };
    });
  }

  /**
   * Tasks of mine matching a piece of text. `mode=suggest` ranks by full-text overlap with an AI conversation's
   * title and first prompt (any shared word counts, accents ignored), for "Có phải việc này?"; the person always
   * confirms. `mode=search` is the picker: what the person types, by title or code.
   */
  @Get("me/tasks/match")
  async matchTasks(@Req() req: Request, @Query("q") q?: string, @Query("mode") mode?: string) {
    const p = member(req);
    assertAllowed(p, "task.read");
    const text = (q ?? "").trim().slice(0, 500);
    return withTransaction(this.pool, async (c) => {
      if (mode === "suggest") {
        if (!text) return { tasks: [] };
        // The person's linkable tasks first (tasks_assignee_idx / tasks_owner_idx), the text match only on those:
        // left in one WHERE, the planner walked every task by updated_at and computed to_tsvector per row.
        const r = await c.query<TaskRow & { rank: number }>(
          `WITH q AS (
             SELECT to_tsquery('simple', string_agg(quote_literal(lexeme), ' | ')) AS q
               FROM unnest(to_tsvector('simple', public.unaccent(lower($2)))) WHERE length(lexeme) > 2),
           mine AS MATERIALIZED (
             SELECT id, code, title, status, completed_at, updated_at FROM tasks WHERE ${MINE} AND ${LINKABLE})
           SELECT id, code, title, status, completed_at, ts_rank(to_tsvector('simple', public.unaccent(lower(title))), q.q) AS rank
             FROM mine, q
            WHERE q.q IS NOT NULL AND to_tsvector('simple', public.unaccent(lower(title))) @@ q.q
            ORDER BY rank DESC, updated_at DESC LIMIT 3`,
          [p.id, text],
        );
        return { tasks: r.rows.map(brief) };
      }
      const like = `%${text.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      const r = await c.query<TaskRow>(
        `SELECT id, code, title, status, completed_at FROM tasks
          WHERE ${MINE} AND ${LINKABLE} AND ($2 = '%%' OR title ILIKE $2 OR code ILIKE $2)
          ORDER BY (status = 'done'), updated_at DESC LIMIT 8`,
        [p.id, like],
      );
      return { tasks: r.rows.map(brief) };
    });
  }

  /** Code, title and status of tasks I may read, for the links shown in Của tôi › AI; unknown ids are left out. */
  @Get("me/tasks/lookup")
  async lookupTasks(@Req() req: Request, @Query("ids") idsQ?: string, @Query("codes") codesQ?: string) {
    const p = member(req);
    assertAllowed(p, "task.read");
    const ids = [...new Set((idsQ ?? "").split(",").filter(Boolean))];
    // Or by code (T-123): coding-agent sessions on people's computers name the task in their branch or folder.
    const codes = [
      ...new Set(
        (codesQ ?? "")
          .split(",")
          .map((x) => x.trim().toUpperCase())
          .filter(Boolean),
      ),
    ];
    if (ids.length > 100 || codes.length > 100) throw new BadRequestException("at most 100 ids");
    if (!ids.length && !codes.length) return { tasks: [] };
    return withTransaction(this.pool, async (c) => {
      // A synced task (Asana, ClickUp, Linear, Jira) also answers to its source key when that key is not its code.
      const r = await c.query<TaskRow>(
        `SELECT ${TASK_COLS} FROM tasks WHERE id = ANY($1::text[]) OR code = ANY($2::text[]) OR (source ->> 'type' = 'sync' AND source ->> 'key' = ANY($2::text[]))`,
        [ids, codes],
      );
      return {
        tasks: r.rows
          .filter((t) => canReadTask(p, t))
          .map((t) => {
            const key = (t.source as { type?: string; key?: string | null } | null)?.type === "sync" ? ((t.source as { key?: string | null }).key ?? null) : null;
            return key && key !== t.code ? { ...brief(t), key } : brief(t);
          }),
      };
    });
  }
}
