import { BadRequestException, Body, Controller, ForbiddenException, Get, Post, Query, Req } from "@nestjs/common";
import {
  assertAllowed,
  parse,
  passagesAround,
  PRINCIPAL_HEADER,
  requirePrincipal,
  search,
  searchPassages,
  searchTsQuery,
  serviceFetch,
  signInternalToken,
  type Passage,
} from "@workspace/service-kit";
import { featureDisabled, newId, runWithContext, withTransaction, type Principal } from "@workspace/shared";
import type { Request } from "express";
import { z } from "zod";

import { ChatControllerBase } from "./base.controller.js";

/** Unified search and the container/readability checks the other modules ask of chat. */
@Controller()
export class SearchController extends ChatControllerBase {
  /** Container ids for search filtering: the user's channels plus public channels. */
  private async readableContainers(p: Principal): Promise<string[]> {
    return withTransaction(this.pool, async (c) =>
      (
        await c.query<{ id: string }>(
          `SELECT ch.id FROM channels ch WHERE EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = ch.id AND cm.user_id = $1)
          OR ch.kind = 'public'`,
          [p.id],
        )
      ).rows.map((r) => r.id),
    );
  }

  @Get("internal/containers")
  async containers(@Req() req: Request) {
    const p = requirePrincipal(req);
    return { containerIds: await this.readableContainers(p) };
  }

