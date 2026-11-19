import { newId } from "@workspace/shared";
import type { PoolClient } from "pg";

/**
 * Weekly project status updates (migrations/work/009): two lines and a health call from whoever leads the project.
 * What the boss reads on the projects page and a project's Overview, in place of per-task progress check-ins.
 */
export type UpdateHealth = "on_track" | "at_risk" | "off_track";

export interface ProjectUpdate {
  id: string;
  projectId: string;
  authorId: string;
  health: UpdateHealth;
  body: string;
  suggested: boolean;
  at: string;
}

const COLS = `id, project_id AS "projectId", author_id AS "authorId", health, body, suggested, created_at AS "at"`;

export async function postUpdate(c: PoolClient, authorId: string, projectId: string, b: { health: UpdateHealth; body: string; suggested: boolean }): Promise<ProjectUpdate> {
  return (
    await c.query<ProjectUpdate>(`INSERT INTO project_updates (id, project_id, author_id, health, body, suggested) VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${COLS}`, [
      newId(),
      projectId,
      authorId,
      b.health,
      b.body,
      b.suggested,
    ])
  ).rows[0]!;
}

export async function listUpdates(c: PoolClient, projectId: string, limit = 20): Promise<ProjectUpdate[]> {
  return (await c.query<ProjectUpdate>(`SELECT ${COLS} FROM project_updates WHERE project_id = $1 ORDER BY created_at DESC LIMIT $2`, [projectId, limit])).rows;
}

/** The newest update of each project, one index probe per project. */
export async function latestUpdates(c: PoolClient, projectIds: string[]): Promise<Map<string, ProjectUpdate>> {
  const rows = (
    await c.query<ProjectUpdate>(
      `SELECT u.* FROM unnest($1::text[]) AS pid CROSS JOIN LATERAL (
         SELECT ${COLS} FROM project_updates WHERE project_id = pid ORDER BY created_at DESC LIMIT 1) u`,
      [projectIds],
    )
  ).rows;
  return new Map(rows.map((r) => [r.projectId, r]));
}
