import type { PoolClient } from "pg";
import { asKnown, type EventEnvelope } from "@workspace/contracts";
import { projectWorkspaceTimeZone } from "@workspace/shared";

// The platform topic carries the workspace's time zone (workspace_settings), handled here too.
export const PROFILE_TOPICS = ["workspace.identity.member", "workspace.platform.workspace"];

/**
 * identity.member.joined / invited → a basic employee profile (name only) so Me,
 * the directory and leave requests work from day one. Admins enrich it later;
 * an existing profile is never overwritten. Disabling a member (offboarding) hides the
 * profile from the directory; enabling shows it again.
 */
export async function ensureProfile(event: EventEnvelope, c: PoolClient): Promise<void> {
  await projectWorkspaceTimeZone(event, c);
  const e = asKnown(event);
  if (e?.eventType === "identity.member.disabled.v1" || e?.eventType === "identity.member.enabled.v1") {
    await c.query("UPDATE employees SET active = $2 WHERE user_id = $1", [e.payload.userId, e.eventType === "identity.member.enabled.v1"]);
    return;
  }
  // The person changed their full name in Của tôi › Hồ sơ: the profile's copy follows.
  if (e?.eventType === "identity.member.renamed.v1") {
    await c.query("UPDATE employees SET display_name = $2 WHERE user_id = $1", [e.payload.userId, e.payload.displayName]);
    return;
  }
  if (e?.eventType !== "identity.member.joined.v1" && e?.eventType !== "identity.member.invited.v1") return;
  const p = e.payload;
  const exists = await c.query("SELECT 1 FROM employees WHERE user_id = $1", [p.userId]);
  if (exists.rowCount) return;
  const n = await c.query<{ value: string }>(
    `INSERT INTO code_counters (entity, value) VALUES ('employee',1)
     ON CONFLICT (entity) DO UPDATE SET value = code_counters.value + 1 RETURNING value`,
  );
  const name = p.displayName?.trim() || p.email?.split("@")[0] || "Employee";
  await c.query("INSERT INTO employees (user_id, code, display_name) VALUES ($1,$2,$3) ON CONFLICT (user_id) DO NOTHING", [
    p.userId,
    `EMP-${n.rows[0]!.value.padStart(6, "0")}`,
    name,
  ]);
}
