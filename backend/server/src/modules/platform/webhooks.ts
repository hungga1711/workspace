import { createHmac, randomBytes } from "node:crypto";
import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Inject, NotFoundException, Param, Patch, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import type { EventEnvelope } from "@workspace/contracts";
import { getRequestContext, newId, runWithContext, withTransaction } from "@workspace/shared";
import { assertAllowed, checkPublicUrl, logger, requestPublic, requirePrincipal } from "@workspace/service-kit";
import { audit, POOL } from "./common.js";

/** Every webhook change is audited: webhooks send workspace data out of workspace. */
const auditHook = (c: PoolClient, action: string, id: string, metadata: Record<string, unknown> = {}) => {
  return audit(c, getRequestContext().actorId, action, "webhook", id, metadata);
};

/** Events a workspace may subscribe to. Chat message bodies are deliberately not offered. */
export const WEBHOOK_EVENTS: Record<string, { vi: string; en: string }> = {
  "work.task.created.v1": { vi: "Việc được tạo", en: "Task created" },
  "work.task.updated.v1": { vi: "Việc được cập nhật", en: "Task updated" },
  "work.task.completed.v1": { vi: "Việc hoàn thành", en: "Task completed" },
  "work.project.created.v1": { vi: "Dự án được tạo", en: "Project created" },
  "work.approval.requested.v1": { vi: "Yêu cầu phê duyệt", en: "Approval requested" },
  "work.approval.decided.v1": { vi: "Yêu cầu phê duyệt đã có kết quả", en: "Approval decided" },
  "work.decision.created.v1": { vi: "Quyết định được chốt", en: "Decision made" },
  // Agent workflow runs: what an integration acts on (a run to watch, a person needed, a result to pick up).
  "work.run.started.v1": { vi: "Workflow bắt đầu chạy trên một việc", en: "Workflow run started" },
  "work.run.asked.v1": { vi: "Workflow hỏi người làm việc", en: "Workflow run asks people a question" },
  "work.run.waiting.v1": { vi: "Workflow chờ phê duyệt", en: "Workflow run waits for approval" },
  "work.run.finished.v1": { vi: "Workflow chạy xong hoặc thất bại", en: "Workflow run finished or failed" },
  "work.run.cancelled.v1": { vi: "Workflow bị dừng", en: "Workflow run stopped" },
  "employee.leave.requested.v1": { vi: "Đơn nghỉ phép mới", en: "Leave request submitted" },
  "employee.leave.decided.v1": { vi: "Đơn nghỉ phép đã có kết quả", en: "Leave request decided" },
  "identity.member.joined.v1": { vi: "Thành viên mới tham gia", en: "Member joined" },
  "identity.member.disabled.v1": { vi: "Thành viên bị vô hiệu hoá", en: "Member disabled" },
  "identity.member.enabled.v1": { vi: "Thành viên được kích hoạt lại", en: "Member re-enabled" },
  "employee.announcement.published.v1": { vi: "Thông báo công ty mới", en: "Company announcement published" },
  "chat.channel.created.v1": { vi: "Kênh chat được tạo", en: "Chat channel created" },
};
/** The event catalogue with labels in the caller's UI language (x-locale, forwarded by the gateway). */
function webhookEventLabels(req: { headers: Record<string, unknown> }): Record<string, string> {
  const lang = req.headers["x-locale"] === "vi" ? "vi" : "en";
  return Object.fromEntries(Object.entries(WEBHOOK_EVENTS).map(([k, v]) => [k, v[lang]]));
}
export const WEBHOOK_TOPICS = [...new Set(Object.keys(WEBHOOK_EVENTS).map((t) => `workspace.${t.split(".").slice(0, 2).join(".")}`))];
const BACKOFF_S = [60, 300, 1800, 7200, 21600];
const DISABLE_AFTER = 20;
const DROP_FIELDS = new Set(["text"]); // full document text never leaves through webhooks

export interface WebhookOptions {
  allowPrivate: boolean;
}

