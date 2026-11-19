import { Controller, Get, Inject, Param, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import type { Pool } from "pg";
import { feedEvent, page, readSearchFeed, type FeedSource } from "@workspace/service-kit";
import { POOL } from "./identity.controller.js";

/** People, as search knows them: active members (identity.member.joined.v1). */
const SOURCES: Record<string, FeedSource> = {
  members: async (c, after, limit) => {
    const rows = (
      await c.query<{ user_id: string; email: string; display_name: string; created_at: Date }>(
        "SELECT user_id, email, display_name, created_at FROM members WHERE status = 'active' AND user_id > $1 ORDER BY user_id LIMIT $2",
        [after, limit],
      )
    ).rows;
    const events = rows.map((m) =>
      feedEvent("identity.member.joined.v1", "identity.member", m.user_id, m.created_at, { userId: m.user_id, email: m.email, displayName: m.display_name }),
    );
    return page(events, rows.at(-1)?.user_id, limit);
  },
};

/** Search re-index feed (service-kit search-feed.ts). */
@Controller()
export class SearchFeedController {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  @Get("internal/search-feed/:kind")
  feed(@Req() req: Request, @Param("kind") kind: string, @Query() q: unknown) {
    return readSearchFeed(req, this.pool, SOURCES, kind, q);
  }
}
