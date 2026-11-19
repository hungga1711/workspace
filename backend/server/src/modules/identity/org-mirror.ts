import type { PoolClient } from "pg";
import { asKnown, type EventEnvelope } from "@workspace/contracts";

export const ORG_TOPICS = ["workspace.employee.profile"];

/**
 * DEPARTMENT-scope grants are checked against the principal's department, and principals are built here in
 * identity, while the org chart (who is in which department) lives in the employee module. Employee publishes
 * every department change as `employee.profile.updated.v1`; this projection keeps `members.department_id` in
 * step so `resolvePrincipal` has the answer without a cross-module call per request (ADR 0018).
 */
export async function mirrorDepartment(event: EventEnvelope, c: PoolClient): Promise<void> {
  const e = asKnown(event);
  if (e?.eventType !== "employee.profile.updated.v1") return;
  await c.query("UPDATE members SET department_id = $2 WHERE user_id = $1 AND department_id IS DISTINCT FROM $2", [e.payload.userId, e.payload.departmentId]);
}
