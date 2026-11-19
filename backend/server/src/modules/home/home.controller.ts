import { createHash } from "node:crypto";
import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpCode, Inject, Param, Post, Put, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { authorize, isTimeZone, newId, withTransaction, WORKSPACE_TZ_SQL } from "@workspace/shared";
import { assertAllowed, logger, parse, requirePrincipal, ServiceCallError, type ServiceClient } from "@workspace/service-kit";
import { MUTE_GROUPS } from "./digest.js";
import { isLocale, texts, textsFor } from "./texts.js";
import { groupsOf, NOTIFICATION_COLS, present, type LiveDue, type NotificationRow } from "./notifications.js";

/** A person's zone: their own choice, else the workspace's (SQL on user_prefs). */
const PERSON_TZ = `coalesce(timezone, ${WORKSPACE_TZ_SQL})`;
/** A new person's language until they pick one: the workspace's (Admin › Settings), not a hard-coded Vietnamese. */
const WORKSPACE_LOCALE_SQL = "coalesce((SELECT locale FROM workspace_settings LIMIT 1), 'vi')";
/** The zone of the person in $1 from outside user_prefs (no row yet, or a NULL timezone: the workspace's). */
const USER_TZ_SQL = `coalesce((SELECT timezone FROM user_prefs WHERE user_id = $1), ${WORKSPACE_TZ_SQL})`;

export const POOL = Symbol("POOL");
export const AI = Symbol("AI");

/** AI part of the brief, or why it is missing. */
export type AiBrief = { status: "ready"; recommendation: string; digest: { channel: string; lines: string[] }[] } | { status: "unavailable" | "quota_exceeded" | "failed" };

/** Decoded length of a base64url string (push subscription keys: p256dh is 65 bytes, auth 16). */
const b64urlBytes = (k: string) => (/^[A-Za-z0-9_-]+={0,2}$/.test(k) ? Buffer.from(k, "base64url").length : -1);

@Controller()
export class HomeController {
  constructor(
    @Inject(POOL) private readonly pool: Pool,
    @Inject(AI) private readonly ai: ServiceClient | null,
  ) {}

  @Get("health")
  health() {
    return { ok: true };
  }

  /** People's chosen languages, for emails other modules send (the ai module's weekly report). Services only. */
  @Get("internal/locales")
  async locales(@Req() req: Request, @Query("ids") ids = "") {
    const p = requirePrincipal(req);
    if (p.type !== "service" || !authorize(p, "principal.resolve").allowed) throw new ForbiddenException("platform service required");
    const list = ids.split(",").filter(Boolean).slice(0, 500);
    return withTransaction(this.pool, async (c) => ({
      locales: Object.fromEntries(
        (await c.query<{ user_id: string; locale: string }>("SELECT user_id, locale FROM user_prefs WHERE user_id = ANY($1::text[]) AND locale IS NOT NULL", [list])).rows.map(
          (r) => [r.user_id, r.locale],
        ),
      ),
    }));
  }

