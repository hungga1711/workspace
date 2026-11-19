import { BadRequestException, Body, Controller, Delete, Get, Inject, NotFoundException, Param, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { createHash } from "node:crypto";
import { z } from "zod";
import { newId, withTransaction } from "@workspace/shared";
import { assertAllowed, requirePrincipal } from "@workspace/service-kit";
import { DEPS } from "./ai.controller.js";
import { bumpHourlyStats } from "./hourly-stats.js";
import { detectSensitive, titleFrom } from "./insight.js";
import { promptTaskCodes } from "./task-codes.js";
import { topicFor } from "./topics.js";
import type { Deps } from "./runtime.js";

/**
 * Import from a provider's dashboard: the usage or compliance export an AI vendor's admin console gives (CSV or
 * JSON), for staff who use AI where the extension cannot see (desktop apps, phones). The browser parses the file
 * and maps its columns (the admin picks which column is the person, the time, the tool…); this endpoint receives
 * normalised rows, matches people by email, and records one conversation per row with source `import` or the
 * tool's own source. Re-importing the same file adds nothing (each row has a stable key). docs/ai-insights/provider-import.md.
 */

export type ImportSource = "chatgpt" | "claude" | "gemini" | "copilot" | "perplexity" | "deepseek" | "grok" | "import";

/** Which tool a row's "tool" or "model" value names; anything unknown stays `import`. */
export function sourceFromTool(...values: (string | null | undefined)[]): ImportSource {
  const v = values.filter(Boolean).join(" ").toLowerCase();
  if (!v) return "import";
  if (/chatgpt|openai|\bgpt|\bo[1-9]\b/.test(v)) return "chatgpt";
  if (/claude|anthropic/.test(v)) return "claude";
  if (/gemini|bard|google/.test(v)) return "gemini";
  if (/copilot|microsoft|bing/.test(v)) return "copilot";
  if (/perplexity|sonar/.test(v)) return "perplexity";
  if (/deepseek/.test(v)) return "deepseek";
  if (/grok|\bxai\b|x\.ai/.test(v)) return "grok";
  return "import";
}

const ImportRow = z.object({
  email: z.string().trim().max(320).optional(),
  userId: z.string().trim().max(40).optional(),
  at: z.string().trim().min(1).max(40),
  tool: z.string().trim().max(80).optional(),
  model: z.string().trim().max(80).optional(),
  title: z.string().trim().max(500).optional(),
  prompt: z.string().max(20_000).optional(),
  count: z.number().int().min(1).max(100_000).optional(),
  tokens: z.number().int().min(0).max(1e12).optional(),
  cost: z.number().min(0).max(1e9).optional(),
});
export type ImportRow = z.infer<typeof ImportRow>;

const ImportBody = z.object({
  /** Set on the second and later chunks of one file, so its counts add up in one log row. */
  importId: z.string().min(10).max(40).optional(),
  filename: z.string().trim().max(200).default(""),
  format: z.enum(["csv", "json"]),
  mapping: z.record(z.string().max(40), z.string().max(200)).default({}),
  rows: z.array(z.unknown()).max(2000),
  /** The whole file's row count, on the first chunk (for the log). */
  total: z.number().int().min(0).max(1_000_000).optional(),
});

/** A timestamp from the export: ISO 8601, a date, or Unix seconds / milliseconds. */
export function parseWhen(v: string): Date | null {
  const s = v.trim();
  if (/^\d{9,13}$/.test(s)) {
    const n = Number(s);
    return new Date(s.length > 11 ? n : n * 1000);
  }
  // "2026-10-20 08:15" (a space instead of T) and plain dates are common in spreadsheet exports.
  const d = new Date(/^\d{4}-\d{2}-\d{2} \d/.test(s) ? s.replace(" ", "T") : s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The stable key of an imported row: the same row in a later export (or the same file twice) is recognised. */
export function importKey(userId: string, r: ImportRow, at: Date): string {
  const h = createHash("sha256")
    .update([userId, at.toISOString(), r.tool ?? "", r.model ?? "", r.title ?? "", r.prompt ?? "", r.count ?? "", r.tokens ?? ""].join("\u0001"))
    .digest("hex");
  return `imp:${h.slice(0, 40)}`;
}

@Controller()
export class ImportsController {
  constructor(@Inject(DEPS) private readonly d: Deps) {}

  @Get("insights/imports")
  async list(@Req() req: Request) {
    const p = requirePrincipal(req);
    assertAllowed(p, "ai.policy.manage");
    return withTransaction(this.d.pool, async (c) => ({
      imports: (
        await c.query(
          `SELECT id, imported_by AS "importedBy", filename, format, rows_total AS total, rows_imported AS imported, rows_duplicate AS duplicate,
                  rows_unmatched AS unmatched, rows_invalid AS invalid, at FROM ai_imports ORDER BY at DESC LIMIT 20`,
        )
      ).rows,
    }));
  }

  @Post("insights/imports")
  async import(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "ai.policy.manage");
    const parsed = ImportBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    const b = parsed.data;
    const members = await this.d.identity
      .request<{ members: { userId: string; email: string }[] }>("GET", "/members", undefined, p)
      .then((r) => r.members)
      .catch(() => [] as { userId: string; email: string }[]);
    const byEmail = new Map(members.map((m) => [m.email.toLowerCase(), m.userId]));
    const ids = new Set(members.map((m) => m.userId));
    return withTransaction(this.d.pool, async (c) => {
      const policy = (await c.query<{ d: number }>("SELECT retention_days AS d FROM ai_policy LIMIT 1")).rows[0];
      const retention = policy?.d ?? 180;
      const oldest = Date.now() - retention * 86400_000;
      let id = b.importId ?? null;
      if (id) {
        if (!(await c.query("SELECT 1 FROM ai_imports WHERE id = $1", [id])).rowCount) throw new NotFoundException("import not found");
      } else {
        id = newId();
        await c.query(`INSERT INTO ai_imports (id, imported_by, filename, format, mapping, rows_total) VALUES ($1, $2, $3, $4, $5, $6)`, [
          id,
          p.id,
          b.filename,
          b.format,
          JSON.stringify(b.mapping),
          b.total ?? b.rows.length,
        ]);
      }
      const n = { imported: 0, duplicate: 0, unmatched: 0, invalid: 0 };
      for (const raw of b.rows) {
        const row = ImportRow.safeParse(raw);
        const at = row.success ? parseWhen(row.data.at) : null;
        // Rows older than the retention would be deleted within the hour; future dates are typos.
        if (!row.success || !at || at.getTime() < oldest || at.getTime() > Date.now() + 86400_000) {
          n.invalid++;
          continue;
        }
        const r = row.data;
        const userId = r.userId && ids.has(r.userId) ? r.userId : r.email ? byEmail.get(r.email.toLowerCase()) : undefined;
        if (!userId) {
          n.unmatched++;
          continue;
        }
        const text = r.prompt?.trim() || r.title?.trim() || "";
        const conv = newId();
        const ins = await c.query(
          `INSERT INTO ai_conversations (id, user_id, source, external_key, title, model, topic, summary, sensitive, messages, started_at, last_at,
                                         import_id, ext_tokens, ext_cost_usd)
           VALUES ($1, $2, $3, $4, $5, $6, $7, '', $8, $9, $10, $10, $11, $12, $13)
           ON CONFLICT (user_id, source, external_key) WHERE external_key IS NOT NULL DO NOTHING`,
          [
            conv,
            userId,
            sourceFromTool(r.tool, r.model),
            importKey(userId, r, at),
            text ? titleFrom(text) : "",
            (r.model ?? r.tool ?? "").slice(0, 80),
            text ? await topicFor(c, text) : "other",
            text ? detectSensitive(text) : [],
            r.count ?? 1,
            at,
            id,
            r.tokens ?? null,
            r.cost ?? null,
          ],
        );
        if (!ins.rowCount) {
          n.duplicate++;
          continue;
        }
        // An imported prompt is used for the title, topic, sensitive-data flags and task codes, then dropped: an admin
        // uploads other people's history, and nobody but the person reads their prompts.
        // Counted in the hourly stats either way, so Adoption shows the imported use at once.
        await bumpHourlyStats(c, { prompt: { userId, source: sourceFromTool(r.tool, r.model), at, count: r.count ?? 1 } });
        const codes = promptTaskCodes(`${r.title ?? ""}\n${r.prompt ?? ""}`);
        if (codes.length) await c.query("UPDATE ai_conversations SET hint_task_code = $2 WHERE id = $1 AND hint_task_code IS NULL", [conv, codes.join(",")]);
        n.imported++;
      }
      await c.query(
        `UPDATE ai_imports SET rows_imported = rows_imported + $2, rows_duplicate = rows_duplicate + $3, rows_unmatched = rows_unmatched + $4,
                rows_invalid = rows_invalid + $5 WHERE id = $1`,
        [id, n.imported, n.duplicate, n.unmatched, n.invalid],
      );
      return { importId: id, ...n };
    });
  }

  /** Undo an import: every conversation it added goes, the log row stays with its counts. */
  @Delete("insights/imports/:id")
  async undo(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "ai.policy.manage");
    return withTransaction(this.d.pool, async (c) => {
      if (!(await c.query("SELECT 1 FROM ai_imports WHERE id = $1", [id])).rowCount) throw new NotFoundException("import not found");
      // Take the import's prompts back out of the hourly rollup it added them to.
      await c.query(
        `UPDATE ai_hourly_stats h SET prompts = greatest(0, h.prompts - x.n)
           FROM (SELECT user_id, source, date_trunc('hour', started_at) AS hour, sum(messages)::int AS n
                   FROM ai_conversations WHERE import_id = $1 GROUP BY 1, 2, 3) x
          WHERE h.user_id = x.user_id AND h.source = x.source AND h.hour = x.hour AND h.feature = ''`,
        [id],
      );
      const r = await c.query("DELETE FROM ai_conversations WHERE import_id = $1", [id]);
      await c.query("UPDATE ai_imports SET rows_imported = 0 WHERE id = $1", [id]);
      return { removed: r.rowCount ?? 0 };
    });
  }
}
