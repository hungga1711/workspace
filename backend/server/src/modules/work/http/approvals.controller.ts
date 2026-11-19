import { ForbiddenException, BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Post, Put, Query, Req } from "@nestjs/common";
import { assertAllowed, parse, requirePrincipal } from "@workspace/service-kit";
import { authorize, dayKey, newId, recordAudit, withTransaction } from "@workspace/shared";
import type { Request } from "express";
import { z } from "zod";
import { approvalDecisionBody, approvalRequestBody } from "@workspace/contracts";
import { approvalContext, commentApproval, decideApproval, forwardApproval, getDelegation, recordDecision, requestApproval, setDelegation, settleDecision } from "../approvals.js";
import { emit } from "../common.js";
import { handover, handoverSummary } from "../handover.js";

import { WorkControllerBase } from "./base.controller.js";
import { guard, requestTemplate } from "./common.js";
import { resolveRef } from "../ref.js";
import { workspaceTimeZone } from "../settings.js";

/** Vận hành: approvals, request templates, handover, delegation, decisions. */
@Controller()
export class ApprovalsController extends WorkControllerBase {
  // ---- approvals and decisions ----
  @Post("approvals")
  async requestApproval(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(approvalRequestBody, body);
    // Money requests are decided on their amount: one without it reaches the approver unanswerable (R-016).
    if (["purchase", "payment", "advance"].includes(b.kind) && !(b.amount && b.amount > 0))
      throw new BadRequestException({ error: "amount_required", message: "this kind of request needs an amount" });
    return guard(() => withTransaction(this.pool, (c) => requestApproval(c, p, b)));
  }

  // ---- Vận hành › Mẫu yêu cầu: the company's own request types ----
  @Get("request-templates")
  async requestTemplates(@Req() req: Request) {
    const p = requirePrincipal(req);
    return withTransaction(this.pool, async (c) => ({
      templates: (
        await c.query(`SELECT id, name, icon, description, fields, money, approver_id AS "approverId" FROM request_templates WHERE NOT archived ORDER BY created_at LIMIT 100`)
      ).rows,
      canManage: authorize(p, "workspace.configure").allowed,
    }));
  }

