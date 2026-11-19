import { Controller, Get, Inject, Param, Req } from "@nestjs/common";
import { assertAllowed, requirePrincipal, type ServiceClient } from "@workspace/service-kit";
import { withTransaction, type Principal } from "@workspace/shared";
import type { Request } from "express";
import type { Pool } from "pg";
import { resolveRef } from "../ref.js";
import { relatedForTask, type SearchFn } from "../related.js";
import { CHAT, guard, POOL } from "./common.js";

/**
 * "Liên quan" on a task: related documents, similar finished tasks (who did them, how) and chat messages that name
 * it. Full-text search only, no model, so it works for every company; the ai module reads it to ground task chat.
 */
@Controller()
export class RelatedController {
  constructor(
    @Inject(POOL) private readonly pool: Pool,
    @Inject(CHAT) private readonly chat: Pick<ServiceClient, "request">,
  ) {}

  @Get("tasks/:ref/related")
  async related(@Req() req: Request, @Param("ref") ref: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "task.read");
    return guard(() =>
      withTransaction(this.pool, async (c) => {
        const id = await resolveRef(c, "task", ref);
        return relatedForTask(c, p, id, this.searchAs(p));
      }),
    );
  }

  /** Chat's unified search as the caller; a caller without `message.read` simply finds nothing there. */
  private searchAs(p: Principal): SearchFn {
    return async (q, types) => {
      if (q.trim().length < 2) return [];
      const r = await this.chat.request<{ hits: Awaited<ReturnType<SearchFn>> }>("GET", `/search?q=${encodeURIComponent(q)}&types=${types}`, undefined, p);
      return r.hits ?? [];
    };
  }
}
