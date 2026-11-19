import { BadRequestException, Body, Controller, Get, HttpCode, Inject, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { withTransaction } from "@workspace/shared";
import { assertAllowed, parse, requirePrincipal } from "@workspace/service-kit";
import { POOL } from "../common.js";
import { trail } from "./trail.js";

/** Keyset cursor over (at, id), newest first; opaque to clients. */
export const encodeCursor = (at: Date | string, id: string) => Buffer.from(JSON.stringify([new Date(at).toISOString(), id])).toString("base64url");

export function decodeCursor(s: string): { at: string; id: string } {
  try {
    const [at, id] = JSON.parse(Buffer.from(s, "base64url").toString()) as [string, string];
    if (typeof at !== "string" || typeof id !== "string" || Number.isNaN(Date.parse(at))) throw new Error();
    return { at, id };
  } catch {
    throw new BadRequestException("bad cursor");
  }
}

const slug = z.string().regex(/^[a-z_.]{1,80}$/);

export const trailQuery = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  /** A user, agent or API key id (`actorType` narrows it when ids could collide). */
  actor: z.string().min(1).max(64).optional(),
  actorType: z.enum(["user", "agent", "apikey", "system", "anonymous"]).optional(),
  module: z.enum(["identity", "platform", "chat", "work", "employee", "ai", "home", "gateway"]).optional(),
  /** An exact action or a prefix ending in "." ("work.task."). */
  action: slug.optional(),
  targetType: slug.optional(),
  targetId: z.string().min(1).max(200).optional(),
  /** A code, title, email or channel name, or an id: matches the target's id exactly or its label in part. */
  q: z.string().trim().min(1).max(100).optional(),
  requestId: z
    .string()
    .regex(/^[\w-]{8,64}$/)
    .optional(),
  outcome: z.enum(["success", "failure", "denied"]).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(50),
  /** "export": the CSV download reads page after page; its first page is recorded as an export, not a view. */
  purpose: z.enum(["view", "export"]).default("view"),
});
export type TrailQuery = z.infer<typeof trailQuery>;

