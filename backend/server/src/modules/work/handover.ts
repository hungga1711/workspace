import type { PoolClient } from "pg";
import type { Principal } from "@workspace/shared";
import { activity, allowedAny, emit } from "./common.js";
import { Forbidden, Invalid } from "./errors.js";
import { updateTask } from "./tasks.js";

/**
 * Offboarding handover: what a leaver still holds, and moving it to a colleague in one
 * step. Admin only (member.manage). Each task goes through updateTask, so versions, activity and events
 * behave exactly as for a manual reassignment; pending approvals and proposed decisions are
 * re-announced so the new person sees them in Needs You.
 */
const requireAdmin = (p: Principal) => {
  if (!allowedAny(p, "member.manage", [{}])) throw new Forbidden("member.manage required");
};

export async function handoverSummary(c: PoolClient, p: Principal, userId: string) {
  requireAdmin(p);
  const r = await c.query<{ tasks: number; approvals: number; decisions: number; projects: number }>(
    `SELECT (SELECT count(*)::int FROM tasks WHERE assignee_id = $1 AND status NOT IN ('done', 'cancelled')) AS tasks,
            (SELECT count(*)::int FROM projects WHERE owner_id = $1 AND status = 'active') AS projects,
            (SELECT count(*)::int FROM approvals WHERE approver_id = $1 AND status = 'pending') AS approvals,
            (SELECT count(*)::int FROM decisions WHERE decider_id = $1 AND status = 'proposed') AS decisions`,
    [userId],
  );
  return r.rows[0]!;
}

export async function handover(c: PoolClient, p: Principal, fromUserId: string, toUserId: string) {
  requireAdmin(p);
  if (fromUserId === toUserId) throw new Invalid("choose a different person to hand over to");
  const tasks = (
    await c.query<{ id: string; version: number }>("SELECT id, version FROM tasks WHERE assignee_id = $1 AND status NOT IN ('done', 'cancelled') ORDER BY created_at FOR UPDATE", [
      fromUserId,
    ])
  ).rows;
  for (const t of tasks) await updateTask(c, p, t.id, { expectedVersion: t.version, assigneeId: toUserId });

  const approvals = (
    await c.query<{ id: string; title: string; requester_id: string }>(
      "UPDATE approvals SET approver_id = $2 WHERE approver_id = $1 AND status = 'pending' RETURNING id, title, requester_id",
      [fromUserId, toUserId],
    )
  ).rows;
  for (const a of approvals) {
    await activity(c, "approval", a.id, "handed_over", { from: fromUserId, to: toUserId });
    await emit(c, "work.approval.requested.v1", "work.approval", a.id, { approvalId: a.id, title: a.title, requesterId: a.requester_id, approverId: toUserId });
  }

  const decisions = (
    await c.query<{ id: string; title: string; details: string; project_id: string | null; proposed_by: string; source: unknown }>(
      "UPDATE decisions SET decider_id = $2 WHERE decider_id = $1 AND status = 'proposed' RETURNING id, title, details, project_id, proposed_by, source",
      [fromUserId, toUserId],
    )
  ).rows;
  for (const d of decisions) {
    await activity(c, "decision", d.id, "handed_over", { from: fromUserId, to: toUserId });
    await emit(c, "work.decision.proposed.v1", "work.decision", d.id, {
      decisionId: d.id,
      title: d.title,
      details: d.details,
      projectId: d.project_id,
      deciderId: toUserId,
      proposedBy: d.proposed_by,
      source: d.source,
    });
  }
  // Active projects get a new owner (archived ones keep their history as it was).
  const projects = (
    await c.query<{ id: string; code: string; name: string; description: string; owner_id: string; due_at: Date | null; status: string }>(
      "UPDATE projects SET owner_id = $2, version = version + 1, updated_at = now() WHERE owner_id = $1 AND status = 'active' RETURNING id, code, name, description, owner_id, due_at, status",
      [fromUserId, toUserId],
    )
  ).rows;
  for (const pr of projects) {
    const changes = { owner_id: { from: fromUserId, to: toUserId } };
    await activity(c, "project", pr.id, "updated", changes);
    await emit(c, "work.project.updated.v1", "work.project", pr.id, {
      projectId: pr.id,
      code: pr.code,
      name: pr.name,
      description: pr.description,
      ownerId: pr.owner_id,
      dueAt: pr.due_at,
      status: pr.status,
      changes,
    });
  }
  return { tasks: tasks.length, approvals: approvals.length, decisions: decisions.length, projects: projects.length };
}