  /** Calls the work module as the same user (re-signed principal), for search scope and rechecks. */
  private async asUser<T>(p: Principal, method: string, path: string, body?: unknown): Promise<T> {
    const res = await serviceFetch(`${this.cfg.workUrl}${path}`, {
      method,
      signal: AbortSignal.timeout(5000),
      headers: { "content-type": "application/json", [PRINCIPAL_HEADER]: await signInternalToken({ principal: p, requestId: newId() }, this.cfg.internalSecret) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new Error(`work ${path} → ${res.status}`);
    return (await res.json()) as T;
  }

  /**
   * Unified search: messages, channels, files, people, tasks, projects, documents, whiteboards.
   * The search query is filtered by readable containers + per-user ACL; then the top hits are
   * rechecked against Postgres (chat here, work via its own rules) so stale index entries never leak.
   */
  @Get("search")
  async search(@Req() req: Request, @Query("q") q?: string, @Query("types") typesParam?: string, @Query("channelId") channelId?: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "message.read");
    const text = (q ?? "").trim();
    if (text.length < 2) throw new BadRequestException("query too short");
    const ALL = ["message", "channel", "file", "person", "task", "project", "document", "whiteboard"] as const;
    // Kinds of a feature left out at deploy time (DISABLED_FEATURES) are never searched, asked for or not.
    const left = new Set<string>([...(featureDisabled("docs") ? ["document"] : []), ...(featureDisabled("whiteboards") ? ["whiteboard"] : [])]);
    const types = (typesParam ? ALL.filter((t) => typesParam.split(",").includes(t)) : [...ALL]).filter((t) => !left.has(t));
    if (!types.length) return { hits: [] };
    const channels = await this.readableContainers(p);
    // "Tìm trong kênh": one conversation only, and only when the caller may read it.
    if (channelId !== undefined && !channels.includes(channelId)) return { hits: [] };
    const work = channelId
      ? { containerIds: [] as string[] }
      : await this.asUser<{ containerIds: string[] }>(p, "GET", "/internal/search-scope").catch(() => ({ containerIds: [] as string[] }));
    const containerIds = channelId ? [channelId] : [...channels, ...work.containerIds, "people", `user:${p.id}`];
    // One ranked list would be mostly messages (the most numerous kind) and hide documents, projects and whiteboards
    // from "All": with several kinds, each gets its own top hits. The kinds run side by side, each bounded by a
    // statement timeout, so one slow kind (a very common word across a million messages) costs its own results only.
    // The query's words (with their typo corrections) are looked up once for all the kinds, not once per kind.
    const tsq = await withTransaction(this.searchDb, (c) => searchTsQuery(c, text));
    if (!tsq) return { hits: [] };
    const byKind = async (kinds: (typeof ALL)[number][], size: number) =>
      withTransaction(this.searchDb, async (c) => {
        await c.query("SET LOCAL statement_timeout = 4000");
        return (await search(c, { userId: p.id, containerIds, text, types: kinds, size, tsq })).hits;
      });
    const settled = types.length > 1 ? await Promise.allSettled(types.map((kind) => byKind([kind], 12))) : await Promise.allSettled([byKind([...types], 40)]);
    if (settled.every((s) => s.status === "rejected")) throw (settled[0] as PromiseRejectedResult).reason;
    const r = { hits: settled.flatMap((s) => (s.status === "fulfilled" ? s.value : [])) };
    const partial = settled.some((s) => s.status === "rejected");
    const of = (t: string) => r.hits.filter((h) => h.entity_type === t).map((h) => h.entity_id);
    const okChat = await withTransaction(this.pool, async (c) => {
      const msgs = (
        await c.query<{ id: string }>(
          `SELECT m.id FROM messages m JOIN channels ch ON ch.id = m.channel_id
          WHERE m.id = ANY($1) AND m.deleted_at IS NULL
            AND (ch.kind = 'public' OR EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = ch.id AND cm.user_id = $2))`,
          [of("message"), p.id],
        )
      ).rows.map((x) => x.id);
      const chans = (
        await c.query<{ id: string }>(
          `SELECT ch.id FROM channels ch WHERE ch.id = ANY($1) AND NOT ch.archived
            AND (ch.kind = 'public' OR EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = ch.id AND cm.user_id = $2))`,
          [of("channel"), p.id],
        )
      ).rows.map((x) => x.id);
      const files = (
        await c.query<{ id: string }>(
          `SELECT f.id FROM chat_files f JOIN channels ch ON ch.id = f.channel_id
          WHERE f.id = ANY($1) AND f.status = 'active'
            AND (ch.kind = 'public' OR EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = ch.id AND cm.user_id = $2))`,
          [of("file"), p.id],
        )
      ).rows.map((x) => x.id);
      return new Set([...msgs, ...chans, ...files]);
    });
    const needWork = of("task").length + of("document").length + of("project").length + of("whiteboard").length > 0;
    const none = { tasks: [] as string[], documents: [] as string[], projects: [] as string[], whiteboards: [] as string[] };
    const okWork = needWork
      ? await this.asUser<typeof none>(p, "POST", "/internal/readable", {
          tasks: of("task"),
          documents: of("document"),
          projects: of("project"),
          whiteboards: of("whiteboard"),
        }).catch(() => none)
      : none;
    const okIds = new Set([...okChat, ...okWork.tasks, ...okWork.documents, ...okWork.projects, ...(okWork.whiteboards ?? [])]);
    const hits = r.hits.filter((h) => h.entity_type === "person" || okIds.has(h.entity_id));
    return partial ? { hits, partial } : { hits };
  }

  /** Kinds AI retrieval may ask for; those of a feature left out at deploy time (DISABLED_FEATURES) are never searched. */
  private passageKinds(asked?: string): string[] {
    const ALL = ["message", "task", "project", "document", "whiteboard", "meeting", "event", "file", "approval"];
    const left = new Set<string>([
      ...(featureDisabled("docs") ? ["document"] : []),
      ...(featureDisabled("whiteboards") ? ["whiteboard"] : []),
      ...(featureDisabled("calendar") ? ["meeting", "event"] : []),
    ]);
    const want = asked ? asked.split(",").map((t) => t.trim()) : ALL;
    return ALL.filter((t) => want.includes(t) && !left.has(t));
  }

  /** Which of these passages the reader may still read: chat's own rule for messages, the work module's for the rest. */
  private async recheck(p: Principal, rows: Passage[]): Promise<Passage[]> {
    const of = (t: string) => [...new Set(rows.filter((h) => h.entity_type === t).map((h) => h.entity_id))].slice(0, 50);
    const msgs = of("message").length
      ? await withTransaction(this.pool, async (c) =>
          (
            await c.query<{ id: string }>(
              `SELECT m.id FROM messages m JOIN channels ch ON ch.id = m.channel_id
                WHERE m.id = ANY($1) AND m.deleted_at IS NULL
                  AND (ch.kind = 'public' OR EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = ch.id AND cm.user_id = $2))`,
              [of("message"), p.id],
            )
          ).rows.map((x) => x.id),
        )
      : [];
    const ask = {
      tasks: of("task"),
      documents: of("document"),
      projects: of("project"),
      whiteboards: of("whiteboard"),
      meetings: of("meeting"),
      events: of("event"),
      approvals: of("approval"),
      files: of("file"),
    };
    const none = { tasks: [], documents: [], projects: [], whiteboards: [], meetings: [], events: [], approvals: [], files: [] } as Record<keyof typeof ask, string[]>;
    const work = Object.values(ask).some((x) => x.length) ? await this.asUser<typeof none>(p, "POST", "/internal/readable", ask).catch(() => none) : none;
    const ok = new Set([
      ...msgs.map((id) => `message:${id}`),
      ...(work.tasks ?? []).map((id) => `task:${id}`),
      ...(work.documents ?? []).map((id) => `document:${id}`),
      ...(work.projects ?? []).map((id) => `project:${id}`),
      ...(work.whiteboards ?? []).map((id) => `whiteboard:${id}`),
      ...(work.meetings ?? []).map((id) => `meeting:${id}`),
      ...(work.events ?? []).map((id) => `event:${id}`),
      ...(work.approvals ?? []).map((id) => `approval:${id}`),
      ...(work.files ?? []).map((id) => `file:${id}`),
    ]);
    return rows.filter((h) => ok.has(`${h.entity_type}:${h.entity_id}`));
  }

  private shape = (h: Passage) => ({
    entity_type: h.entity_type,
    entity_id: h.entity_id,
    title: h.title,
    heading: h.heading,
    url: h.url,
    seq: h.seq,
    text: h.text,
    score: h.score,
    updated_at: h.updated_at,
  });

  /**
   * Passages for AI retrieval: the paragraphs that best answer a question, among everything the reader may read
   * (tasks with their comments, whole pages, meetings' agendas and minutes, calendar entries, files' words, requests,
   * messages, projects, whiteboards). Filtered like `search` (readable containers and per-user ACL), then every hit is
   * rechecked against the owning module, so a stale index entry never reaches a model.
   */
  @Get("search/passages")
  async passages(@Req() req: Request, @Query("q") q?: string, @Query("types") typesParam?: string, @Query("limit") limitParam?: string, @Query("since") since?: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "message.read");
    const text = (q ?? "").trim();
    if (text.length < 2) throw new BadRequestException("query too short");
    if (since !== undefined && Number.isNaN(Date.parse(since))) throw new BadRequestException("since must be a date");
    const limit = Math.min(Math.max(Number(limitParam) || 8, 1), 12);
    const types = this.passageKinds(typesParam);
    if (!types.length) return { passages: [] };
    const channels = await this.readableContainers(p);
    let partial = false;
    const work = await this.asUser<{ containerIds: string[] }>(p, "GET", "/internal/search-scope").catch(() => {
      partial = true;
      return { containerIds: [] as string[] };
    });
    const containerIds = [...channels, ...work.containerIds, `user:${p.id}`];
    // More than asked for: the recheck may drop some, and the answer should still be full.
    const found = await withTransaction(this.searchDb, async (c) => {
      await c.query("SET LOCAL statement_timeout = 4000");
      return searchPassages(c, { userId: p.id, containerIds, text, types, size: limit * 2, ...(since ? { since: new Date(since).toISOString() } : {}) });
    });
    const passages = (await this.recheck(p, found)).slice(0, limit).map(this.shape);
    return partial ? { passages, partial } : { passages };
  }

  /** The text before and after one passage of something the reader may read ("read more of this"). */
  @Get("search/passages/around")
  async around(@Req() req: Request, @Query("type") type?: string, @Query("id") id?: string, @Query("seq") seqParam?: string, @Query("radius") radiusParam?: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "message.read");
    if (!type || !id || !this.passageKinds(type).length) throw new BadRequestException("type and id are expected");
    const seq = Math.max(Number(seqParam) || 0, 0);
    const radius = Math.min(Math.max(Number(radiusParam) || 1, 0), 5);
    const found = await withTransaction(this.searchDb, (c) => passagesAround(c, type, id, seq, radius));
    return { passages: (await this.recheck(p, found)).map(this.shape) };
  }

  /** Audience check for AI answers: can every listed user read every listed message? */
  @Post("internal/readable")
  async readable(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    if (p.type !== "service" || !p.grants.some((g) => g.permission === "agent.post" && g.scope === "PLATFORM")) throw new ForbiddenException("ai module only");
    const b = parse(z.object({ messageIds: z.array(z.string()).max(50), userIds: z.array(z.string()).max(200) }), body);
    return runWithContext({ actorId: "service:ai", requestId: req.requestId ?? "r" }, () =>
      withTransaction(this.pool, async (c) => {
        const r = await c.query<{ ok: boolean }>(
          `SELECT bool_and(ch.kind = 'public' OR EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = ch.id AND cm.user_id = u)) AS ok
           FROM messages m JOIN channels ch ON ch.id = m.channel_id, unnest($2::text[]) AS u
          WHERE m.id = ANY($1)`,
          [b.messageIds, b.userIds],
        );
        return { allReadable: b.messageIds.length === 0 || r.rows[0]?.ok === true };
      }),
    );
  }
}
