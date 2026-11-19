import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import type { PoolClient } from "pg";
import { z } from "zod";
import { appendToOutbox, newId, withTransaction, workspaceTimeZone, type Principal } from "@workspace/shared";
import { parse, requirePrincipal } from "@workspace/service-kit";
import { DEPS } from "./ai.controller.js";
import { aiAudience } from "./audience.js";
import { HOURLY_COST, HOURLY_COST_JOIN } from "./hourly-stats.js";
import { buildTokenReport, dayRange, type TokenRow } from "./local-usage-report.js";
import type { Deps } from "./runtime.js";
import { workTokens } from "./metrics.js";

/**
 * Rows (alias `u`, with user_id and device) from computers that count: all of them, except while the workspace runs
 * on demo data (ai.workspace_settings.demo_data, set by platform.demo_refresh), when only the demo's own computers
 * do, so one developer's real coding-agent logs never land in a demo company's numbers.
 */
export const DEMO_DEVICES = `(NOT coalesce((SELECT demo_data FROM workspace_settings LIMIT 1), false)
  OR EXISTS (SELECT 1 FROM ai_local_devices dd WHERE dd.user_id = u.user_id AND dd.device = u.device AND dd.demo))`;

// "local-model": a model server on the computer (Ollama, LM Studio…), counted by workspace-connect.mjs.
const TOOLS = ["claude-code", "codex", "gemini-cli", "opencode", "local-model", "other"] as const;
const n = z.number().int().min(0).max(1e13);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * What workspace-usage.mjs sends: daily totals per tool and model (whole days again on every sync), and the sessions
 * that named a task code in their branch or folder. Counts only: no prompt text, paths or project names.
 */
const SyncBody = z.object({
  device: z.string().trim().min(1).max(80),
  timeZone: z.string().max(64).optional(),
  rows: z
    .array(
      z.object({
        tool: z.enum(TOOLS),
        model: z.string().trim().min(1).max(80),
        day,
        input: n,
        output: n,
        cacheRead: n,
        cacheWrite: n,
        reasoning: n.default(0),
        turns: n.default(0),
        sessions: n.default(0),
      }),
    )
    .max(5000),
  sessions: z
    .array(
      z.object({
        key: z.string().regex(/^[a-f0-9]{16,64}$/),
        tool: z.enum(TOOLS),
        taskCode: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,9}-\d{1,7}$/),
        tokens: n,
        firstAt: z.string().datetime({ offset: true }),
        lastAt: z.string().datetime({ offset: true }),
      }),
    )
    .max(1000)
    .default([]),
});

