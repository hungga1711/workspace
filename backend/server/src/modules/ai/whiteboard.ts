import { Body, Controller, HttpCode, HttpException, Inject, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import type { Principal } from "@workspace/shared";
import { assertAllowed, parse, requirePrincipal } from "@workspace/service-kit";
import { meteredGenerate, parseJson, replyLanguage, untrusted, type Deps } from "./runtime.js";
import { assistSystem as ask } from "./prompts.js";
import { guardAi } from "./budgets.js";
import { DEPS } from "./ai.controller.js";

/**
 * AI on a whiteboard (ADR 0024): summarize it, group its sticky notes by theme, suggest new notes. The board is
 * read through the work module AS THE USER (internal/whiteboards/:id/text), so the model only sees boards the person
 * can open. Results are proposals: the editor shows them and the person applies them to the board.
 */
interface BoardText {
  id: string;
  code: string;
  title: string;
  stickies: { elementId: string; text: string; x: number; y: number }[];
  labels: { text: string; x: number; y: number }[];
}

const MAX_NOTES = 300;
const MAX_CHARS = 40_000;

/**
 * The board as the model reads it: one line per note (with its id, so groups can name notes) and per label (headings,
 * free text), with positions so "the notes under To improve" can be worked out. Long boards are cut, notes first.
 */
export function boardLines(b: Pick<BoardText, "stickies" | "labels">, only?: Set<string>): string {
  const flat = (t: string) => t.replace(/\s+/g, " ").trim().slice(0, 500);
  const out: string[] = [];
  let size = 0;
  for (const s of b.stickies.filter((x) => x.text && (!only || only.has(x.elementId))).slice(0, MAX_NOTES)) {
    const line = `[note ${s.elementId} ${Math.round(s.x)},${Math.round(s.y)}] ${flat(s.text)}`;
    if ((size += line.length + 1) > MAX_CHARS) break;
    out.push(line);
  }
  for (const l of b.labels.slice(0, 200)) {
    const line = `[label ${Math.round(l.x)},${Math.round(l.y)}] ${flat(l.text)}`;
    if ((size += line.length + 1) > MAX_CHARS) break;
    out.push(line);
  }
  return out.join("\n");
}

const boardId = z.string().regex(/^[0-9A-Za-z-]{3,40}$/);

@Controller()
export class WhiteboardAiController {
  constructor(@Inject(DEPS) private readonly d: Deps) {}

  private async board(p: Principal, id: string): Promise<BoardText> {
    return this.d.services.work.request<BoardText>("GET", `/internal/whiteboards/${encodeURIComponent(id)}/text`, undefined, p);
  }

  private async gen<T>(p: Principal, b: BoardText, feature: string, system: string, content: string, maxTokens = 1200): Promise<T> {
    const r = await meteredGenerate(
      this.d,
      { principal: p, agentId: null, feature, subject: { type: "whiteboard", id: b.id } },
      {
        tier: "fast",
        system,
        maxTokens,
        messages: [{ role: "user", content }],
      },
    );
    const x = parseJson<T>(r.text);
    // Malformed model output is reported, never half-applied.
    if (!x) throw new HttpException({ error: "ai_malformed_output" }, 502);
    return x;
  }

  private content(b: BoardText, lines: string, request = "") {
    return `<facts>${JSON.stringify({ title: b.title, code: b.code })}</facts>\n${untrusted(lines)}${request ? `\n<request>${request.replaceAll("<", "‹")}</request>` : ""}`;
  }

  /** `{ summary }`: Markdown, the board's themes and decisions under its own headings. */
  @Post("whiteboard/summarize")
  @HttpCode(200)
  async summarize(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "ai.use");
    const b = parse(z.object({ whiteboardId: boardId }), body);
    return guardAi(async () => {
      const board = await this.board(p, b.whiteboardId);
      const x = await this.gen<{ summary: string }>(
        p,
        board,
        "whiteboard_summarize",
        ask(
          replyLanguage(req),
          "wb_summarize",
          `{"summary": string}`,
          "summary is Markdown: one bold line naming the board, then a short section per heading (### heading, bullet points) with the notes' main points merged and de-duplicated, then decisions or next steps if the notes contain any. Lines are [note id x,y] text or [label x,y] text; a note belongs to the nearest label above it.",
        ),
        this.content(board, boardLines(board)),
        1500,
      );
      return { summary: String(x.summary ?? "").slice(0, 8000) };
    });
  }

  /** `{ groups: [{ title, elementIds }] }`: the notes (all, or `elementIds`) grouped by theme; each note in one group. */
  @Post("whiteboard/cluster")
  @HttpCode(200)
  async cluster(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "ai.use");
    const b = parse(z.object({ whiteboardId: boardId, elementIds: z.array(z.string().max(64)).max(MAX_NOTES).optional() }), body);
    return guardAi(async () => {
      const board = await this.board(p, b.whiteboardId);
      const only = b.elementIds?.length ? new Set(b.elementIds) : undefined;
      const notes = new Set(board.stickies.filter((s) => s.text && (!only || only.has(s.elementId))).map((s) => s.elementId));
      if (notes.size < 2) return { groups: notes.size ? [{ title: "", elementIds: [...notes] }] : [] };
      const x = await this.gen<{ groups: { title: unknown; elementIds: unknown }[] }>(
        p,
        board,
        "whiteboard_cluster",
        ask(
          replyLanguage(req),
          "wb_cluster",
          `{"groups": [{"title": string, "elementIds": string[]}]}`,
          "Group the notes ([note id x,y] lines) by theme into 2 to 8 groups with short titles (1-3 words). Use the note ids exactly; every note in exactly one group. Ignore [label] lines except as hints.",
        ),
        this.content(board, boardLines(board, only)),
      );
      // Only notes that were asked about, each once; a group left empty goes.
      const placed = new Set<string>();
      const groups = (Array.isArray(x.groups) ? x.groups : [])
        .slice(0, 12)
        .map((g) => ({
          title: String(g.title ?? "").slice(0, 80),
          elementIds: (Array.isArray(g.elementIds) ? g.elementIds : []).map(String).filter((id) => notes.has(id) && !placed.has(id) && (placed.add(id), true)),
        }))
        .filter((g) => g.elementIds.length);
      const rest = [...notes].filter((id) => !placed.has(id));
      if (rest.length) groups.push({ title: replyLanguage(req) === "Vietnamese" ? "Khác" : "Other", elementIds: rest });
      return { groups };
    });
  }

  /** `{ ideas: string[] }`: new sticky-note texts about `prompt` (or the board's topic), not repeating the board. */
  @Post("whiteboard/ideas")
  @HttpCode(200)
  async ideas(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "ai.use");
    const b = parse(z.object({ whiteboardId: boardId, prompt: z.string().trim().max(1000).optional() }), body);
    return guardAi(async () => {
      const board = await this.board(p, b.whiteboardId);
      const x = await this.gen<{ ideas: unknown }>(
        p,
        board,
        "whiteboard_ideas",
        ask(
          replyLanguage(req),
          "wb_ideas",
          `{"ideas": string[]}`,
          "Suggest 4 to 8 new sticky notes about the request (or the board's title when there is none): each one short (under 15 words), concrete, and not repeating a note already on the board.",
        ),
        this.content(board, boardLines(board), b.prompt ?? ""),
      );
      const ideas = (Array.isArray(x.ideas) ? x.ideas : [])
        .map((i) => String(i).replace(/\s+/g, " ").trim().slice(0, 200))
        .filter(Boolean)
        .slice(0, 10);
      return { ideas };
    });
  }
}
