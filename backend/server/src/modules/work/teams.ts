import type { PoolClient } from "pg";
import { asKnown, type EventEnvelope } from "@workspace/contracts";

export const TEAM_TOPICS = ["workspace.identity.team"];

/**
 * Teams live in identity; projects and tasks only carry the id for TEAM-scope grants. When a team is
 * deleted the id would dangle (no grant can match it any more), so the projection clears it.
 */
export async function applyTeamEvent(event: EventEnvelope, c: PoolClient): Promise<void> {
  const e = asKnown(event);
  if (e?.eventType !== "identity.team.deleted.v1") return;
  await c.query("UPDATE projects SET team_id = NULL WHERE team_id = $1", [e.payload.teamId]);
  await c.query("UPDATE tasks SET team_id = NULL WHERE team_id = $1", [e.payload.teamId]);
}
