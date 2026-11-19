import type { T } from "@/lib/i18n/core";
export type BulkRow = { email: string; displayName: string; roleName?: string; department?: string; manager?: string };
export type BulkResult = { email: string; userId?: string; status: "invited" | "added" | "error"; error?: string; emailed?: boolean; activationUrl?: string | null };
export const BULK_ERRORS = (tx: T): Record<string, string> => ({
  invalid_email: tx("labels.bulkError.invalid_email"),
  missing_name: tx("labels.bulkError.missing_name"),
  duplicate_row: tx("labels.bulkError.duplicate_row"),
  unknown_role: tx("labels.bulkError.unknown_role"),
  unknown_department: tx("labels.bulkError.unknown_department"),
  unknown_manager: tx("labels.bulkError.unknown_manager"),
  already_member: tx("labels.bulkError.already_member"),
  role_not_allowed: tx("labels.bulkError.role_not_allowed"),
  failed: tx("labels.bulkError.failed"),
});

/**
 * "email, Name, Role, Department, Manager email" per line (comma, semicolon or tab; only the first two are required);
 * a header line starting with "email" is skipped.
 */
export function parseBulk(text: string): BulkRow[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split(/[,;\t]/).map((c) => c.trim().replace(/^"(.*)"$/, "$1")))
    .filter((c, i) => !(i === 0 && /^e-?mail$/i.test(c[0] ?? "")))
    .map(([email = "", displayName = "", roleName = "", department = "", manager = ""]) => ({
      email,
      displayName,
      ...(roleName ? { roleName } : {}),
      ...(department ? { department } : {}),
      ...(manager ? { manager } : {}),
    }));
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** What the rows can be checked against before anything is sent: role names, departments, people (manager by email or name). */
export interface BulkContext {
  roles: string[];
  departments: { id: string; name: string }[];
  people: { userId: string; email: string; displayName: string }[];
}
export interface CheckedRow extends BulkRow {
  errors: string[];
  departmentId: string | null;
  managerId: string | null;
}

/**
 * The preview's per-row problems (the same codes the server answers, plus department and manager), so the admin fixes
 * the file before inviting. Matching ignores case; a manager is an existing member or someone earlier in the same file.
 */
export function checkBulk(rows: BulkRow[], ctx: BulkContext): CheckedRow[] {
  const seen = new Set<string>();
  const low = (s: string) => s.trim().toLowerCase();
  const inFile = new Set(rows.map((r) => low(r.email)));
  return rows.map((r) => {
    const errors: string[] = [];
    const email = low(r.email);
    if (!EMAIL.test(email)) errors.push("invalid_email");
    if (!r.displayName.trim()) errors.push("missing_name");
    if (email && seen.has(email)) errors.push("duplicate_row");
    seen.add(email);
    if (ctx.people.some((p) => low(p.email) === email)) errors.push("already_member");
    if (r.roleName && !ctx.roles.some((x) => low(x) === low(r.roleName!))) errors.push("unknown_role");
    const dept = r.department ? ctx.departments.find((d) => low(d.name) === low(r.department!)) : undefined;
    if (r.department && !dept) errors.push("unknown_department");
    const mgr = r.manager ? ctx.people.find((p) => low(p.email) === low(r.manager!) || low(p.displayName) === low(r.manager!)) : undefined;
    if (r.manager && !mgr && !inFile.has(low(r.manager))) errors.push("unknown_manager");
    return { ...r, errors, departmentId: dept?.id ?? null, managerId: mgr?.userId ?? null };
  });
}
