import type { PoolClient } from "pg";
import { TZ_SQL } from "./settings.js";
import { authorize, newId, type Principal } from "@workspace/shared";
import { emit, requireAny } from "./common.js";
import { nextCode } from "./codes.js";
import { Conflict, Forbidden, Invalid, NotFound } from "./errors.js";

/** The person's delegate while they are away (until_date inclusive, in the workspace's zone), or null. */
async function activeDelegate(c: PoolClient, userId: string): Promise<string | null> {
  const r = await c.query<{ delegate_id: string }>(`SELECT delegate_id FROM approval_delegations WHERE user_id = $1 AND until_date >= (now() AT TIME ZONE ${TZ_SQL})::date`, [
    userId,
  ]);
  return r.rows[0]?.delegate_id ?? null;
}

export type RequestKind = "purchase" | "payment" | "advance" | "trip" | "other";
export async function requestApproval(
  c: PoolClient,
  p: Principal,
  input: {
    title: string;
    details: string;
    approverId: string;
    kind?: RequestKind;
    /** Money asked for, in `currency` (ISO 4217); null when the request is not about money. */
    amount?: number | null;
    currency?: string | null;
    fields?: Record<string, string>;
    templateId?: string | null;
  },
) {
  if (input.approverId === p.id) throw new Invalid("cannot approve your own request");
  const id = newId();
  // Away with a delegate: the delegate decides (never the requester themselves).
  const delegate = await activeDelegate(c, input.approverId);
  const approverId = delegate && delegate !== p.id ? delegate : input.approverId;
  const onBehalfOf = approverId !== input.approverId ? input.approverId : null;
  const amount = input.amount ?? null;
  const currency = amount === null ? null : (input.currency ?? "VND");
  const code = await nextCode(c, "request", id);
  await c.query(
    "INSERT INTO approvals (id, title, details, requester_id, approver_id, on_behalf_of, kind, amount, currency, fields, template_id, code) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
    [
      id,
      input.title,
      input.details,
      p.id,
      approverId,
      onBehalfOf,
      input.templateId ? "other" : (input.kind ?? "other"),
      amount,
      currency,
      JSON.stringify(input.fields ?? {}),
      input.templateId ?? null,
      code,
    ],
  );
  await emit(c, "work.approval.requested.v1", "work.approval", id, {
    approvalId: id,
    code,
    title: input.title,
    requesterId: p.id,
    approverId,
    kind: input.kind ?? "other",
    amount,
    currency,
    ...(onBehalfOf ? { onBehalfOf } : {}),
  });
  return { id, code, approverId, onBehalfOf };
}

/**
 * Sets (or clears) my out-of-office delegate. Optionally hands my pending approvals to them now;
 * they are re-announced so the delegate sees them in Needs You.
 */
export async function setDelegation(c: PoolClient, p: Principal, input: { delegateId: string; until: string; movePending: boolean } | null) {
  if (!input) {
    await c.query("DELETE FROM approval_delegations WHERE user_id = $1", [p.id]);
    await emit(c, "work.delegation.cleared.v1", "work.delegation", p.id, { userId: p.id });
    return { delegation: null, moved: 0 };
  }
  if (input.delegateId === p.id) throw new Invalid("choose someone else");
  await c.query(
    `INSERT INTO approval_delegations (user_id, delegate_id, until_date) VALUES ($1,$2,$3)
     ON CONFLICT (user_id) DO UPDATE SET delegate_id = EXCLUDED.delegate_id, until_date = EXCLUDED.until_date, created_at = now()`,
    [p.id, input.delegateId, input.until],
  );
  let moved = 0;
  if (input.movePending) {
    const rows = (
      await c.query<{ id: string; title: string; requester_id: string }>(
        "UPDATE approvals SET approver_id = $2, on_behalf_of = $1 WHERE approver_id = $1 AND status = 'pending' AND requester_id <> $2 RETURNING id, title, requester_id",
        [p.id, input.delegateId],
      )
    ).rows;
    for (const a of rows)
      await emit(c, "work.approval.requested.v1", "work.approval", a.id, {
        approvalId: a.id,
        title: a.title,
        requesterId: a.requester_id,
        approverId: input.delegateId,
        onBehalfOf: p.id,
      });
    moved = rows.length;
  }
  await emit(c, "work.delegation.set.v1", "work.delegation", p.id, { userId: p.id, delegateId: input.delegateId, until: input.until });
  return { delegation: { delegateId: input.delegateId, until: input.until }, moved };
}

