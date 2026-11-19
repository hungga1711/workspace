import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { newId, withTransaction, type Principal } from "@workspace/shared";
import { parse, requirePrincipal } from "@workspace/service-kit";
import { DEPS } from "./ai.controller.js";
import { redact, titleFrom } from "./insight.js";
import { keywordsOf } from "./monitor-intake.js";
import { canDelete, canEdit, canManageAudience, canSee, manageScope, ME_SQL, VISIBLE_SQL, type Manage, type PromptRow } from "./library-access.js";
import type { Deps } from "./runtime.js";
import type { PoolClient } from "pg";

/**
 * The prompt library, on two levels (library-access.ts has who sees and changes what). Company prompts are set up by
 * people who may manage them. Personal ones are each person's own, written here or shared from one of their
 * conversations. Anything another person can read is redacted first. Sharing is always the person's act: nothing is
 * copied from a conversation automatically, the conversation itself stays private, and what is stored is the
 * redacted text the person saw and approved.
 */

/**
 * What a shared prompt may contain: the safety net's placeholders ([CCCD], [CARD], [EMAIL], [KEYWORD]…) in place
 * of sensitive data and the company's own keywords (Admin › AI), the same rules as "redact before sending".
 */
export const redactForLibrary = (text: string, keywords: readonly string[]) => redact(text, keywords);

/** A search query for Postgres full text: each word as a prefix, all of them required. */
export function prefixQuery(q: string): string | null {
  const parts = q
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 2)
    .slice(0, 8);
  return parts.length ? parts.map((w) => `${w}:*`).join(" & ") : null;
}

const TOPIC = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/);
const AUDIENCE = z.array(z.string().min(1).max(40)).max(50);

const Create = z.object({
  conversationId: z.string().min(10).max(40).optional(),
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(8000),
  description: z.string().trim().max(300).default(""),
  topic: TOPIC.default("other"),
  level: z.enum(["company", "personal"]).default("personal"),
  visibility: z.enum(["private", "department", "everyone"]).optional(),
  audience: AUDIENCE.default([]),
  pinned: z.boolean().default(false),
});

const Update = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  body: z.string().trim().min(1).max(8000).optional(),
  description: z.string().trim().max(300).optional(),
  topic: TOPIC.optional(),
  visibility: z.enum(["private", "department", "everyone"]).optional(),
  audience: AUDIENCE.optional(),
  pinned: z.boolean().optional(),
});

const Propose = z.object({ audience: z.enum(["everyone", "department"]).default("everyone") });
const Review = z.object({ decision: z.enum(["approve", "decline"]), note: z.string().trim().max(500).optional(), audience: AUDIENCE.optional() });

const TABS = ["company", "mine", "team", "review", "all"] as const;
type Tab = (typeof TABS)[number];

type Row = PromptRow & {
  id: string;
  title: string;
  body: string;
  description: string;
  topic: string;
  uses: number;
  pinned: boolean;
  source_id: string | null;
  review_note: string | null;
  original_title: string | null;
  original_body: string | null;
  original_description: string | null;
  created_at: Date;
  updated_at: Date;
  proposal_status?: string | null;
  proposal_note?: string | null;
};

const COLS = `id, level, visibility, status, author_id, department_id, audience, title, body, description, topic, uses, pinned, source_id, review_note,
  original_title, original_body, original_description, created_at, updated_at`;

/** What the author wrote, kept beside the redacted copy only when the redaction changed something. */
const originals = (raw: { title: string; body: string; description: string }, masked: { title: string; body: string; description: string }) =>
  raw.title === masked.title && raw.body === masked.body && raw.description === masked.description ? [null, null, null] : [raw.title, raw.body, raw.description];

/** Only text another person can read is masked; a private prompt stays as its author wrote it. */
const shown = (level: string, visibility: string | undefined) => level === "company" || (visibility ?? "private") !== "private";

/** Each tab's filter, over `me` (library-access.ts ME_SQL). */
function tabWhere(tab: Tab, manage: Manage): string {
  switch (tab) {
    case "company":
      return `level = 'company' AND status = 'live' AND (cardinality(audience) = 0 OR me.udept = ANY(audience) OR me.uws)`;
    case "mine":
      return `level = 'personal' AND author_id = me.uid`;
    case "team":
      return `level = 'personal' AND author_id <> me.uid AND (visibility = 'everyone' OR (visibility = 'department' AND department_id = me.udept))`;
    case "review":
      if (!manage) return "false";
      return `level = 'company' AND status = 'proposed' AND (me.uws OR audience = ARRAY[me.udept])`;
    case "all":
      return VISIBLE_SQL;
  }
}

