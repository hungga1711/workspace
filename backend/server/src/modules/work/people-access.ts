/**
 * Who may open a person's or a department's page in Work. Before, only people in the caller's Follow-up
 * scope were found, so a manager without that scope, and anyone opening their own page, got a 404.
 *
 *  - yourself, always (the same numbers your manager sees, as in Follow-up › Me);
 *  - people in your reporting line, or everyone when you follow the whole company: the full page;
 *  - colleagues in your own department: work numbers only (no task list, notes or blockers);
 *  - anyone else: no access (403, never a 404 that reads as "this person does not exist").
 *
 * AI prompt content is never part of these pages' work data; the AI section has its own audience rule (ai module).
 */
export type PersonAccess = "self" | "manager" | "everyone" | "colleague";

export function personAccess(x: {
  callerId: string;
  targetId: string;
  /** The caller follows the whole company (seesEveryone). */
  everyone: boolean;
  /** The caller's reporting line (direct and indirect reports, people of departments they head). */
  teamIds: ReadonlySet<string>;
  callerDepartmentId: string | null;
  targetDepartmentId: string | null;
}): PersonAccess | null {
  if (x.callerId === x.targetId) return "self";
  if (x.everyone) return "everyone";
  if (x.teamIds.has(x.targetId)) return "manager";
  if (x.callerDepartmentId && x.callerDepartmentId === x.targetDepartmentId) return "colleague";
  return null;
}

export type DepartmentAccess = "everyone" | "manager" | "colleague";

/**
 * A department's page: the company's followers and the department's head see everyone in it in full; a manager
 * whose reports work there sees it too (their own people in full, the rest as numbers); its members see the numbers.
 */
export function departmentAccess(x: {
  callerId: string;
  everyone: boolean;
  headId: string | null;
  teamIds: ReadonlySet<string>;
  memberIds: readonly string[];
  callerDepartmentId: string | null;
  departmentId: string;
}): DepartmentAccess | null {
  if (x.everyone) return "everyone";
  if (x.headId && x.headId === x.callerId) return "manager";
  if (x.memberIds.some((id) => x.teamIds.has(id))) return "manager";
  if (x.callerDepartmentId === x.departmentId) return "colleague";
  return null;
}

/** Whether a row on a department page is shown in full (its tasks) or as numbers only. */
export function fullRow(access: DepartmentAccess, x: { callerId: string; headId: string | null; teamIds: ReadonlySet<string>; userId: string }): boolean {
  if (access === "everyone") return true;
  if (x.userId === x.callerId) return true;
  if (access === "manager" && x.headId === x.callerId) return true;
  return x.teamIds.has(x.userId);
}

/** What a colleague sees of someone: the figures, none of the task titles, notes or blockers behind them. */
export function workNumbersOnly<T extends { now: unknown[]; late: unknown[]; doneRecently: unknown[]; tasks: unknown[] }>(row: T): T {
  return { ...row, now: [], late: [], doneRecently: [], tasks: [] };
}
