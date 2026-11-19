import { Controller, ForbiddenException, Get, Req } from "@nestjs/common";
import { requirePrincipal } from "@workspace/service-kit";
import { withTransaction } from "@workspace/shared";
import type { Request } from "express";
import { workAttention } from "../attention.js";
import { WorkControllerBase } from "./base.controller.js";

/** Work's part of the admin overview's "Needs you" list (attention.ts): admins only, each kind to who may fix it. */
@Controller()
export class AttentionController extends WorkControllerBase {
  @Get("attention")
  async attention(@Req() req: Request) {
    const p = requirePrincipal(req);
    const r = await withTransaction(this.pool, (c) => workAttention(c, p));
    if (!r) throw new ForbiddenException("admin only");
    return r;
  }
}