  /**
   * One UI-shaped read for the Home screen: numbers, Needs You, Today and the inbox badge. No AI call on this
   * path: the AI line loads separately (home/brief).
   */
  @Get("home")
  async home(@Req() req: Request) {
    const p = requirePrincipal(req);
    assertAllowed(p, "home.read", { ownerId: p.id });
    return withTransaction(this.pool, async (c) => {
      await c.query(`INSERT INTO user_prefs (user_id, locale) VALUES ($1, ${WORKSPACE_LOCALE_SQL}) ON CONFLICT DO NOTHING`, [p.id]);
      // Remember the UI language so notices, push and the digest written later use it.
      const locale = req.headers["x-locale"];
      if (isLocale(locale)) await c.query("UPDATE user_prefs SET locale = $2 WHERE user_id = $1 AND locale IS DISTINCT FROM $2", [p.id, locale]);
      const tz = (await c.query<{ timezone: string }>(`SELECT ${PERSON_TZ} AS timezone FROM user_prefs WHERE user_id = $1`, [p.id])).rows[0]!.timezone;
      const needsYou = (
        await c.query(
          `SELECT kind, ref_id AS "refId", title, subtitle, url, due_at AS "dueAt", priority
           FROM home_items WHERE user_id = $1 AND needs_action AND resolved_at IS NULL
          ORDER BY CASE kind WHEN 'approval' THEN 0 WHEN 'decision' THEN 1 WHEN 'blocker' THEN 2 WHEN 'mention' THEN 3 WHEN 'dm' THEN 4 ELSE 5 END,
                   CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END, due_at NULLS LAST, updated_at DESC
          LIMIT 20`,
          [p.id],
        )
      ).rows;
      const today = (
        await c.query(
          `SELECT kind, ref_id AS "refId", title, subtitle, url, coalesce(starts_at, due_at) AS at
           FROM home_items WHERE user_id = $1 AND resolved_at IS NULL
            AND (coalesce(starts_at, due_at) AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date ORDER BY at LIMIT 20`,
          [p.id, tz],
        )
      ).rows;
      const counts = (
        await c.query(
          `SELECT count(*) FILTER (WHERE kind = 'task' AND needs_action)::int AS tasks,
                count(*) FILTER (WHERE kind = 'approval')::int AS approvals,
                count(*) FILTER (WHERE kind = 'meeting' AND (starts_at AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date)::int AS meetings,
                count(*) FILTER (WHERE kind = 'task' AND due_at < now())::int AS overdue,
                count(*) FILTER (WHERE kind = 'decision' AND needs_action)::int AS decisions,
                count(*) FILTER (WHERE kind = 'blocker' AND needs_action)::int AS blockers
           FROM home_items WHERE user_id = $1 AND resolved_at IS NULL`,
          [p.id, tz],
        )
      ).rows[0];
      const inbox = (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND grp = 'action' AND read_at IS NULL", [p.id])).rows[0]!.n;
      return { counts, needsYou, today, inboxActionCount: inbox, timezone: tz, generatedAt: new Date().toISOString() };
    });
  }

  /**
   * Lazy AI brief. Cached per user and day, but only while the work it was written from is the same: the cache
   * stores a fingerprint of the context (needs-you items, today's items, language) and a change regenerates it.
   */
  @Post("home/brief")
  async brief(@Req() req: Request): Promise<AiBrief> {
    const p = requirePrincipal(req);
    const locale = req.headers["x-locale"] === "vi" ? "vi" : "en";
    try {
      const context = await withTransaction(this.pool, async (c) => ({
        needsYou: (
          await c.query(
            `SELECT kind, title, subtitle, due_at AS "dueAt", priority FROM home_items WHERE user_id = $1 AND needs_action AND resolved_at IS NULL ORDER BY due_at NULLS LAST LIMIT 15`,
            [p.id],
          )
        ).rows,
        today: (
          await c.query(
            `SELECT kind, title, coalesce(starts_at, due_at) AS at FROM home_items WHERE user_id = $1 AND resolved_at IS NULL AND (coalesce(starts_at, due_at) AT TIME ZONE ${USER_TZ_SQL})::date = (now() AT TIME ZONE ${USER_TZ_SQL})::date ORDER BY at LIMIT 10`,
            [p.id],
          )
        ).rows,
      }));
      const fingerprint = createHash("sha256")
        .update(JSON.stringify({ locale, needs: context.needsYou.map((i) => [i.kind, i.title, i.dueAt]), today: context.today.map((i) => [i.kind, i.title, i.at]) }))
        .digest("hex")
        .slice(0, 16);
      const cached = await withTransaction(
        this.pool,
        async (c) =>
          (
            await c.query<{ content: AiBrief & { fingerprint?: string } }>(
              `SELECT content FROM brief_cache b JOIN user_prefs u ON u.user_id = b.user_id
          WHERE b.user_id = $1 AND b.day = (now() AT TIME ZONE coalesce(u.timezone, ${WORKSPACE_TZ_SQL}))::date`,
              [p.id],
            )
          ).rows[0]?.content,
      );
      if (cached && cached.fingerprint === fingerprint) {
        const { fingerprint: _f, ...rest } = cached;
        return rest;
      }
      if (!this.ai) return { status: "unavailable" };
      const r = await this.ai.request<{ recommendation: string; digest: { channel: string; lines: string[] }[] }>("POST", "/internal/brief", { ...context, locale }, p);
      const content: AiBrief = { status: "ready", recommendation: r.recommendation, digest: r.digest };
      await withTransaction(this.pool, (c) =>
        c.query(
          `INSERT INTO brief_cache (user_id, day, content)
         SELECT $1, (now() AT TIME ZONE ${PERSON_TZ})::date, $2 FROM user_prefs WHERE user_id = $1
         ON CONFLICT (user_id, day) DO UPDATE SET content = EXCLUDED.content`,
          [p.id, JSON.stringify({ ...content, fingerprint })],
        ),
      );
      return content;
    } catch (e) {
      // A monthly AI budget ran out (429 ai_budget_exceeded): Home says so instead of "failed".
      if (e instanceof ServiceCallError && e.status === 429) return { status: "quota_exceeded" };
      // No AI provider configured: not a failure, the web hides the brief.
      if (e instanceof ServiceCallError && e.status === 503) return { status: "unavailable" };
      logger.warn({ err: e }, "AI brief failed");
      return { status: "failed" };
    }
  }

  /**
   * "AI did while you were away": what happened since the user last marked everything as read (or the last 3
   * days), excluding their own actions.
   */
  @Get("home/away")
  async away(@Req() req: Request) {
    const p = requirePrincipal(req);
    assertAllowed(p, "home.read", { ownerId: p.id });
    return withTransaction(this.pool, async (c) => {
      const since = (
        await c.query<{ since: Date }>(
          `SELECT greatest(coalesce(max(caught_up_at), now() - interval '3 days'), now() - interval '14 days') AS since FROM user_prefs WHERE user_id = $1`,
          [p.id],
        )
      ).rows[0]!.since;
      const items = (
        await c.query(
          `SELECT key, kind, title, body, url, actor_id AS "actorId", count, created_at AS "at", user_id = '*' AS shared FROM activity
          WHERE user_id IN ($1, '*') AND created_at > $2 AND actor_id NOT IN ($3, $4)
          ORDER BY created_at DESC LIMIT 40`,
          [p.id, since, `user:${p.id}`, p.id],
        )
      ).rows;
      // Workspace-wide decision lines hold the bare title (older rows already carry the Vietnamese prefix).
      const asked = req.headers["x-locale"];
      const t = isLocale(asked) ? texts(asked) : await textsFor(c, p.id);
      for (const it of items) {
        if (it.shared && it.kind === "decision" && !/^(Đã chốt|Decided): /.test(it.title)) it.title = t.decided(it.title);
        delete it.shared;
      }
      return { since, items };
    });
  }

  @Post("home/caught-up")
  @HttpCode(204)
  async caughtUp(@Req() req: Request) {
    const p = requirePrincipal(req);
    await withTransaction(this.pool, async (c) => {
      await c.query("UPDATE home_items SET resolved_at = now(), needs_action = false WHERE user_id = $1 AND kind IN ('mention') AND resolved_at IS NULL", [p.id]);
      await c.query("UPDATE user_prefs SET caught_up_at = now() WHERE user_id = $1", [p.id]);
    });
  }

  // ---- "Nhắc tôi": personal reminders (a chat message, a task) at a chosen time ----
  @Post("reminders")
  async remind(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const r = z
      .object({
        at: z.string().datetime({ offset: true }),
        title: z.string().trim().min(1).max(300),
        // Only places inside the app: a reminder never links anywhere else.
        url: z
          .string()
          .max(500)
          .regex(/^\/app\/[^\s]*$/),
      })
      .safeParse(body);
    if (!r.success) throw new BadRequestException("invalid reminder");
    const at = Date.parse(r.data.at);
    if (at < Date.now() - 60_000 || at > Date.now() + 366 * 86400_000) throw new BadRequestException("pick a time within the next year");
    const id = newId();
    await withTransaction(this.pool, (c) =>
      c.query("INSERT INTO reminders (id, user_id, remind_at, title, url) VALUES ($1,$2,$3,$4,$5)", [id, p.id, r.data.at, r.data.title, r.data.url]),
    );
    return { id, at: r.data.at };
  }

  @Get("reminders")
  async reminders(@Req() req: Request) {
    const p = requirePrincipal(req);
    return withTransaction(this.pool, async (c) => ({
      reminders: (await c.query(`SELECT id, remind_at AS "at", title, url FROM reminders WHERE user_id = $1 AND sent_at IS NULL ORDER BY remind_at LIMIT 100`, [p.id])).rows,
    }));
  }

  @Delete("reminders/:id")
  @HttpCode(204)
  async cancelReminder(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    await withTransaction(this.pool, (c) => c.query("DELETE FROM reminders WHERE id = $1 AND user_id = $2 AND sent_at IS NULL", [id, p.id]));
  }

  // ---- notification inbox ----
  @Get("notifications")
  async notifications(@Req() req: Request, @Query("count") count?: string) {
    const p = requirePrincipal(req);
    return withTransaction(this.pool, async (c) => {
      // In the language the reader uses now (the web app sends it); without one, the language they last used.
      const asked = req.headers["x-locale"];
      const t = isLocale(asked) ? texts(asked) : await textsFor(c, p.id);
      // `?count=1`: the top bar's dot polls this every minute; one indexed count, not the inbox payload. The count
      // covers every unread action item, not only the first 100 rows of the list.
      if (count === "1") {
        const n = (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND grp = 'action' AND read_at IS NULL", [p.id])).rows[0]!.n;
        return { badge: n, fetchedAt: new Date().toISOString() };
      }
      const raw = (await c.query<NotificationRow>(`SELECT ${NOTIFICATION_COLS} FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`, [p.id])).rows;
      // Due-soon notices say the task's due time as it is now (it may have moved, or passed), in the reader's zone.
      const dueIds = [...new Set(raw.filter((r) => r.kind === "task.due" && r.refId).map((r) => r.refId!))];
      const live = new Map<string, LiveDue>();
      if (dueIds.length)
        for (const h of (
          await c.query<{ ref_id: string; due_at: Date | null; resolved: boolean; tz: string }>(
            `SELECT h.ref_id, h.due_at, h.resolved_at IS NOT NULL AS resolved, ${USER_TZ_SQL} AS tz FROM home_items h WHERE h.user_id = $1 AND h.kind = 'task' AND h.ref_id = ANY($2)`,
            [p.id, dueIds],
          )
        ).rows)
          live.set(h.ref_id, { due: h.due_at ? { at: h.due_at.toISOString(), tz: h.tz } : null, done: h.resolved });
      const rows = raw.map((r) => present(t, r, live));
      // Pinned "Daily Brief hôm nay": computed live, so it exists even without push.
      const n = (
        await c.query<{ tasks: number; approvals: number; meetings: number }>(
          `SELECT count(*) FILTER (WHERE kind = 'task' AND needs_action)::int AS tasks, count(*) FILTER (WHERE kind = 'approval')::int AS approvals,
                count(*) FILTER (WHERE kind = 'meeting' AND (starts_at AT TIME ZONE ${USER_TZ_SQL})::date = (now() AT TIME ZONE ${USER_TZ_SQL})::date)::int AS meetings
           FROM home_items WHERE user_id = $1 AND resolved_at IS NULL`,
          [p.id],
        )
      ).rows[0]!;
      return {
        pinnedBrief: { title: t.briefTitle, body: t.dayCounts(n.tasks, n.meetings, n.approvals), url: "/app/home" },
        action: rows.filter((r) => r.grp === "action" && r.kind !== "daily_brief"),
        updates: rows.filter((r) => r.grp === "update" && r.kind !== "daily_brief"),
        groups: groupsOf(rows.filter((r) => r.kind !== "daily_brief")),
        badge: (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND grp = 'action' AND read_at IS NULL", [p.id])).rows[0]!.n,
        fetchedAt: new Date().toISOString(),
      };
    });
  }

  @Post("notifications/:id/read")
  @HttpCode(204)
  async read(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    await withTransaction(this.pool, (c) => c.query("UPDATE notifications SET read_at = now() WHERE user_id = $1 AND id = $2 AND read_at IS NULL", [p.id, id]));
  }

  /** Marks every unread notice of one group read ("8 approvals waiting" › Mark read). */
  @Post("notifications/read-group")
  @HttpCode(204)
  async readGroup(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const key = typeof (body as { key?: unknown } | null)?.key === "string" ? (body as { key: string }).key.slice(0, 200) : "";
    if (!key) throw new BadRequestException("key required");
    await withTransaction(this.pool, (c) => c.query("UPDATE notifications SET read_at = now() WHERE user_id = $1 AND group_key = $2 AND read_at IS NULL", [p.id, key]));
  }

  @Post("notifications/read-all")
  @HttpCode(204)
  async readAll(@Req() req: Request) {
    const p = requirePrincipal(req);
    await withTransaction(this.pool, (c) => c.query("UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL", [p.id]));
  }

  // ---- web push (the client asks for permission only after the in-app prompt) ----
  @Post("push/subscriptions")
  @HttpCode(204)
  async subscribe(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(
      z.object({
        endpoint: z.string().url().max(1000),
        keys: z.object({
          p256dh: z.string().refine((k) => b64urlBytes(k) === 65, "p256dh must be a 65-byte P-256 key"),
          auth: z.string().refine((k) => b64urlBytes(k) === 16, "auth must be 16 bytes"),
        }),
      }),
      body,
    );
    if (!b.endpoint.startsWith("https://")) throw new BadRequestException("push endpoint must be https");
    await withTransaction(this.pool, async (c) => {
      await c.query(`INSERT INTO user_prefs (user_id, locale) VALUES ($1, ${WORKSPACE_LOCALE_SQL}) ON CONFLICT DO NOTHING`, [p.id]);
      await c.query(
        `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1,$2,$3,$4)
         ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
        [p.id, b.endpoint, b.keys.p256dh, b.keys.auth],
      );
    });
  }

  @Delete("push/subscriptions")
  @HttpCode(204)
  async unsubscribe(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(z.object({ endpoint: z.string().url() }), body);
    await withTransaction(this.pool, (c) => c.query("DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2", [p.id, b.endpoint]));
  }

  @Get("prefs")
  async getPrefs(@Req() req: Request) {
    const p = requirePrincipal(req);
    return withTransaction(this.pool, async (c) => {
      await c.query(`INSERT INTO user_prefs (user_id, locale) VALUES ($1, ${WORKSPACE_LOCALE_SQL}) ON CONFLICT DO NOTHING`, [p.id]);
      return (
        await c.query(
          `SELECT push_enabled AS "pushEnabled", quick_actions AS "quickActions", timezone, ${WORKSPACE_TZ_SQL} AS "workspaceTimezone", email_digest AS "emailDigest", digest_hour AS "digestHour", muted,
          quiet_start AS "quietStart", quiet_end AS "quietEnd", (email IS NOT NULL) AS "hasEmail" FROM user_prefs WHERE user_id = $1`,
          [p.id],
        )
      ).rows[0];
    });
  }

  @Put("prefs")
  async prefs(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const hour = z.number().int().min(0).max(23);
    const b = parse(
      z.object({
        pushEnabled: z.boolean().optional(),
        // Buttons on pushes about a waiting agent run (work/quick-actions.ts); off unless the person turns it on.
        quickActions: z.boolean().optional(),
        // null: follow the workspace's zone.
        timezone: z.string().min(3).max(64).nullable().optional(),
        emailDigest: z.boolean().optional(),
        digestHour: hour.optional(),
        muted: z
          .array(z.enum(Object.keys(MUTE_GROUPS) as [string, ...string[]]))
          .max(20)
          .optional(),
        quietStart: hour.nullable().optional(),
        quietEnd: hour.nullable().optional(),
      }),
      body,
    );
    if (b.timezone && !isTimeZone(b.timezone)) throw new BadRequestException("unknown timezone");
    return withTransaction(this.pool, async (c) => {
      await c.query(`INSERT INTO user_prefs (user_id, locale) VALUES ($1, ${WORKSPACE_LOCALE_SQL}) ON CONFLICT DO NOTHING`, [p.id]);
      await c.query(
        `UPDATE user_prefs SET push_enabled = coalesce($2, push_enabled), timezone = CASE WHEN $11 THEN $3 ELSE timezone END, email_digest = coalesce($4, email_digest),
          digest_hour = coalesce($5, digest_hour), muted = coalesce($6, muted),
          quiet_start = CASE WHEN $7 THEN $8 ELSE quiet_start END, quiet_end = CASE WHEN $9 THEN $10 ELSE quiet_end END,
          quick_actions = coalesce($12, quick_actions) WHERE user_id = $1`,
        [
          p.id,
          b.pushEnabled ?? null,
          b.timezone ?? null,
          b.emailDigest ?? null,
          b.digestHour ?? null,
          b.muted ?? null,
          b.quietStart !== undefined,
          b.quietStart ?? null,
          b.quietEnd !== undefined,
          b.quietEnd ?? null,
          b.timezone !== undefined,
          b.quickActions ?? null,
        ],
      );
      return (
        await c.query(
          `SELECT push_enabled AS "pushEnabled", quick_actions AS "quickActions", timezone, ${WORKSPACE_TZ_SQL} AS "workspaceTimezone", email_digest AS "emailDigest", digest_hour AS "digestHour", muted, quiet_start AS "quietStart", quiet_end AS "quietEnd" FROM user_prefs WHERE user_id = $1`,
          [p.id],
        )
      ).rows[0];
    });
  }
}
