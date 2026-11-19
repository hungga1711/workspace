import type { PoolClient } from "pg";
import { asKnown, type EventEnvelope } from "@workspace/contracts";
import { WORKSPACE_TZ_SQL } from "@workspace/shared";

export const DELEGATION_TOPICS = ["workspace.work.delegation"];

/** Projects out-of-office delegates set in Me (the work module owns them). */
export async function handleDelegation(event: EventEnvelope, c: PoolClient): Promise<void> {
  const e = asKnown(event);
  if (e?.eventType === "work.delegation.cleared.v1") {
    await c.query("DELETE FROM delegations WHERE user_id = $1", [e.payload.userId]);
    return;
  }
  if (e?.eventType !== "work.delegation.set.v1") return;
  const p = e.payload;
  await c.query(
    `INSERT INTO delegations (user_id, delegate_id, until_date) VALUES ($1,$2,$3)
     ON CONFLICT (user_id) DO UPDATE SET delegate_id = EXCLUDED.delegate_id, until_date = EXCLUDED.until_date`,
    [p.userId, p.delegateId, p.until],
  );
}

/** The approver for a leave request: the manager, or their delegate while they are away (never the requester). */
export async function leaveApprover(c: PoolClient, managerId: string | null, requesterId: string): Promise<{ approverId: string | null; onBehalfOf: string | null }> {
  if (!managerId) return { approverId: null, onBehalfOf: null };
  const d = (
    await c.query<{ delegate_id: string }>(`SELECT delegate_id FROM delegations WHERE user_id = $1 AND until_date >= (now() AT TIME ZONE ${WORKSPACE_TZ_SQL})::date`, [managerId])
  ).rows[0]?.delegate_id;
  return d && d !== requesterId ? { approverId: d, onBehalfOf: managerId } : { approverId: managerId, onBehalfOf: null };
}