export const today = (tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

function person(req: Request): Principal {
  const p = requirePrincipal(req);
  if (p.type !== "user") throw new ForbiddenException("people only");
  return p;
}

/**
 * Token use on people's computers (Áp dụng AI › Mức sử dụng and the weekly report), learnt from how desktop agent
 * tools measure it: the agents' own logs on the machine hold every turn's token counts, so a small collector there
 * sees all of it, not only what passes through the workspace. Next to it, the company AI's metered tokens.
 */
@Controller()
export class LocalUsageController {
  constructor(@Inject(DEPS) private readonly d: Deps) {}

  /** The collector's sync, with a personal API key (or a session). Replaces the days it sends. */
  @Post("local-usage")
  @HttpCode(200)
  async sync(@Req() req: Request, @Body() body: unknown) {
    const p = person(req);
    const b = parse(SyncBody, body);
    const oldest = new Date(Date.now() - 400 * 86_400_000).toISOString().slice(0, 10);
    const rows = b.rows.filter((r) => r.day >= oldest);
    // Sessions that named a task: only codes of tasks this person may read count (work answers as them).
    const codes = [...new Set(b.sessions.map((s) => s.taskCode.toUpperCase()))].slice(0, 100);
    const tasks = codes.length
      ? await this.d.services.work
          .request<{ tasks: { id: string; code: string }[] }>("GET", `/me/tasks/lookup?codes=${codes.map(encodeURIComponent).join(",")}`, undefined, p)
          .then((r) => new Map(r.tasks.map((t) => [t.code.toUpperCase(), t.id])))
          .catch(() => new Map<string, string>())
      : new Map<string, string>();
    return withTransaction(this.d.pool, async (c) => {
      await c.query(
        `INSERT INTO ai_local_devices (user_id, device, time_zone) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, device) DO UPDATE SET last_sync_at = now(), time_zone = EXCLUDED.time_zone`,
        [p.id, b.device, b.timeZone ?? ""],
      );
      if (rows.length)
        await c.query(
          `INSERT INTO ai_local_usage (user_id, device, tool, model, day, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, turns, sessions)
           SELECT $1, $2, x.tool, x.model, x.day::date, x.input, x.output, x."cacheRead", x."cacheWrite", x.reasoning, x.turns, x.sessions
             FROM jsonb_to_recordset($3::jsonb) AS x(tool text, model text, day text, input bigint, output bigint, "cacheRead" bigint, "cacheWrite" bigint, reasoning bigint, turns int, sessions int)
           ON CONFLICT (user_id, device, tool, model, day) DO UPDATE SET
             input_tokens = EXCLUDED.input_tokens, output_tokens = EXCLUDED.output_tokens, cache_read_tokens = EXCLUDED.cache_read_tokens,
             cache_write_tokens = EXCLUDED.cache_write_tokens, reasoning_tokens = EXCLUDED.reasoning_tokens, turns = EXCLUDED.turns,
             sessions = EXCLUDED.sessions, updated_at = now()`,
          [p.id, b.device, JSON.stringify(rows)],
        );
      const linked = await this.attribute(c, p, b.sessions, tasks);
      return { rows: rows.length, linked };
    });
  }

  /**
   * A session that named a task becomes AI help on that task (work's task_ai_assists, through ai.usage.recorded.v1,
   * the same path as the company AI and linked extension conversations): once when first seen, then the tokens added
   * since on later syncs.
   */
  private async attribute(c: PoolClient, p: Principal, sessions: z.infer<typeof SyncBody>["sessions"], tasks: Map<string, string>) {
    let linked = 0;
    for (const s of sessions) {
      const taskId = tasks.get(s.taskCode.toUpperCase());
      if (!taskId) continue;
      const before = (
        await c.query<{ tokens: string; task_id: string }>("SELECT tokens, task_id FROM ai_local_sessions WHERE user_id = $1 AND session_key = $2 FOR UPDATE", [p.id, s.key])
      ).rows[0];
      if (before && before.task_id === taskId && Number(before.tokens) >= s.tokens) continue;
      const added = before && before.task_id === taskId ? s.tokens - Number(before.tokens) : s.tokens;
      await c.query(
        `INSERT INTO ai_local_sessions (user_id, session_key, tool, task_id, tokens, first_at, last_at) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (user_id, session_key) DO UPDATE SET task_id = EXCLUDED.task_id, tokens = EXCLUDED.tokens, last_at = EXCLUDED.last_at`,
        [p.id, s.key, s.tool, taskId, s.tokens, s.firstAt, s.lastAt],
      );
      await appendToOutbox(c, {
        eventId: newId(),
        eventType: "ai.usage.recorded.v1",
        version: 1,
        aggregateType: "ai.usage",
        aggregateId: s.key,
        actorId: `user:${p.id}`,
        occurredAt: new Date().toISOString(),
        // When the session started: work counts a task as AI-assisted only if that came before it was done.
        payload: { usageId: s.key, userId: p.id, feature: s.tool, subjectType: "task", subjectId: taskId, tokens: Math.min(added, 2_000_000_000), at: s.firstAt, source: "local" },
      });
      linked++;
    }
    return linked;
  }

  /**
   * The report: `scope=team` for admins and managers (their reporting line, like the rest of AI Insights), else the
   * caller's own. Includes the company AI's tokens ("company") so the picture is all AI, and the window before for
   * the change.
   */
  @Get("local-usage")
  async report(@Req() req: Request, @Query("days") daysQ?: string, @Query("scope") scope?: string) {
    const p = person(req);
    const days = [7, 30, 90].includes(Number(daysQ)) ? Number(daysQ) : 30;
    const team = scope === "team";
    const people = team ? (await aiAudience(this.d, p)).people : [];
    const ids = team ? people.map((x) => x.userId) : [p.id];
    return withTransaction(this.d.pool, async (c) => {
      const tz = await workspaceTimeZone(c);
      const end = today(tz);
      const range = dayRange(days * 2, end);
      const from = range[0]!;
      const mid = range[days]!;
      const local = (
        await c.query<{ user_id: string; tool: string; model: string; day: string; i: string; o: string; cr: string; cw: string; r: string; turns: number; sessions: number }>(
          `SELECT user_id, tool, model, to_char(day, 'YYYY-MM-DD') AS day, sum(input_tokens) AS i, sum(output_tokens) AS o, sum(cache_read_tokens) AS cr,
                  sum(cache_write_tokens) AS cw, sum(reasoning_tokens) AS r, sum(turns)::int AS turns, sum(sessions)::int AS sessions
             FROM ai_local_usage u WHERE user_id = ANY($1::text[]) AND day >= $2::date AND day <= $3::date AND ${DEMO_DEVICES}
            GROUP BY user_id, tool, model, day`,
          [ids, from, end],
        )
      ).rows;
      const company = (
        await c.query<{ user_id: string; model: string; day: string; i: string; o: string; calls: number; cost: number | null }>(
          `SELECT s.user_id, s.model, to_char((s.hour AT TIME ZONE $4)::date, 'YYYY-MM-DD') AS day, sum(s.input_tokens) AS i, sum(s.output_tokens) AS o,
                  sum(s.calls)::int AS calls, sum(${HOURLY_COST})::float AS cost
             FROM ai_hourly_stats s ${HOURLY_COST_JOIN}
            WHERE s.feature <> '' AND s.user_id = ANY($1::text[]) AND s.hour >= ($2::date::timestamp AT TIME ZONE $4) AND s.hour < (($3::date + 1)::timestamp AT TIME ZONE $4)
            GROUP BY s.user_id, s.model, 3`,
          [ids, from, end, tz],
        )
      ).rows;
      const rows: TokenRow[] = [
        ...local.map((r) => ({
          userId: r.user_id,
          tool: r.tool,
          model: r.model,
          day: r.day,
          input: Number(r.i),
          output: Number(r.o),
          cacheRead: Number(r.cr),
          cacheWrite: Number(r.cw),
          reasoning: Number(r.r),
          turns: r.turns,
          sessions: r.sessions,
        })),
        ...company.map((r) => ({
          userId: r.user_id,
          tool: "company",
          model: r.model || "—",
          day: r.day,
          input: Number(r.i),
          output: Number(r.o),
          cacheRead: 0,
          cacheWrite: 0,
          reasoning: 0,
          turns: r.calls,
          sessions: 0,
          costUsd: r.cost,
        })),
      ];
      const current = rows.filter((r) => r.day >= mid);
      const prev = new Map<string, number>();
      for (const r of rows) if (r.day < mid) prev.set(r.userId, (prev.get(r.userId) ?? 0) + workTokens(r));
      const prices = (
        await c.query<{ model: string; input: string; output: string }>("SELECT model, input_per_mtok AS input, output_per_mtok AS output FROM ai_model_prices")
      ).rows.map((x) => ({ model: x.model, input: Number(x.input), output: Number(x.output) }));
      const report = buildTokenReport(
        current,
        [...prev].map(([userId, total]) => ({ userId, total })),
        days,
        end,
        prices,
      );
      const devices = (
        await c.query<{ user_id: string; device: string; last_sync_at: Date }>(
          `SELECT user_id, device, last_sync_at FROM ai_local_devices u WHERE user_id = ANY($1::text[]) AND ${DEMO_DEVICES} ORDER BY last_sync_at DESC`,
          [ids],
        )
      ).rows;
      const lastSync = new Map<string, Date>();
      for (const x of devices) if (!lastSync.has(x.user_id)) lastSync.set(x.user_id, x.last_sync_at);
      const known = new Map(people.map((x) => [x.userId, x]));
      return {
        scope: team ? "team" : "me",
        timeZone: tz,
        ...report,
        // Everyone in the audience, the ones with nothing yet too (they have no computer connected).
        people: team
          ? [
              ...report.people,
              ...people
                .filter((x) => !report.people.some((r) => r.userId === x.userId))
                .map((x) => ({ userId: x.userId, total: 0, costUsd: 0, listValueUsd: 0, tools: {}, activeDays: 0, previous: 0 })),
            ].map((r) => ({
              ...r,
              displayName: known.get(r.userId)?.displayName ?? "",
              department: known.get(r.userId)?.department ?? null,
              lastSyncAt: lastSync.get(r.userId)?.toISOString() ?? null,
            }))
          : [],
        connected: team ? new Set(devices.map((x) => x.user_id)).size : devices.length,
        // The caller's own computers (to remove one), in either scope.
        devices: devices.filter((x) => x.user_id === p.id).map((x) => ({ device: x.device, lastSyncAt: x.last_sync_at.toISOString() })),
      };
    });
  }

  /** The person removes a computer and everything it sent. */
  @Delete("local-usage/devices/:device")
  @HttpCode(204)
  async removeDevice(@Req() req: Request, @Param("device") device: string) {
    const p = person(req);
    if (!device || device.length > 80) throw new BadRequestException("device");
    await withTransaction(this.d.pool, async (c) => {
      await c.query("DELETE FROM ai_local_usage WHERE user_id = $1 AND device = $2", [p.id, device]);
      await c.query("DELETE FROM ai_local_devices WHERE user_id = $1 AND device = $2", [p.id, device]);
    });
  }
}
