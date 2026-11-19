import type { PoolClient } from "pg";
import { NotFound } from "./errors.js";

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
const TABLE = { task: "tasks", project: "projects", document: "documents", approval: "approvals", meeting: "calendar_events", whiteboard: "whiteboards" } as const;

/**
 * The id of a task, project, document, request (approval), meeting or whiteboard named either way people share it: its ULID, or
 * its code ("T-041", "YC-007", "H-012-3", any case; formats are the workspace's own, so the code column decides, not
 * a pattern). Row-level security keeps the lookup inside the caller's workspace, so another company's T-041 is not
 * found.
 */
export async function resolveRef(c: PoolClient, kind: keyof typeof TABLE, ref: string): Promise<string> {
  if (ULID.test(ref)) return ref.toUpperCase();
  const code = ref.trim();
  if (!code || code.length > 64) throw new NotFound(`${kind} not found`);
  // Three spellings so each one can use the code unique index.
  const r = await c.query<{ id: string }>(`SELECT id FROM ${TABLE[kind]} WHERE code IN ($1, upper($1), lower($1)) LIMIT 1`, [code]);
  if (!r.rows[0]) throw new NotFound(`${kind} not found`);
  return r.rows[0].id;
}
