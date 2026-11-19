import { Body, Controller, Post, Req } from "@nestjs/common";
import { assertAllowed, parse, requirePrincipal } from "@workspace/service-kit";
import { withTransaction } from "@workspace/shared";
import type { Request } from "express";
import { z } from "zod";
import { importChannel } from "../imports.js";

import { ChatControllerBase } from "./base.controller.js";
import { guard } from "./common.js";

/** History imported from other chat tools. */
@Controller()
export class ImportsController extends ChatControllerBase {
  /** History from Slack, one channel per call (the browser reads the export and maps people). */
  @Post("imports/slack")
  async importSlack(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "channel.create");
    assertAllowed(p, "member.invite");
    const b = parse(
      z.object({
        name: z.string().trim().min(1).max(80),
        topic: z.string().max(250).default(""),
        messages: z
          .array(
            z.object({
              key: z.string().min(1).max(40),
              threadKey: z.string().max(40).nullable().default(null),
              at: z.string().datetime({ offset: true }),
              text: z.string().max(20000),
              userId: z.string().max(64).nullable().default(null),
              authorName: z.string().max(120).default(""),
            }),
          )
          .max(5000),
      }),
      body,
    );
    return guard(() => withTransaction(this.pool, (c) => importChannel(c, p, { ...b, source: "slack" })));
  }
}
