import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Inject, NotFoundException, Param, Patch, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { appendToOutbox, authorize, getRequestContext, newId, withTransaction, type Principal } from "@workspace/shared";
import { assertAllowed, parse, requirePrincipal } from "@workspace/service-kit";
import { POOL } from "./http/common.js";
import type { EventPayloadInput, EventType } from "@workspace/contracts";

const CATEGORIES = ["general", "event", "policy", "learning", "wellness", "celebration", "program"] as const;
const iso = z.string().datetime({ offset: true });
const fields = {
  title: z.string().trim().min(1).max(200),
  body: z.string().max(20000),
  category: z.enum(CATEGORIES),
  departmentIds: z.array(z.string()).max(100),
  pinned: z.boolean(),
  eventAt: iso.nullable(),
  linkUrl: z
    .string()
    .url()
    .max(1000)
    .refine((u) => u.startsWith("https://"), "link must be https")
    .nullable(),
  publishAt: iso.nullable(),
  expiresAt: iso.nullable(),
};

const COLS = `a.id, a.title, a.body, a.category, a.author_id AS "authorId", a.department_ids AS "departmentIds", a.pinned,
  a.event_at AS "eventAt", a.link_url AS "linkUrl", a.publish_at AS "publishAt", a.expires_at AS "expiresAt", a.created_at AS "createdAt", a.updated_at AS "updatedAt"`;

/**
 * Company announcements. Publishers need announcement.publish;
 * everyone reads what targets them (everyone, or their department). Read receipts let HR see reach.
 */
@Controller("announcements")
export class AnnouncementsController {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  private canPublish(p: Principal) {
    return authorize(p, "announcement.publish").allowed;
  }

  private async myDepartment(c: PoolClient, userId: string): Promise<string | null> {
    return (await c.query<{ department_id: string | null }>("SELECT department_id FROM employees WHERE user_id = $1", [userId])).rows[0]?.department_id ?? null;
  }

