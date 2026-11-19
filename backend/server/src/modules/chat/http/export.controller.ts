import { Controller, Get, Param, Query, Req } from "@nestjs/common";
import { assertAllowed, requirePrincipal } from "@workspace/service-kit";
import { recordAudit, withTransaction } from "@workspace/shared";
import type { Request } from "express";
import { assertCanRead, selectMessages } from "../domain.js";

import { ChatControllerBase } from "./base.controller.js";
import { guard } from "./common.js";

/**
 * A channel's history for workspace admins (channel.manage): every message including thread replies, oldest first,
 * in pages of up to 1,000 (`after=<seq>`). Reactions, polls and read marks are left out; attachments come as file
 * ids that the web turns into download links. The web route streams the pages into one JSON file.
 */
@Controller()
export class ExportController extends ChatControllerBase {
  @Get("channels/:id/export")
  async export(@Req() req: Request, @Param("id") id: string, @Query("after") after?: string, @Query("limit") limit?: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "channel.manage");
    const n = Math.min(Math.max(Number(limit ?? 500) || 500, 1), 1000);
    return guard(() =>
      withTransaction(this.pool, async (c) => {
        const ch = await assertCanRead(c, p, id);
        const rows = await selectMessages(c, "m.channel_id = $1 AND m.seq > $2", [id, Number(after) || 0], p.id, "m.seq ASC", n);
        // The audit trail (ADR 0025) records the export once (its first page); a private conversation by kind only.
        if (!Number(after))
          await recordAudit(c, {
            action: "chat.channel.exported",
            targetType: "channel",
            targetId: id,
            targetLabel: ch.kind === "public" ? `#${ch.name}` : null,
            meta: { kind: ch.kind },
          });
        return {
          channel: { id: ch.id, kind: ch.kind, name: ch.name, displayName: ch.display_name ?? null, topic: ch.topic },
          messages: rows.map((m) => ({
            id: m.id,
            seq: m.seq,
            threadRootId: m.threadRootId,
            authorId: m.authorId,
            authorType: m.authorType,
            importAuthor: m.importAuthor ?? null,
            body: m.body,
            mentions: m.mentions,
            attachments: m.attachments,
            forwardOf: m.forwardOf ?? null,
            createdAt: m.createdAt,
            editedAt: m.editedAt,
            deletedAt: m.deletedAt,
          })),
          nextAfter: rows.length === n ? rows.at(-1)!.seq : null,
        };
      }),
    );
  }
}