@Controller()
export class LibraryController {
  constructor(@Inject(DEPS) private readonly d: Deps) {}

  private dto(p: Principal, manage: Manage, r: Row) {
    // The author reads their own words; everyone else the redacted copy.
    const own = r.author_id === p.id && r.original_body !== null;
    return {
      id: r.id,
      level: r.level,
      visibility: r.visibility,
      status: r.status,
      audience: r.audience,
      authorId: r.author_id,
      title: own ? (r.original_title ?? r.title) : r.title,
      body: own ? (r.original_body ?? r.body) : r.body,
      description: own ? (r.original_description ?? r.description) : r.description,
      redacted: own,
      topic: r.topic,
      uses: r.uses,
      pinned: r.pinned,
      reviewNote: r.review_note,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      proposal: r.proposal_status ? { status: r.proposal_status, note: r.proposal_note ?? null } : null,
      canEdit: canEdit(p, manage, r),
      canDelete: canDelete(p, manage, r),
      canReview: r.level === "company" && r.status === "proposed" && canManageAudience(p, manage, r.audience),
    };
  }

  private async row(c: PoolClient, id: string): Promise<Row> {
    const r = (await c.query<Row>(`SELECT ${COLS} FROM ai_prompt_library WHERE id = $1`, [id])).rows[0];
    if (!r) throw new NotFoundException("prompt not found");
    return r;
  }

  /** The share dialog's starting point: my conversation's prompts, already redacted, for me to pick and edit. */
  @Get("insights/library/draft/:conversationId")
  async draft(@Req() req: Request, @Param("conversationId") id: string) {
    const p = requirePrincipal(req);
    return withTransaction(this.d.pool, async (c) => {
      const conv = (await c.query<{ title: string; topic: string }>("SELECT title, topic FROM ai_conversations WHERE id = $1 AND user_id = $2", [id, p.id])).rows[0];
      if (!conv) throw new NotFoundException("conversation not found");
      const keywords = await keywordsOf(c);
      const prompts = (await c.query<{ content: string }>("SELECT content FROM ai_messages WHERE conversation_id = $1 AND role = 'user' ORDER BY at LIMIT 10", [id])).rows.map(
        (r) => redactForLibrary(r.content, keywords).slice(0, 8000),
      );
      return { conversationId: id, title: redactForLibrary(conv.title || titleFrom(prompts[0] ?? ""), keywords).slice(0, 120), topic: conv.topic, prompts };
    });
  }

  /**
   * Add a prompt: a company one (needs ai.prompt.manage for its audience) or my own. Shared from a conversation it is
   * open to everyone unless I say otherwise, as before; written here it starts private. The server redacts what
   * others will read, so what is stored never depends on the browser having done it.
   */
  @Post("insights/library")
  async share(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(Create, body);
    const manage = manageScope(p);
    const company = b.level === "company";
    if (company && !canManageAudience(p, manage, b.audience)) throw new ForbiddenException("only people who manage company prompts can add them");
    const visibility = company ? "everyone" : (b.visibility ?? (b.conversationId ? "everyone" : "private"));
    if (!company && visibility === "department" && !p.departmentId) throw new BadRequestException("you are not in a department");
    return withTransaction(this.d.pool, async (c) => {
      if (b.conversationId && !(await c.query("SELECT 1 FROM ai_conversations WHERE id = $1 AND user_id = $2", [b.conversationId, p.id])).rowCount)
        throw new NotFoundException("conversation not found");
      const keywords = await keywordsOf(c);
      const mask = (x: string) => (shown(b.level, visibility) ? redactForLibrary(x, keywords) : x);
      const id = newId();
      const masked = { title: mask(b.title), body: mask(b.body), description: mask(b.description) };
      await c.query(
        `INSERT INTO ai_prompt_library (id, author_id, conversation_id, title, body, description, topic, level, visibility, department_id, audience, pinned, updated_by,
                                        original_title, original_body, original_description)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $2, $13, $14, $15)`,
        [
          id,
          p.id,
          b.conversationId ?? null,
          masked.title,
          masked.body,
          masked.description,
          b.topic,
          b.level,
          visibility,
          company ? null : p.departmentId,
          company ? [...new Set(b.audience)] : [],
          company && b.pinned,
          ...(company ? [null, null, null] : originals(b, masked)),
        ],
      );
      return { id };
    });
  }