/** SSRF guard: https only, and the host must not resolve to a private or loopback address. */
export const checkTarget = (raw: string, opts: WebhookOptions) => checkPublicUrl(raw, opts.allowPrivate);

/** POSTs once (no redirects, private addresses refused at connect) within 10 s; resolves with the response status. */
export const post = (url: string, headers: Record<string, string>, body: string, opts: WebhookOptions) =>
  requestPublic(url, { method: "POST", headers, body, allowPrivate: opts.allowPrivate }).then((r) => r.status);

export function sign(secret: string, timestamp: number, body: string): string {
  return `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

function clean(payload: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(payload).filter(([k]) => !DROP_FIELDS.has(k)));
}

/** Consumer: one pending delivery per active webhook subscribed to the event. Idempotent per (webhook, event). */
export async function enqueueWebhookDeliveries(e: EventEnvelope, c: PoolClient): Promise<void> {
  if (!WEBHOOK_EVENTS[e.eventType]) return;
  const hooks = (await c.query<{ id: string }>("SELECT id FROM webhooks WHERE active AND $1 = ANY (events)", [e.eventType])).rows;
  for (const h of hooks) {
    const body = { id: e.eventId, type: e.eventType, occurredAt: e.occurredAt, data: clean(e.payload as Record<string, unknown>) };
    await c.query("INSERT INTO webhook_deliveries (id, webhook_id, event_id, event_type, body) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING", [
      newId(),
      h.id,
      e.eventId,
      e.eventType,
      JSON.stringify(body),
    ]);
  }
}

/** Worker: delivers due webhooks. Returns how many were attempted. */
export async function deliverDue(pool: Pool, opts: WebhookOptions, limit = 20): Promise<number> {
  const due = (await pool.query<{ id: string }>("SELECT * FROM claim_webhook_deliveries($1)", [limit])).rows;
  for (const d of due) {
    await runWithContext({ actorId: "service:webhooks", requestId: newId() }, () => deliverOne(pool, d.id, opts)).catch((err) =>
      logger.warn({ err, delivery: d.id }, "webhook delivery crashed"),
    );
  }
  return due.length;
}

async function deliverOne(pool: Pool, id: string, opts: WebhookOptions) {
  const row = (
    await pool.query<{ webhook_id: string; event_type: string; body: unknown; attempts: number; url: string; secret: string; active: boolean }>(
      `SELECT d.webhook_id, d.event_type, d.body, d.attempts, w.url, w.secret, w.active FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id
      WHERE d.id = $1 AND d.status = 'pending'`,
      [id],
    )
  ).rows[0];
  if (!row) return;
  let status: number | null = null;
  let error: string | null = null;
  if (!row.active) error = "webhook is disabled";
  else {
    const problem = await checkTarget(row.url, opts);
    if (problem) error = problem;
    else {
      const body = JSON.stringify(row.body);
      const ts = Math.floor(Date.now() / 1000);
      try {
        status = await post(
          row.url,
          {
            "content-type": "application/json",
            "user-agent": "workspace-Webhooks/1",
            "x-workspace-event": row.event_type,
            "x-workspace-delivery": id,
            "x-workspace-signature": sign(row.secret, ts, body),
          },
          body,
          opts,
        );
        if (status < 200 || status >= 300) error = `HTTP ${status}`;
      } catch (e) {
        error = (e as Error).message.slice(0, 200);
      }
    }
  }
  const attempts = row.attempts + 1;
  await withTransaction(pool, async (c) => {
    if (!error) {
      await c.query("UPDATE webhook_deliveries SET status = 'succeeded', attempts = $2, response_status = $3, error = NULL, delivered_at = now() WHERE id = $1", [
        id,
        attempts,
        status,
      ]);
      await c.query("UPDATE webhooks SET failure_count = 0 WHERE id = $1", [row.webhook_id]);
      return;
    }
    const final = attempts > BACKOFF_S.length || !row.active;
    await c.query(`UPDATE webhook_deliveries SET status = $2, attempts = $3, response_status = $4, error = $5, next_attempt_at = now() + make_interval(secs => $6) WHERE id = $1`, [
      id,
      final ? "failed" : "pending",
      attempts,
      status,
      error,
      BACKOFF_S[Math.min(attempts - 1, BACKOFF_S.length - 1)],
    ]);
    const w = (await c.query<{ failure_count: number }>("UPDATE webhooks SET failure_count = failure_count + 1 WHERE id = $1 RETURNING failure_count", [row.webhook_id])).rows[0];
    // A reason code, not text: the admin screen words it in the reader's language.
    if (w && w.failure_count >= DISABLE_AFTER) await c.query("UPDATE webhooks SET active = false, disabled_reason = 'auto_disabled_failures' WHERE id = $1", [row.webhook_id]);
  });
}

const hookCols = `id, url, description, events, active, failure_count AS "failureCount", disabled_reason AS "disabledReason", created_by AS "createdBy", created_at AS "createdAt"`;

@Controller("workspace/webhooks")
export class WebhooksController {
  constructor(
    @Inject(POOL) private readonly pool: Pool,
    @Inject("WEBHOOK_OPTIONS") private readonly opts: WebhookOptions,
  ) {}

  private guard(req: Request) {
    const p = requirePrincipal(req);
    assertAllowed(p, "workspace.configure");
    return p;
  }

  @Get()
  async list(@Req() req: Request) {
    this.guard(req);
    return withTransaction(this.pool, async (c) => ({
      webhooks: (
        await c.query(`SELECT ${hookCols},
          (SELECT row_to_json(x) FROM (SELECT status, response_status AS "responseStatus", created_at AS "at" FROM webhook_deliveries d WHERE d.webhook_id = w.id ORDER BY created_at DESC LIMIT 1) x) AS "lastDelivery"
          FROM webhooks w ORDER BY created_at DESC`)
      ).rows,
      events: webhookEventLabels(req),
    }));
  }

  @Post()
  async create(@Req() req: Request, @Body() body: unknown) {
    const p = this.guard(req);
    const b = z.object({ url: z.string().max(1000), description: z.string().max(200).default(""), events: z.array(z.string()).min(1).max(50) }).safeParse(body);
    if (!b.success) throw new BadRequestException("url and at least one event are required");
    const bad = b.data.events.find((e) => !WEBHOOK_EVENTS[e]);
    if (bad) throw new BadRequestException(`unknown event: ${bad}`);
    const problem = await checkTarget(b.data.url, this.opts);
    if (problem) throw new BadRequestException(problem);
    const id = newId();
    const secret = `whsec_${randomBytes(24).toString("base64url")}`;
    await withTransaction(this.pool, async (c) => {
      await c.query("INSERT INTO webhooks (id, url, description, events, secret, created_by) VALUES ($1,$2,$3,$4,$5,$6)", [
        id,
        b.data.url,
        b.data.description,
        [...new Set(b.data.events)],
        secret,
        p.id,
      ]);
      await auditHook(c, "webhook.create", id, { url: b.data.url, events: [...new Set(b.data.events)] });
    });
    return { id, secret };
  }

  @Patch(":id")
  async update(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    this.guard(req);
    const b = z
      .object({
        url: z.string().max(1000).optional(),
        description: z.string().max(200).optional(),
        events: z.array(z.string()).min(1).max(50).optional(),
        active: z.boolean().optional(),
      })
      .safeParse(body);
    if (!b.success) throw new BadRequestException("invalid webhook");
    if (b.data.events?.some((e) => !WEBHOOK_EVENTS[e])) throw new BadRequestException("unknown event");
    if (b.data.url) {
      const problem = await checkTarget(b.data.url, this.opts);
      if (problem) throw new BadRequestException(problem);
    }
    return withTransaction(this.pool, async (c) => {
      const r = await c.query(
        `UPDATE webhooks SET url = coalesce($2, url), description = coalesce($3, description), events = coalesce($4, events), active = coalesce($5, active),
          failure_count = CASE WHEN $5 THEN 0 ELSE failure_count END, disabled_reason = CASE WHEN $5 THEN NULL ELSE disabled_reason END WHERE id = $1 RETURNING ${hookCols}`,
        [id, b.data.url ?? null, b.data.description ?? null, b.data.events ?? null, b.data.active ?? null],
      );
      if (!r.rowCount) throw new NotFoundException("webhook not found");
      await auditHook(c, "webhook.update", id, Object.fromEntries(Object.entries(b.data).filter(([, v]) => v !== undefined)));
      return r.rows[0];
    });
  }

  @Delete(":id")
  @HttpCode(204)
  async remove(@Req() req: Request, @Param("id") id: string) {
    this.guard(req);
    await withTransaction(this.pool, async (c) => {
      await c.query("DELETE FROM webhook_deliveries WHERE webhook_id = $1", [id]);
      const r = await c.query("DELETE FROM webhooks WHERE id = $1 RETURNING url", [id]);
      if (!r.rowCount) throw new NotFoundException("webhook not found");
      await auditHook(c, "webhook.delete", id, { url: r.rows[0].url });
    });
  }

  @Post(":id/rotate-secret")
  async rotate(@Req() req: Request, @Param("id") id: string) {
    this.guard(req);
    const secret = `whsec_${randomBytes(24).toString("base64url")}`;
    await withTransaction(this.pool, async (c) => {
      const r = await c.query("UPDATE webhooks SET secret = $2 WHERE id = $1", [id, secret]);
      if (!r.rowCount) throw new NotFoundException("webhook not found");
      await auditHook(c, "webhook.rotate_secret", id);
    });
    return { secret };
  }

  /** Sends a "webhook.ping" through the normal delivery path. */
  @Post(":id/test")
  async test(@Req() req: Request, @Param("id") id: string) {
    this.guard(req);
    const deliveryId = newId();
    await withTransaction(this.pool, async (c) => {
      if (!(await c.query("SELECT 1 FROM webhooks WHERE id = $1", [id])).rowCount) throw new NotFoundException("webhook not found");
      const eventId = newId();
      // Due later, so the background worker does not pick the ping up while it is being sent here.
      await c.query(
        "INSERT INTO webhook_deliveries (id, webhook_id, event_id, event_type, body, next_attempt_at) VALUES ($1,$2,$3,'webhook.ping',$4, now() + interval '2 minutes')",
        [deliveryId, id, eventId, JSON.stringify({ id: eventId, type: "webhook.ping", occurredAt: new Date().toISOString(), data: { message: "Hello from workspace" } })],
      );
    });
    await deliverOne(this.pool, deliveryId, this.opts);
    return withTransaction(
      this.pool,
      async (c) => (await c.query(`SELECT status, response_status AS "responseStatus", error FROM webhook_deliveries WHERE id = $1`, [deliveryId])).rows[0],
    );
  }

  @Get(":id/deliveries")
  async deliveries(@Req() req: Request, @Param("id") id: string) {
    this.guard(req);
    return withTransaction(this.pool, async (c) => ({
      deliveries: (
        await c.query(
          `SELECT id, event_type AS "eventType", status, attempts, response_status AS "responseStatus", error, created_at AS "createdAt", delivered_at AS "deliveredAt", next_attempt_at AS "nextAttemptAt"
          FROM webhook_deliveries WHERE webhook_id = $1 ORDER BY created_at DESC LIMIT 50`,
          [id],
        )
      ).rows,
    }));
  }

  @Post(":id/deliveries/:deliveryId/redeliver")
  @HttpCode(202)
  async redeliver(@Req() req: Request, @Param("id") id: string, @Param("deliveryId") deliveryId: string) {
    this.guard(req);
    await withTransaction(this.pool, async (c) => {
      const r = await c.query("UPDATE webhook_deliveries SET status = 'pending', attempts = 0, next_attempt_at = now() WHERE id = $1 AND webhook_id = $2", [deliveryId, id]);
      if (!r.rowCount) throw new NotFoundException("delivery not found");
    });
    return { queued: true };
  }
}
