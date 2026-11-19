/** Workspace people settings and leave types as the employee API returns them (`employee/settings`, `employee/leave/types`). */
export interface EmployeeSettings {
  workWeek: number[];
  shift: { start: string; end: string | null; lateAfterMin: number } | null;
  leavePolicy: { autoGrant: boolean; typeCode: string; defaultDays: number; prorate: boolean; seniority: boolean; carryOverMax: number; lastGrantedYear: number | null };
}
export interface LeaveType {
  code: string;
  nameVi: string;
  nameEn: string;
  paid: boolean;
  requiresBalance: boolean;
  color: string;
  active: boolean;
  sort: number;
}
export const leaveTypeName = (t: Pick<LeaveType, "nameVi" | "nameEn" | "code">, locale: string) => (locale === "vi" ? t.nameVi || t.nameEn : t.nameEn || t.nameVi) || t.code;
/** code → name in the given language, for pickers and labels. */
export const leaveTypeLabels = (types: LeaveType[], locale: string): Record<string, string> => Object.fromEntries(types.map((t) => [t.code, leaveTypeName(t, locale)]));
