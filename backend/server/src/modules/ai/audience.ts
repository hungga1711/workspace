import { ForbiddenException } from "@nestjs/common";
import { authorize, type Principal } from "@workspace/shared";
import type { Deps } from "./runtime.js";

export interface Person {
  userId: string;
  displayName: string;
  title?: string | null;
  department?: string | null;
}

/**
 * Who the caller may see in AI Insights: everyone (ai.policy.manage) or their reporting line, with names and
 * departments; the same rule as Công việc › AI (ActivityController.audience), shared by the capability map and
 * the weekly report. Anyone else is refused.
 */
export async function aiAudience(d: Deps, p: Principal): Promise<{ admin: boolean; people: Person[] }> {
  const admin = authorize(p, "ai.policy.manage").allowed;
  const employee = d.services.employee;
  // A manager's directory and reporting line are read together (an admin needs only the directory).
  const [dir, r] = await Promise.all([
    employee.request<{ employees: Person[] }>("GET", "/employees?all=1", undefined, p).catch(() => ({ employees: [] as Person[] })),
    admin ? null : employee.request<{ reports: { userId: string }[] }>("GET", "/me/reports", undefined, p).catch(() => ({ reports: [] })),
  ]);
  if (admin || !r) return { admin, people: dir.employees };
  const mine = new Set(r.reports.map((x) => x.userId));
  if (!mine.size) throw new ForbiddenException("only admins and managers see AI activity");
  return { admin, people: dir.employees.filter((x) => mine.has(x.userId)) };
}

export const isAiAdmin = (p: Principal) => authorize(p, "ai.policy.manage").allowed;