  /**
   * One tab of the library: the company's, mine, shared by colleagues, or (for those who manage it) proposals waiting
   * for review. With `q`, words match as prefixes of the title and text; `topic` narrows to one. Pinned prompts lead
   * the company tab, then the most used, then the newest. `mine=1` is the old "only mine" filter.
   */
  @Get("insights/library")
  async list(
    @Req() req: Request,
    @Query("q") q?: string,
    @Query("topic") topic?: string,
    @Query("mine") mine?: string,
    @Query("tab") tabQ?: string,
    @Query("limit") limitQ?: string,
  ) {
    const p = requirePrincipal(req);
    const manage = manageScope(p);
    const tab: Tab = (TABS as readonly string[]).includes(tabQ ?? "") ? (tabQ as Tab) : mine === "1" ? "mine" : "all";
    const limit = Math.min(Math.max(Number(limitQ) || 100, 1), 200);
    const base: unknown[] = [p.id, p.departmentId, manage === "workspace"];
    const args = [...base];
    const where = [tabWhere(tab, manage)];
    const tsq = q ? prefixQuery(q) : null;
    if (tsq) {
      args.push(tsq);
      where.push(`tsv @@ to_tsquery('simple', $${args.length})`);
    }
    if (topic && /^[a-z][a-z0-9_]{1,39}$/.test(topic)) {
      args.push(topic);
      where.push(`topic = $${args.length}`);
    }
    return withTransaction(this.d.pool, async (c) => {
      const rows = (
        await c.query<Row>(
          `SELECT l.*, x.status AS proposal_status, x.review_note AS proposal_note
             FROM (${ME_SQL} SELECT ${COLS} FROM ai_prompt_library, me WHERE ${where.join(" AND ")} ORDER BY pinned DESC, uses DESC, updated_at DESC LIMIT ${limit}) l
             LEFT JOIN LATERAL (SELECT s.status, s.review_note FROM ai_prompt_library s WHERE s.source_id = l.id ORDER BY s.created_at DESC LIMIT 1) x ON l.level = 'personal'
            ORDER BY l.pinned DESC, l.uses DESC, l.updated_at DESC`,
          args,
        )
      ).rows;
      const counts: Record<string, number> = {};
      for (const t of ["company", "mine", "team", "review"] as const)
        counts[t] = (await c.query<{ n: number }>(`${ME_SQL} SELECT count(*)::int AS n FROM ai_prompt_library, me WHERE ${tabWhere(t, manage)}`, base)).rows[0]?.n ?? 0;
      return {
        tab,
        manage,
        departmentId: p.departmentId,
        prompts: rows.map((r) => this.dto(p, manage, r)),
        counts,
        total: (await c.query<{ n: number }>(`${ME_SQL} SELECT count(*)::int AS n FROM ai_prompt_library, me WHERE ${VISIBLE_SQL}`, base)).rows[0]?.n ?? 0,
      };
    });
  }

  /** Change a prompt: its author (personal), or whoever may manage it (company); a company audience stays within reach. */
  @Patch("insights/library/:id")
  async update(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(Update, body);
    const manage = manageScope(p);
    return withTransaction(this.d.pool, async (c) => {
      const r = await this.row(c, id);
      if (!canSee(p, manage, r)) throw new NotFoundException("prompt not found");
      if (!canEdit(p, manage, r)) throw new ForbiddenException("you cannot change this prompt");
      const company = r.level === "company";
      if (company && b.audience && !canManageAudience(p, manage, b.audience)) throw new ForbiddenException("you cannot publish for that audience");
      const visibility = company ? r.visibility : (b.visibility ?? r.visibility);
      if (!company && visibility === "department" && !p.departmentId) throw new BadRequestException("you are not in a department");
      const keywords = await keywordsOf(c);
      const mask = (x: string) => (shown(r.level, visibility) ? redactForLibrary(x, keywords) : x);
      // The author edits their own wording; what others read is redacted again from it.
      const mine = r.author_id === p.id;
      const raw = {
        title: b.title ?? (mine ? (r.original_title ?? r.title) : r.title),
        body: b.body ?? (mine ? (r.original_body ?? r.body) : r.body),
        description: b.description ?? (mine ? (r.original_description ?? r.description) : r.description),
      };
      const masked = { title: mask(raw.title), body: mask(raw.body), description: mask(raw.description) };
      const keep = r.level === "personal" && mine ? originals(raw, masked) : [r.original_title, r.original_body, r.original_description];
      await c.query(
        `UPDATE ai_prompt_library SET title = $2, body = $3, description = $4, topic = $5, visibility = $6, audience = $7, pinned = $8,
                department_id = CASE WHEN level = 'personal' THEN $9 ELSE NULL END, updated_at = now(), updated_by = $10,
                original_title = $11, original_body = $12, original_description = $13 WHERE id = $1`,
        [
          id,
          masked.title,
          masked.body,
          masked.description,
          b.topic ?? r.topic,
          visibility,
          company ? [...new Set(b.audience ?? r.audience)] : [],
          company && r.status === "live" && canManageAudience(p, manage, b.audience ?? r.audience) ? (b.pinned ?? r.pinned) : false,
          p.departmentId,
          p.id,
          ...keep,
        ],
      );
      return this.dto(p, manage, await this.row(c, id));
    });
  }

