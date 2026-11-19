import type { PoolClient } from "pg";

/** ISO weekdays (1 = Monday … 7 = Sunday) that count as working days. */
export const DEFAULT_WORK_WEEK: readonly number[] = [1, 2, 3, 4, 5];

export interface EmployeeSettings {
  workWeek: number[];
  /** "HH:MM" in the workspace time zone, or null when the company does not track shifts. */
  shift: { start: string; end: string | null; lateAfterMin: number } | null;
  leavePolicy: { autoGrant: boolean; typeCode: string; defaultDays: number; prorate: boolean; seniority: boolean; carryOverMax: number; lastGrantedYear: number | null };
}

interface Row {
  work_week: number[];
  shift_start: string | null;
  shift_end: string | null;
  late_after_min: number;
  leave_auto_grant: boolean;
  leave_type_code: string;
  leave_default_days: string;
  leave_prorate: boolean;
  leave_seniority: boolean;
  leave_carry_over_max: string;
  leave_last_granted_year: number | null;
}

const hm = (t: string | null) => (t ? t.slice(0, 5) : null);

/** The workspace's people settings, defaults when the admin never saved any (no row). */
export async function employeeSettings(c: Pick<PoolClient, "query">): Promise<EmployeeSettings> {
  const r = (await c.query<Row>("SELECT * FROM employee_settings LIMIT 1")).rows[0];
  if (!r) {
    return {
      workWeek: [...DEFAULT_WORK_WEEK],
      shift: null,
      leavePolicy: { autoGrant: false, typeCode: "annual", defaultDays: 12, prorate: true, seniority: false, carryOverMax: 0, lastGrantedYear: null },
    };
  }
  const start = hm(r.shift_start);
  return {
    workWeek: r.work_week.map(Number),
    shift: start ? { start, end: hm(r.shift_end), lateAfterMin: r.late_after_min } : null,
    leavePolicy: {
      autoGrant: r.leave_auto_grant,
      typeCode: r.leave_type_code,
      defaultDays: Number(r.leave_default_days),
      prorate: r.leave_prorate,
      seniority: r.leave_seniority,
      carryOverMax: Number(r.leave_carry_over_max),
      lastGrantedYear: r.leave_last_granted_year,
    },
  };
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

const BUILT_IN: [string, string, string, boolean, boolean, number][] = [
  ["annual", "Nghỉ phép năm", "Annual leave", true, true, 10],
  ["sick", "Nghỉ ốm", "Sick leave", true, false, 20],
  ["unpaid", "Nghỉ không lương", "Unpaid leave", false, false, 30],
];

/** Seeds the three built-in leave types the first time anyone asks. */
async function ensureLeaveTypes(c: PoolClient): Promise<void> {
  if ((await c.query("SELECT 1 FROM leave_types LIMIT 1")).rowCount) return;
  for (const [code, vi, en, paid, bal, sort] of BUILT_IN) {
    await c.query("INSERT INTO leave_types (code, name_vi, name_en, paid, requires_balance, sort) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING", [
      code,
      vi,
      en,
      paid,
      bal,
      sort,
    ]);
  }
}

export async function leaveTypes(c: PoolClient, opts: { activeOnly?: boolean } = {}): Promise<LeaveType[]> {
  await ensureLeaveTypes(c);
  return (
    await c.query<LeaveType>(
      `SELECT code, name_vi AS "nameVi", name_en AS "nameEn", paid, requires_balance AS "requiresBalance", color, active, sort
         FROM leave_types ${opts.activeOnly ? "WHERE active" : ""} ORDER BY sort, code`,
    )
  ).rows;
}