/** WHERE clause and parameters for a filter (the cursor is added by the caller). */
export function trailWhere(q: TrailQuery): { sql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: (n: string) => string, v: unknown) => {
    params.push(v);
    where.push(sql(`$${params.length}`));
  };
  if (q.from) add((n) => `at >= ${n}::timestamptz`, q.from);
  if (q.to) add((n) => `at < ${n}::timestamptz`, q.to);
  if (q.actor) add((n) => `actor_id = ${n}`, q.actor);
  if (q.actorType) add((n) => `actor_type = ${n}`, q.actorType);
  if (q.module) add((n) => `module = ${n}`, q.module);
  if (q.action) {
    if (q.action.endsWith(".")) add((n) => `action LIKE ${n} || '%'`, q.action);
    else add((n) => `action = ${n}`, q.action);
  }
  if (q.targetType) add((n) => `target_type = ${n}`, q.targetType);
  if (q.targetId) add((n) => `target_id = ${n}`, q.targetId);
  if (q.q) {
    const like = `%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    params.push(q.q, like);
    where.push(`(target_id = $${params.length - 1} OR target_label ILIKE $${params.length})`);
  }
  if (q.requestId) add((n) => `request_id = ${n}`, q.requestId);
  if (q.outcome) add((n) => `outcome = ${n}`, q.outcome);
  return { sql: where.length ? where.join(" AND ") : "true", params };
}

interface Row {
  id: string;
  at: Date;
  actorType: string;
  actorId: string;
  via: string | null;
  ip: string | null;
  userAgent: string | null;
  module: string;
  action: string;
  targetType: string;
  targetId: string;
  targetLabel: string | null;
  outcome: string;
  requestId: string | null;
  changes: Record<string, unknown>;
  meta: Record<string, unknown>;
}

const COLUMNS = `id, at, actor_type AS "actorType", actor_id AS "actorId", via, ip, user_agent AS "userAgent", module, action,
  target_type AS "targetType", target_id AS "targetId", target_label AS "targetLabel", outcome, request_id AS "requestId", changes, meta`;

/** Actions the web app records for itself (CSV exports it builds); anything else is refused. */
const WEB_RECORDED = new Set(["work.project.exported", "employee.attendance.exported", "work.tasks.exported"]);

/**
 * The audit trail (ADR 0025): who did what across the workspace, for holders of `audit.read`. Reading it is itself
 * recorded (a view at most once per ten minutes per person, every export).
 */
@Controller("audit")
export class AuditController {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  @Get()
  async list(@Req() req: Request, @Query() query: Record<string, string>) {
    const p = requirePrincipal(req);
    assertAllowed(p, "audit.read");
    const q = parse(trailQuery, query);
    const { sql, params } = trailWhere(q);
    const cur = q.cursor ? decodeCursor(q.cursor) : null;
    const all = [...params];
    let keyset = "";
    if (cur) {
      all.push(cur.at, cur.id);
      keyset = ` AND (at, id) < ($${all.length - 1}::timestamptz, $${all.length})`;
    }
    all.push(q.limit + 1);
    return withTransaction(this.pool, async (c) => {
      const rows = (await c.query<Row>(`SELECT ${COLUMNS} FROM audit_trail WHERE ${sql}${keyset} ORDER BY at DESC, id DESC LIMIT $${all.length}`, all)).rows;
      const more = rows.length > q.limit;
      const entries = more ? rows.slice(0, q.limit) : rows;
      const last = entries.at(-1);
      if (!cur) {
        const filter = Object.fromEntries(Object.entries(q).filter(([k, v]) => v !== undefined && !["cursor", "limit", "purpose"].includes(k)));
        await trail(c, {
          action: q.purpose === "export" ? "platform.audit.exported" : "platform.audit.viewed",
          targetType: "audit_trail",
          targetId: "workspace",
          meta: { filter },
          ...(q.purpose === "export" ? {} : { coalesceMinutes: 10 }),
        });
      }
      return { entries, next: more && last ? encodeCursor(last.at, last.id) : null };
    });
  }

  /** Totals for the filter's period: entries, distinct actors, failed or refused actions, and entries per module. */
  @Get("stats")
  async stats(@Req() req: Request, @Query() query: Record<string, string>) {
    const p = requirePrincipal(req);
    assertAllowed(p, "audit.read");
    const q = parse(trailQuery, query);
    const { sql, params } = trailWhere(q);
    const [totals, modules] = await Promise.all([
      this.pool.query<{ total: number; actors: number; failures: number }>(
        `SELECT count(*)::int AS total, count(DISTINCT actor_id) FILTER (WHERE actor_type IN ('user','agent','apikey'))::int AS actors,
                count(*) FILTER (WHERE outcome <> 'success')::int AS failures
           FROM audit_trail WHERE ${sql}`,
        params,
      ),
      this.pool.query<{ module: string; n: number }>(`SELECT module, count(*)::int AS n FROM audit_trail WHERE ${sql} GROUP BY module ORDER BY n DESC`, params),
    ]);
    return { ...totals.rows[0]!, modules: modules.rows };
  }

  /** The web app records the CSV exports it builds itself (project tasks, attendance), as the signed-in person. */
  @Post("record")
  @HttpCode(204)
  async record(@Req() req: Request, @Body() body: unknown) {
    requirePrincipal(req);
    const b = parse(
      z.object({
        action: z.string().refine((a) => WEB_RECORDED.has(a), "not an action the web app records"),
        targetType: slug,
        targetId: z.string().min(1).max(200),
        targetLabel: z.string().max(300).nullish(),
        meta: z.record(z.unknown()).optional(),
      }),
      body,
    );
    await withTransaction(this.pool, (c) => trail(c, { action: b.action, targetType: b.targetType, targetId: b.targetId, targetLabel: b.targetLabel ?? null, meta: b.meta ?? {} }));
  }
}
