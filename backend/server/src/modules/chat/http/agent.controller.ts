import { Body, Controller, ForbiddenException, Post, Req } from "@nestjs/common";
import { parse, requirePrincipal } from "@workspace/service-kit";
import { runWithContext, withTransaction } from "@workspace/shared";
import type { Request } from "express";
import { z } from "zod";
import { Forbidden, membership, postMessage } from "../domain.js";

import { ChatControllerBase } from "./base.controller.js";
import { guard } from "./common.js";

/** Messages posted by AI agents (the ai module only). */
@Controller()
export class AgentController extends ChatControllerBase {
  /** AI agents post as themselves on behalf of an asker who must be a member. */
  @Post("internal/agent-messages")
  async agentPost(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    if (p.type !== "service" || !p.grants.some((g) => g.permission === "agent.post" && g.scope === "PLATFORM")) throw new ForbiddenException("ai module only");
    const b = parse(
      z.object({
        channelId: z.string().length(26),
        askerId: z.string(),
        agentId: z.string(),
        body: z.string().min(1).max(20000),
        threadRootId: z.string().length(26).nullable().default(null),
      }),
      body,
    );
    const r = await runWithContext({ actorId: `agent:${b.agentId}`, requestId: req.requestId ?? b.channelId }, () =>
      guard(() =>
        withTransaction(this.pool, async (c) => {
          if (!(await membership(c, b.channelId, b.askerId))) throw new Forbidden("asker is not a channel member");
          return postMessage(c, {
            channelId: b.channelId,
            body: b.body,
            clientMsgId: null,
            threadRootId: b.threadRootId,
            attachments: [],
            author: { id: `agent:${b.agentId}`, type: "agent" },
          });
        }),
      ),
    );
    this.rt.toChannel(b.channelId, "message.created", r.message);
    return r.message;
  }
}
