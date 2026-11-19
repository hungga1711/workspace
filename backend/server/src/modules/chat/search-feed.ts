import { Controller, Get, Inject, Param, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import type { Pool } from "pg";
import { feedEvent, page, readSearchFeed, type FeedSource } from "@workspace/service-kit";
import { POOL } from "./http/common.js";

type Kind = "public" | "private" | "dm" | "group";

/** Channels and messages, as search knows them (service-kit search-feed.ts). */
const SOURCES: Record<string, FeedSource> = {
  channels: async (c, after, limit) => {
    const rows = (
      await c.query<{ id: string; kind: Kind; name: string | null; topic: string; archived: boolean; created_at: Date }>(
        "SELECT id, kind, name, topic, archived, created_at FROM channels WHERE kind IN ('public', 'private') AND id > $1 ORDER BY id LIMIT $2",
        [after, limit],
      )
    ).rows;
    const events = rows.map((ch) =>
      feedEvent("chat.channel.updated.v1", "chat.channel", ch.id, ch.created_at, {
        channelId: ch.id,
        kind: ch.kind,
        name: ch.name,
        topic: ch.topic,
        archived: ch.archived,
        previousName: ch.name,
      }),
    );
    return page(events, rows.at(-1)?.id, limit);
  },
  // Every live message with its attachments (files are found by name), in every conversation:
  // search filters by the channels the reader belongs to.
  messages: async (c, after, limit) => {
    const rows = (
      await c.query<{
        id: string;
        channel_id: string;
        kind: Kind;
        name: string | null;
        seq: string;
        thread_root_id: string | null;
        author_id: string;
        author_type: "user" | "agent" | "system" | "import";
        body: string;
        mentions: string[];
        attachments: { fileId: string; name: string; contentType: string; size: number }[];
        created_at: Date;
      }>(
        `SELECT m.id, m.channel_id, ch.kind, ch.name, m.seq, m.thread_root_id, m.author_id, m.author_type, m.body, m.mentions, m.attachments, m.created_at
           FROM messages m JOIN channels ch ON ch.id = m.channel_id
          WHERE m.deleted_at IS NULL AND m.id > $1 ORDER BY m.id LIMIT $2`,
        [after, limit],
      )
    ).rows;
    const events = rows.map((m) =>
      feedEvent("chat.message.created.v1", "chat.message", m.id, m.created_at, {
        messageId: m.id,
        channelId: m.channel_id,
        channelKind: m.kind,
        channelName: m.name,
        seq: Number(m.seq),
        threadRootId: m.thread_root_id,
        authorId: m.author_id,
        authorType: m.author_type,
        body: m.body,
        mentions: m.mentions,
        attachments: m.attachments.map((a) => ({ fileId: a.fileId, name: a.name, contentType: a.contentType, size: a.size })),
        // Notification fields: nobody is notified by a re-index.
        recipients: [],
        quiet: [],
        everyMessage: [],
      }),
    );
    return page(events, rows.at(-1)?.id, limit);
  },
};

@Controller()
export class SearchFeedController {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  @Get("internal/search-feed/:kind")
  feed(@Req() req: Request, @Param("kind") kind: string, @Query() q: unknown) {
    return readSearchFeed(req, this.pool, SOURCES, kind, q);
  }
}