  @Post("request-templates")
  async createRequestTemplate(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "workspace.configure");
    const b = parse(requestTemplate, body);
    return withTransaction(this.pool, async (c) => {
      const id = newId();
      await c.query("INSERT INTO request_templates (id, name, icon, description, fields, money, approver_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [
        id,
        b.name,
        b.icon,
        b.description,
        JSON.stringify(b.fields),
        b.money,
        b.approverId,
        p.id,
      ]);
      await recordAudit(c, {
        action: "work.request_template.created",
        targetType: "request_template",
        targetId: id,
        targetLabel: b.name,
        meta: { money: b.money, approverId: b.approverId },
      });
      return { id };
    });
  }

  @Delete("request-templates/:id")
  @HttpCode(204)
  async archiveRequestTemplate(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "workspace.configure");
    await withTransaction(this.pool, async (c) => {
      const r = await c.query<{ name: string }>("UPDATE request_templates SET archived = true WHERE id = $1 RETURNING name", [id]);
      if (r.rows[0]) await recordAudit(c, { action: "work.request_template.deleted", targetType: "request_template", targetId: id, targetLabel: r.rows[0].name });
    });
  }

  @Get("approvals")
  async approvals(@Req() req: Request, @Query("role") role?: string) {
    const p = requirePrincipal(req);
    return withTransaction(this.pool, async (c) => ({
      approvals: (
        await c.query(
          `SELECT id, code, title, details, requester_id AS "requesterId", approver_id AS "approverId", status, created_at AS "createdAt", decided_at AS "decidedAt",
                  kind, amount::float AS amount, currency, fields, template_id AS "templateId"
          FROM approvals WHERE ${role === "requester" ? "requester_id" : "approver_id"} = $1 ORDER BY created_at DESC LIMIT 100`,
          [p.id],
        )
      ).rows,
    }));
  }

  /** One approval, by its id or its code (`YC-007`, any case): its requester, its approver and WORKSPACE-level delegates may open it. */
  @Get("approvals/:ref")
  async approval(@Req() req: Request, @Param("ref") ref: string) {
    const p = requirePrincipal(req);
    return withTransaction(this.pool, async (c) => {
      const id = await resolveRef(c, "approval", ref).catch(() => null);
      if (!id) throw new NotFoundException("approval not found");
      const a = (
        await c.query(
          `SELECT id, code, title, details, requester_id AS "requesterId", approver_id AS "approverId", status, comment,
          created_at AS "createdAt", decided_at AS "decidedAt", on_behalf_of AS "onBehalfOf", kind, amount::float AS amount, currency, fields FROM approvals WHERE id = $1`,
          [id],
        )
      ).rows[0] as { requesterId: string; approverId: string; onBehalfOf: string | null } | undefined;
      const delegate = p.grants.some((g) => g.permission === "approval.decide" && g.scope === "WORKSPACE");
      if (!a) throw new NotFoundException("approval not found");
      // A request that exists but is not the caller's to see says so ("You don't have access"), as people pages do.
      if (a.requesterId !== p.id && a.approverId !== p.id && a.onBehalfOf !== p.id && !delegate) throw new ForbiddenException("not your request");
      const decider = a.approverId === p.id || delegate;
      return { ...a, canDecide: decider, canCancel: a.requesterId === p.id, ...(await approvalContext(c, p, id, a.requesterId, decider)) };
    });
  }

  /** A question or answer on a request (Vận hành › Hỏi thêm). */
  @Post("approvals/:id/comments")
  async commentApproval(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(z.object({ body: z.string().trim().min(1).max(2000) }), body);
    return guard(() => withTransaction(this.pool, (c) => commentApproval(c, p, id, b.body)));
  }

  /** The approver forwards a pending request to someone else to decide. */
  @Post("approvals/:id/forward")
  async forwardApproval(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(z.object({ toUserId: z.string().min(1).max(100), note: z.string().trim().max(500).default("") }), body);
    return guard(() => withTransaction(this.pool, (c) => forwardApproval(c, p, id, b.toUserId, b.note)));
  }

  /** Offboarding: what a person still holds (open tasks, pending approvals, decisions to settle). */
  @Get("handover/:userId")
  async handoverSummary(@Req() req: Request, @Param("userId") userId: string) {
    const p = requirePrincipal(req);
    return guard(() => withTransaction(this.pool, (c) => handoverSummary(c, p, userId)));
  }

  /** Offboarding: moves all of it to a colleague in one transaction. */
  @Post("handover/:userId")
  async handover(@Req() req: Request, @Param("userId") userId: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(z.object({ toUserId: z.string().min(1).max(100) }), body);
    return guard(() =>
      withTransaction(this.pool, async (c) => {
        const out = await handover(c, p, userId, b.toUserId);
        await recordAudit(c, { action: "work.handover.done", targetType: "member", targetId: userId, meta: { toUserId: b.toUserId } });
        return out;
      }),
    );
  }

  /** Out-of-office: my approval delegate, and who has delegated to me. */
  @Get("me/delegation")
  async myDelegation(@Req() req: Request) {
    const p = requirePrincipal(req);
    return withTransaction(this.pool, (c) => getDelegation(c, p));
  }

  @Put("me/delegation")
  async putDelegation(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const input = z.object({
      delegateId: z.string().min(1).max(100),
      until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      movePending: z.boolean().default(false),
    });
    const b = parse(input, body);
    return guard(() =>
      withTransaction(this.pool, async (c) => {
        // "Today" is the workspace's day, not the server's.
        if (b.until < dayKey(new Date(), await workspaceTimeZone(c))) throw new BadRequestException("until: must be today or later");
        return setDelegation(c, p, b);
      }),
    );
  }

  @Delete("me/delegation")
  @HttpCode(204)
  async clearDelegation(@Req() req: Request) {
    const p = requirePrincipal(req);
    await withTransaction(this.pool, (c) => setDelegation(c, p, null));
  }

  @Post("approvals/:id/cancel")
  @HttpCode(204)
  async cancelApproval(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    await withTransaction(this.pool, async (c) => {
      const r = await c.query<{ title: string; approver_id: string }>(
        "UPDATE approvals SET status = 'cancelled', decided_at = now() WHERE id = $1 AND requester_id = $2 AND status = 'pending' RETURNING title, approver_id",
        [id, p.id],
      );
      if (!r.rowCount) throw new NotFoundException("no pending request of yours");
      await emit(c, "work.approval.decided.v1", "work.approval", id, {
        approvalId: id,
        title: r.rows[0]!.title,
        requesterId: p.id,
        approverId: r.rows[0]!.approver_id,
        decision: "cancelled",
        decidedBy: p.id,
      });
    });
  }

  @Post("approvals/:id/decision")
  @HttpCode(204)
  async decide(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(approvalDecisionBody, body);
    await guard(() => withTransaction(this.pool, (c) => decideApproval(c, p, id, b.decision, b.comment)));
  }

  @Post("decisions")
  async decision(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(
      z.object({
        title: z.string().trim().min(1).max(300),
        details: z.string().max(5000).default(""),
        projectId: z.string().nullable().default(null),
        source: z
          .object({ type: z.literal("chat.message"), messageId: z.string(), channelId: z.string() })
          .nullable()
          .default(null),
        deciderId: z.string().nullable().default(null),
      }),
      body,
    );
    return guard(() => withTransaction(this.pool, (c) => recordDecision(c, p, b)));
  }

  @Post("decisions/:id/settle")
  async settle(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(z.object({ action: z.enum(["decide", "withdraw"]), title: z.string().trim().min(1).max(300).optional(), details: z.string().max(5000).optional() }), body);
    return guard(() => withTransaction(this.pool, (c) => settleDecision(c, p, id, b)));
  }

  /** Decision log, newest first. `waiting=me` lists proposals waiting for the caller; `since` limits to recent ones. */
  @Get("decisions")
  async decisions(
    @Req() req: Request,
    @Query("channelId") channelId?: string,
    @Query("projectId") projectId?: string,
    @Query("waiting") waiting?: string,
    @Query("since") since?: string,
  ) {
    const p = requirePrincipal(req);
    return withTransaction(this.pool, async (c) => ({
      decisions: (
        await c.query(
          `SELECT id, title, details, status, decided_by AS "decidedBy", decider_id AS "deciderId", proposed_by AS "proposedBy",
            project_id AS "projectId", source, created_at AS "createdAt", decided_at AS "decidedAt" FROM decisions
          WHERE ($1::text IS NULL OR source->>'channelId' = $1) AND ($2::text IS NULL OR project_id = $2)
            AND ($3::boolean IS NOT TRUE OR (status = 'proposed' AND decider_id = $4))
            AND ($5::timestamptz IS NULL OR coalesce(decided_at, created_at) >= $5)
            AND (status <> 'withdrawn' OR proposed_by = $4)
          ORDER BY coalesce(decided_at, created_at) DESC LIMIT 100`,
          [channelId ?? null, projectId ?? null, waiting === "me", p.id, since && !Number.isNaN(Date.parse(since)) ? since : null],
        )
      ).rows,
    }));
  }
}
