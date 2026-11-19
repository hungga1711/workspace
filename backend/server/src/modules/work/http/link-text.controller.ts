import { Controller, Get, Query, Req } from "@nestjs/common";
import { assertAllowed, parse, requirePrincipal } from "@workspace/service-kit";
import type { Request } from "express";
import { z } from "zod";
import { readLink } from "../workflows/links.js";
import { WorkControllerBase } from "./base.controller.js";

/** What a page's text may be for the assistant: a long article fits, a whole site export does not. */
const TEXT_CHARS = 40_000;

/**
 * A web page's text for the assistant's read_webpage tool, for an AI with no web tools of its own. The
 * same fenced reader as a workflow's links (workflows/links.ts): http(s) only, no private, loopback or link-local
 * address (redirects included), a few seconds and a size cap, cached for ten minutes.
 */
@Controller()
export class LinkTextController extends WorkControllerBase {
  @Get("link-text")
  async linkText(@Req() req: Request, @Query() query: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "task.read");
    const q = parse(z.object({ url: z.string().trim().url().max(2000) }), query);
    const r = await readLink(q.url);
    return r.ok ? { ok: true, kind: r.kind, text: r.text.slice(0, TEXT_CHARS), cut: r.text.length > TEXT_CHARS } : { ok: false, kind: r.kind, problem: r.problem };
  }
}