  /** Propose my prompt to the company: a redacted copy waits for someone who manages company prompts. */
  @Post("insights/library/:id/propose")
  async propose(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(Propose, body ?? {});
    return withTransaction(this.d.pool, async (c) => {
      const r = await this.row(c, id);
      if (r.level !== "personal" || r.author_id !== p.id) throw new NotFoundException("prompt not found");
      if (b.audience === "department" && !p.departmentId) throw new BadRequestException("you are not in a department");
      if ((await c.query("SELECT 1 FROM ai_prompt_library WHERE source_id = $1 AND status = 'proposed'", [id])).rowCount) throw new ConflictException("already proposed");
      const keywords = await keywordsOf(c);
      const newIdent = newId();
      await c.query(
        `INSERT INTO ai_prompt_library (id, author_id, title, body, description, topic, level, visibility, status, audience, source_id, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, 'company', 'everyone', 'proposed', $7, $8, $2)`,
        [
          newIdent,
          p.id,
          redactForLibrary(r.title, keywords),
          redactForLibrary(r.body, keywords),
          redactForLibrary(r.description, keywords),
          r.topic,
          b.audience === "department" ? [p.departmentId] : [],
          id,
        ],
      );
      return { id: newIdent };
    });
  }

  /** Approve (it goes live for its audience, which the reviewer may narrow or widen within reach) or decline a proposal. */
  @Post("insights/library/:id/review")
  @HttpCode(200)
  async review(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(Review, body);
    const manage = manageScope(p);
    return withTransaction(this.d.pool, async (c) => {
      const r = await this.row(c, id);
      if (r.level !== "company" || r.status !== "proposed") throw new NotFoundException("no proposal to review");
      if (!canManageAudience(p, manage, r.audience)) throw new ForbiddenException("you cannot review this proposal");
      const audience = b.audience ? [...new Set(b.audience)] : r.audience;
      if (!canManageAudience(p, manage, audience)) throw new ForbiddenException("you cannot publish for that audience");
      await c.query(`UPDATE ai_prompt_library SET status = $2, audience = $3, review_note = $4, reviewed_by = $5, updated_at = now(), updated_by = $5 WHERE id = $1`, [
        id,
        b.decision === "approve" ? "live" : "declined",
        audience,
        b.note ?? null,
        p.id,
      ]);
      return this.dto(p, manage, await this.row(c, id));
    });
  }

  /** "Dùng" or "Sao chép": counts a use (once per click; the count is a rough signal of what helps, not an audit). */
  @Post("insights/library/:id/use")
  @HttpCode(200)
  async use(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    return withTransaction(this.d.pool, async (c) => {
      const r = await this.row(c, id);
      if (!canSee(p, manageScope(p), r)) throw new NotFoundException("prompt not found");
      const u = await c.query<{ uses: number }>("UPDATE ai_prompt_library SET uses = uses + 1 WHERE id = $1 RETURNING uses", [id]);
      return { uses: u.rows[0]!.uses };
    });
  }

  /** The author takes their prompt back; company prompts go with whoever manages them; AI admins can remove any. */
  @Delete("insights/library/:id")
  async remove(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    const manage = manageScope(p);
    return withTransaction(this.d.pool, async (c) => {
      const r = await this.row(c, id);
      if (!canSee(p, manage, r) && manage !== "workspace") throw new NotFoundException("prompt not found");
      if (!canDelete(p, manage, r)) throw new ForbiddenException("only the author or someone who manages it can remove it");
      await c.query("DELETE FROM ai_prompt_library WHERE id = $1", [id]);
      return { ok: true };
    });
  }
}