  /** Feed for the caller: live, targeted at them; pinned first. `all=1` (publishers) also shows scheduled and expired ones. */
  @Get()
  async list(@Req() req: Request, @Query("limit") limit?: string, @Query("all") all?: string, @Query("category") category?: string) {
    const p = requirePrincipal(req);
    const manage = all === "1" && this.canPublish(p);
    return withTransaction(this.pool, async (c) => {
      const dept = await this.myDepartment(c, p.id);
      const rows = (
        await c.query(
          `SELECT ${COLS}, r.read_at AS "readAt",
                (SELECT count(*)::int FROM announcement_reads x WHERE x.announcement_id = a.id) AS "readCount"
           FROM announcements a LEFT JOIN announcement_reads r ON r.announcement_id = a.id AND r.user_id = $1
          WHERE a.deleted_at IS NULL
            AND ($2 OR (a.publish_at <= now() AND (a.expires_at IS NULL OR a.expires_at > now())
                        AND (cardinality(a.department_ids) = 0 OR $3::text = ANY (a.department_ids))))
            AND ($5::text IS NULL OR a.category = $5)
          ORDER BY (a.pinned AND (a.expires_at IS NULL OR a.expires_at > now())) DESC, a.publish_at DESC
          LIMIT $4`,
          [p.id, manage, dept, Math.min(Math.max(Number(limit) || 20, 1), 100), category && (CATEGORIES as readonly string[]).includes(category) ? category : null],
        )
      ).rows;
      const unread = (
        await c.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM announcements a WHERE a.deleted_at IS NULL AND a.publish_at <= now() AND (a.expires_at IS NULL OR a.expires_at > now())
            AND (cardinality(a.department_ids) = 0 OR $2::text = ANY (a.department_ids))
            AND NOT EXISTS (SELECT 1 FROM announcement_reads r WHERE r.announcement_id = a.id AND r.user_id = $1)`,
          [p.id, dept],
        )
      ).rows[0]!.n;
      // Reach numbers are for publishers only.
      return { announcements: rows.map((r) => (this.canPublish(p) ? r : { ...r, readCount: undefined })), unread, canPublish: this.canPublish(p) };
    });
  }

  @Get(":id")
  async get(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    return withTransaction(this.pool, async (c) => {
      const dept = await this.myDepartment(c, p.id);
      const a = (await c.query(`SELECT ${COLS} FROM announcements a WHERE a.id = $1 AND a.deleted_at IS NULL`, [id])).rows[0] as
        { departmentIds: string[]; publishAt: Date } | undefined;
      const visible = a && (this.canPublish(p) || ((a.departmentIds.length === 0 || (dept !== null && a.departmentIds.includes(dept))) && a.publishAt <= new Date()));
      if (!visible) throw new NotFoundException("announcement not found");
      return a;
    });
  }

  @Post()
  async create(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "announcement.publish");
    const b = parse(
      z.object({
        title: fields.title,
        body: fields.body.default(""),
        category: fields.category.default("general"),
        departmentIds: fields.departmentIds.default([]),
        pinned: fields.pinned.default(false),
        eventAt: fields.eventAt.default(null),
        linkUrl: fields.linkUrl.default(null),
        publishAt: fields.publishAt.default(null),
        expiresAt: fields.expiresAt.default(null),
      }),
      body,
    );
    if (b.category === "event" && !b.eventAt) throw new BadRequestException("an event needs eventAt");
    return withTransaction(this.pool, async (c) => {
      const id = newId();
      await c.query(
        `INSERT INTO announcements (id, title, body, category, author_id, department_ids, pinned, event_at, link_url, publish_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,coalesce($10::timestamptz, now()),$11)`,
        [id, b.title, b.body, b.category, p.id, b.departmentIds, b.pinned, b.eventAt, b.linkUrl, b.publishAt, b.expiresAt],
      );
      // Published now: everyone it targets gets a notification (Home does not show announcements).
      const now = !b.publishAt || Date.parse(b.publishAt) <= Date.now();
      const recipients = now
        ? (
            await c.query<{ user_id: string }>(
              "SELECT user_id FROM employees WHERE active AND user_id <> $1 AND (cardinality($2::text[]) = 0 OR department_id = ANY ($2::text[]))",
              [p.id, b.departmentIds],
            )
          ).rows.map((r) => r.user_id)
        : undefined;
      await emit(c, "employee.announcement.published.v1", id, {
        announcementId: id,
        title: b.title,
        category: b.category,
        authorId: p.id,
        departmentIds: b.departmentIds,
        publishAt: b.publishAt ?? new Date().toISOString(),
        eventAt: b.eventAt,
        ...(recipients ? { recipients } : {}),
      });
      return { id };
    });
  }

  @Patch(":id")
  async update(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "announcement.publish");
    const b = parse(
      z.object({
        title: fields.title.optional(),
        body: fields.body.optional(),
        category: fields.category.optional(),
        departmentIds: fields.departmentIds.optional(),
        pinned: fields.pinned.optional(),
        eventAt: fields.eventAt.optional(),
        linkUrl: fields.linkUrl.optional(),
        expiresAt: fields.expiresAt.optional(),
      }),
      body,
    );
    return withTransaction(this.pool, async (c) => {
      const r = await c.query(
        `UPDATE announcements SET title = coalesce($2, title), body = coalesce($3, body), category = coalesce($4, category),
                department_ids = coalesce($5, department_ids), pinned = coalesce($6, pinned),
                event_at = CASE WHEN $7 THEN $8::timestamptz ELSE event_at END, link_url = CASE WHEN $9 THEN $10 ELSE link_url END,
                expires_at = CASE WHEN $11 THEN $12::timestamptz ELSE expires_at END, updated_at = now()
          WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
        [
          id,
          b.title ?? null,
          b.body ?? null,
          b.category ?? null,
          b.departmentIds ?? null,
          b.pinned ?? null,
          b.eventAt !== undefined,
          b.eventAt ?? null,
          b.linkUrl !== undefined,
          b.linkUrl ?? null,
          b.expiresAt !== undefined,
          b.expiresAt ?? null,
        ],
      );
      if (!r.rowCount) throw new NotFoundException("announcement not found");
      return { id };
    });
  }

  @Delete(":id")
  @HttpCode(204)
  async remove(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "announcement.publish");
    await withTransaction(this.pool, async (c) => {
      const r = await c.query("UPDATE announcements SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL", [id]);
      if (!r.rowCount) throw new NotFoundException("announcement not found");
      await emit(c, "employee.announcement.deleted.v1", id, { announcementId: id });
    });
  }

  @Post(":id/read")
  @HttpCode(204)
  async read(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    await withTransaction(this.pool, async (c) => {
      const exists = await c.query("SELECT 1 FROM announcements WHERE id = $1 AND deleted_at IS NULL", [id]);
      if (!exists.rowCount) throw new NotFoundException("announcement not found");
      await c.query("INSERT INTO announcement_reads (announcement_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [id, p.id]);
    });
  }
}

async function emit<T extends EventType>(c: PoolClient, eventType: T, id: string, payload: EventPayloadInput<T>) {
  const { actorId } = getRequestContext();
  await appendToOutbox(c, {
    eventId: newId(),
    eventType,
    version: 1,
    aggregateType: "employee.announcement",
    aggregateId: id,
    actorId,
    occurredAt: new Date().toISOString(),
    payload,
  });
}
