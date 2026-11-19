import type { PoolClient } from "pg";

export type CodeEntity = "task" | "project" | "document" | "employee" | "request" | "meeting" | "whiteboard";

/**
 * Formats a workspace starts with. Requests and meetings read in the workspace's language at setup: "YC" (yêu cầu)
 * and "H" (họp) in Vietnamese, "R" and "M" in English. Workspaces from before those codes existed keep the
 * Vietnamese ones (the platform's stored config fills the same defaults), so both modules agree.
 */
const DEFAULT_FORMATS: Record<CodeEntity, string> = {
  task: "T-{seq3}",
  project: "P-{seq3}",
  document: "D-{seq3}",
  employee: "EMP-{seq6}",
  request: "YC-{seq3}",
  meeting: "H-{seq3}",
  // Came with whiteboards: stored formats from before have no key and fall back to this in nextCode().
  whiteboard: "W-{seq3}",
};
export const defaultFormats = (locale?: string): Record<CodeEntity, string> =>
  locale === "en" ? { ...DEFAULT_FORMATS, request: "R-{seq3}", meeting: "M-{seq3}" } : DEFAULT_FORMATS;

/**
 * Human-readable codes. Internal id stays the ULID primary key.
 *   {id10}  first 10 chars of the ULID (unique enough, no counter)
 *   {yyyy}  current year; resets the counter per year
 *   {seqN}  per-workspace counter, zero-padded to N, incremented inside the caller's
 *           transaction (UPDATE ... RETURNING row lock), so codes never collide
 *           and a rolled-back insert does not burn a number.
 */
export async function nextCode(c: PoolClient, entity: CodeEntity, id: string, now = new Date()): Promise<string> {
  const s = await c.query<{ code_formats: Record<string, string> }>("SELECT code_formats FROM workspace_settings");
  const format = s.rows[0]?.code_formats?.[entity] ?? DEFAULT_FORMATS[entity];
  const year = String(now.getUTCFullYear());
  let out = format.replace("{id10}", id.slice(0, 10)).replace("{yyyy}", year);
  const seqMatch = out.match(/\{seq([3-9])\}/);
  if (seqMatch) {
    const period = format.includes("{yyyy}") ? year : "";
    const r = await c.query<{ value: string }>(
      `INSERT INTO code_counters (entity, period, value) VALUES ($1,$2,1)
       ON CONFLICT (entity, period) DO UPDATE SET value = code_counters.value + 1 RETURNING value`,
      [entity, period],
    );
    out = out.replace(seqMatch[0], r.rows[0]!.value.padStart(Number(seqMatch[1]), "0"));
  }
  return out;
}