export async function getDelegation(c: PoolClient, p: Principal) {
  const r = await c.query<{ delegateId: string; until: string; active: boolean }>(
    `SELECT delegate_id AS "delegateId", to_char(until_date, 'YYYY-MM-DD') AS until, until_date >= (now() AT TIME ZONE ${TZ_SQL})::date AS active
       FROM approval_delegations WHERE user_id = $1`,
    [p.id],
  );
  // Who has delegated to me right now (so I know why approvals arrive "on behalf of").
  const forMe = (
    await c.query<{ userId: string; until: string }>(
      `SELECT user_id AS "userId", to_char(until_date, 'YYYY-MM-DD') AS until FROM approval_delegations
      WHERE delegate_id = $1 AND until_date >= (now() AT TIME ZONE ${TZ_SQL})::date`,
      [p.id],
    )
  ).rows;
  return { delegation: r.rows[0] ?? null, forMe };
}

/** Only the named approver decides (or approval.decide at WORKSPACE for delegates). One decision, no flip-flop. */
export async function decideApproval(c: PoolClient, p: Principal, id: string, decision: "approved" | "rejected", comment: string | null) {
  const r = await c.query<{ approver_id: string; requester_id: string; status: string; title: string }>(
    "SELECT approver_id, requester_id, status, title FROM approvals WHERE id = $1 FOR UPDATE",
    [id],
  );
  const a = r.rows[0];
  if (!a) throw new NotFound("approval not found");
  const isApprover = a.approver_id === p.id;
  const isDelegate = p.grants.some((g) => g.permission === "approval.decide" && g.scope === "WORKSPACE") && authorize(p, "approval.decide").allowed;
  if (!isApprover && !isDelegate) throw new Forbidden("not the approver");
  if (a.status !== "pending") throw new Conflict("already decided", { status: a.status });
  await c.query("UPDATE approvals SET status = $2, comment = $3, decided_at = now() WHERE id = $1", [id, decision, comment]);
  await emit(c, "work.approval.decided.v1", "work.approval", id, {
    approvalId: id,
    title: a.title,
    requesterId: a.requester_id,
    approverId: a.approver_id,
    decision,
    decidedBy: p.id,
  });
}

type DecisionSource = { type: "chat.message"; messageId: string; channelId: string } | null;

/**
 * Records a decision. With a deciderId other than the author it is only
 * proposed, and waits in that person's Needs You until they settle it.
 */
export async function recordDecision(
  c: PoolClient,
  p: Principal,
  input: { title: string; details: string; projectId: string | null; source: DecisionSource; deciderId?: string | null },
) {
  requireAny(p, "task.create", [{}]);
  const id = newId();
  const proposed = !!input.deciderId && input.deciderId !== p.id;
  await c.query(
    `INSERT INTO decisions (id, title, details, decided_by, project_id, source, status, decider_id, proposed_by, decided_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      id,
      input.title,
      input.details,
      proposed ? null : p.id,
      input.projectId,
      input.source ? JSON.stringify(input.source) : null,
      proposed ? "proposed" : "decided",
      proposed ? input.deciderId : p.id,
      p.id,
      proposed ? null : new Date(),
    ],
  );
  if (proposed) {
    await emit(c, "work.decision.proposed.v1", "work.decision", id, {
      decisionId: id,
      title: input.title,
      details: input.details,
      projectId: input.projectId,
      deciderId: input.deciderId,
      proposedBy: p.id,
      source: input.source,
    });
  } else {
    await emit(c, "work.decision.created.v1", "work.decision", id, {
      decisionId: id,
      title: input.title,
      projectId: input.projectId,
      decidedBy: p.id,
      proposedBy: p.id,
      source: input.source,
    });
  }
  return { id, status: proposed ? "proposed" : "decided" };
}

/** The named decider settles a proposal (optionally rewording it), or the proposer withdraws it. */
export async function settleDecision(c: PoolClient, p: Principal, id: string, input: { action: "decide" | "withdraw"; title?: string | undefined; details?: string | undefined }) {
  const d = (
    await c.query<{ title: string; details: string; status: string; decider_id: string | null; proposed_by: string | null; project_id: string | null; source: DecisionSource }>(
      "SELECT title, details, status, decider_id, proposed_by, project_id, source FROM decisions WHERE id = $1 FOR UPDATE",
      [id],
    )
  ).rows[0];
  if (!d) throw new NotFound("decision not found");
  if (d.status !== "proposed") throw new Conflict("decision already settled", {});
  if (input.action === "decide" && d.decider_id !== p.id) throw new Forbidden("only the named decider can settle this");
  if (input.action === "withdraw" && d.proposed_by !== p.id) throw new Forbidden("only the proposer can withdraw this");
  const title = input.title ?? d.title;
  const details = input.details ?? d.details;
  if (input.action === "withdraw") {
    await c.query("UPDATE decisions SET status = 'withdrawn', decided_at = now() WHERE id = $1", [id]);
    await emit(c, "work.decision.withdrawn.v1", "work.decision", id, { decisionId: id, title, deciderId: d.decider_id, proposedBy: d.proposed_by });
    return { id, status: "withdrawn" };
  }
  await c.query("UPDATE decisions SET status = 'decided', decided_by = $2, decided_at = now(), title = $3, details = $4 WHERE id = $1", [id, p.id, title, details]);
  await emit(c, "work.decision.created.v1", "work.decision", id, { decisionId: id, title, projectId: d.project_id, decidedBy: p.id, proposedBy: d.proposed_by, source: d.source });
  return { id, status: "decided" };
}

type ApprovalRow = { approver_id: string; requester_id: string; status: string; title: string; on_behalf_of: string | null };

async function lockApproval(c: PoolClient, id: string): Promise<ApprovalRow> {
  const a = (await c.query<ApprovalRow>("SELECT approver_id, requester_id, status, title, on_behalf_of FROM approvals WHERE id = $1 FOR UPDATE", [id])).rows[0];
  if (!a) throw new NotFound("approval not found");
  return a;
}

const canDecide = (p: Principal, a: ApprovalRow) =>
  a.approver_id === p.id || (p.grants.some((g) => g.permission === "approval.decide" && g.scope === "WORKSPACE") && authorize(p, "approval.decide").allowed);

/** A question or answer on a request, between the requester and whoever decides it. The other side is notified. */
export async function commentApproval(c: PoolClient, p: Principal, id: string, body: string) {
  const a = await lockApproval(c, id);
  const requester = a.requester_id === p.id;
  if (!requester && !canDecide(p, a)) throw new NotFound("approval not found");
  const eventId = newId();
  await c.query("INSERT INTO approval_events (id, approval_id, actor_id, kind, body) VALUES ($1,$2,$3,'comment',$4)", [eventId, id, p.id, body]);
  await emit(c, "work.approval.commented.v1", "work.approval", id, {
    approvalId: id,
    title: a.title,
    authorId: p.id,
    recipientId: requester ? a.approver_id : a.requester_id,
    body: body.slice(0, 200),
  });
  return { id: eventId };
}

/**
 * The approver hands a pending request to a better-placed colleague (finance, their own manager…).
 * It is re-announced to them like a new request.
 */
export async function forwardApproval(c: PoolClient, p: Principal, id: string, toUserId: string, note: string) {
  const a = await lockApproval(c, id);
  if (!canDecide(p, a)) throw new Forbidden("not the approver");
  if (a.status !== "pending") throw new Conflict("already decided", { status: a.status });
  if (toUserId === a.requester_id) throw new Invalid("cannot approve your own request");
  if (toUserId === a.approver_id) throw new Invalid("already the approver");
  await c.query("UPDATE approvals SET approver_id = $2, on_behalf_of = NULL WHERE id = $1", [id, toUserId]);
  await c.query("INSERT INTO approval_events (id, approval_id, actor_id, kind, body, target_id) VALUES ($1,$2,$3,'forwarded',$4,$5)", [newId(), id, p.id, note, toUserId]);
  await emit(c, "work.approval.requested.v1", "work.approval", id, { approvalId: id, title: a.title, requesterId: a.requester_id, approverId: toUserId });
  return { approverId: toUserId };
}

/** The request's thread (oldest first) and, for the approver, how this person's requests went over the last 90 days. */
export async function approvalContext(c: PoolClient, p: Principal, id: string, requesterId: string, decider: boolean) {
  const events = (
    await c.query(
      `SELECT id, actor_id AS "actorId", kind, body, target_id AS "targetId", created_at AS "createdAt" FROM approval_events WHERE approval_id = $1 ORDER BY created_at LIMIT 200`,
      [id],
    )
  ).rows;
  if (!decider) return { events, requesterStats: null };
  const s = (
    await c.query<{ total: string; approved: string; rejected: string; amount: string | null; currency: string | null }>(
      // Money approved before is summed in this request's currency only (mixing currencies would mislead).
      `SELECT count(a.id) AS total, count(a.id) FILTER (WHERE a.status = 'approved') AS approved, count(a.id) FILTER (WHERE a.status = 'rejected') AS rejected,
              sum(a.amount) FILTER (WHERE a.status = 'approved' AND a.currency = cur.currency) AS amount, cur.currency
         FROM (SELECT currency FROM approvals WHERE id = $2) cur
         LEFT JOIN approvals a ON a.requester_id = $1 AND a.id <> $2 AND a.created_at > now() - interval '90 days'
        GROUP BY cur.currency`,
      [requesterId, id],
    )
  ).rows[0] ?? { total: "0", approved: "0", rejected: "0", amount: null, currency: null };
  const approvedAmount = s.amount ? Number(s.amount) : 0;
  return {
    events,
    requesterStats: {
      total: Number(s.total),
      approved: Number(s.approved),
      rejected: Number(s.rejected),
      approvedAmount,
      currency: s.currency,
      approvedAmountVnd: s.currency === "VND" ? Math.round(approvedAmount) : 0,
    },
  };
}
