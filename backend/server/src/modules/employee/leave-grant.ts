import { logger } from "@workspace/service-kit";
import { currentRequestId, newId, runWithContext, withTransaction, workspaceTimeZone } from "@workspace/shared";
import type { Pool, PoolClient } from "pg";
import { localDay } from "./days.js";
import { employeeSettings } from "./settings.js";
import { emit } from "./http/common.js";

export interface GrantOptions {
  type: string;
  year: number;
  entitledDays: number;
  /** +1 day per full 5 years of service (Vietnam's Labour Code art. 114; an option elsewhere). */
  seniority: boolean;
  carryOverMax: number;
  onlyMissing: boolean;
  /** People hired during the year get the months left in it (hire month counts when hired by the 15th), to the nearest half day. */
  prorate: boolean;
}

/** Grants a year's leave to every active employee at once; used by the admin button and the start-of-year job. */
export async function grantBalances(c: PoolClient, b: GrantOptions, by: string): Promise<{ updated: number; skipped: number }> {
  const rows = (
    await c.query<{ user_id: string; hire_date: string | null; has: boolean; prev_left: string | null; used: string | null }>(
      `SELECT e.user_id, e.hire_date::text, (b.user_id IS NOT NULL) AS has, b.used_days::text AS used,
              (SELECT greatest(pb.entitled_days - pb.used_days, 0)::text FROM leave_balances pb WHERE pb.user_id = e.user_id AND pb.leave_type = $1 AND pb.year = $2 - 1) AS prev_left
         FROM employees e LEFT JOIN leave_balances b ON b.user_id = e.user_id AND b.leave_type = $1 AND b.year = $2
        WHERE e.active`,
      [b.type, b.year],
    )
  ).rows;
  let updated = 0;
  let skipped = 0;
  for (const r of rows) {
    if (b.onlyMissing && r.has) {
      skipped++;
      continue;
    }
    const years = r.hire_date ? Math.floor((Date.UTC(b.year, 0, 1) - Date.parse(r.hire_date)) / (365.25 * 86400_000)) : 0;
    const bonus = b.seniority && years >= 5 ? Math.floor(years / 5) : 0;
    const carry = Math.min(b.carryOverMax, Number(r.prev_left ?? 0));
    let base = b.entitledDays;
    if (b.prorate && r.hire_date && r.hire_date.slice(0, 4) === String(b.year)) {
      const month = Number(r.hire_date.slice(5, 7));
      const monthsLeft = 12 - month + (Number(r.hire_date.slice(8, 10)) <= 15 ? 1 : 0);
      base = Math.round((b.entitledDays * monthsLeft) / 12 / 0.5) * 0.5;
    }
    // Never below what is already used this year.
    const entitled = Math.max(base + bonus + carry, Number(r.used ?? 0));
    await c.query(
      `INSERT INTO leave_balances (user_id, leave_type, year, entitled_days) VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id, leave_type, year) DO UPDATE SET entitled_days = EXCLUDED.entitled_days`,
      [r.user_id, b.type, b.year, entitled],
    );
    updated++;
  }
  await emit(c, "employee.leave.balances_granted.v1", "employee.leave", `${b.type}:${b.year}`, {
    type: b.type,
    year: b.year,
    entitledDays: b.entitledDays,
    seniority: b.seniority,
    carryOverMax: b.carryOverMax,
    onlyMissing: b.onlyMissing,
    updated,
    skipped,
    by,
  });
  return { updated, skipped };
}

/**
 * The start-of-year grant (runs a few times a day): once the workspace's local calendar reaches 1 January of a year it
 * has not been granted for, every active employee who still has no balance for that year gets the policy's allowance.
 * Idempotent per year (recorded in employee_settings), so a late or repeated run changes nothing. Returns 1 when it
 * granted, else 0.
 */
export async function grantYearlyLeave(pool: Pool, now = new Date()): Promise<number> {
  // Any zone is still in the old year until Kiribati rolls over; ask for the year that has started anywhere.
  const year = Number(localDay("Pacific/Kiritimati", now).slice(0, 4));
  const due = await pool.query("SELECT 1 FROM employee_settings WHERE leave_auto_grant AND coalesce(leave_last_granted_year, 0) < $1", [year]);
  if (!due.rowCount) return 0;
  return runWithContext({ actorId: "service:leave-grant", requestId: currentRequestId() ?? newId() }, () =>
    withTransaction(pool, async (c) => {
      if (Number(localDay(await workspaceTimeZone(c), now).slice(0, 4)) < year) return 0;
      const s = await employeeSettings(c);
      if (!s.leavePolicy.autoGrant || (s.leavePolicy.lastGrantedYear ?? 0) >= year) return 0;
      const r = await grantBalances(
        c,
        {
          type: s.leavePolicy.typeCode,
          year,
          entitledDays: s.leavePolicy.defaultDays,
          seniority: s.leavePolicy.seniority,
          carryOverMax: s.leavePolicy.carryOverMax,
          onlyMissing: true,
          prorate: s.leavePolicy.prorate,
        },
        "service:leave-grant",
      );
      await c.query("UPDATE employee_settings SET leave_last_granted_year = $1, updated_at = now()", [year]);
      logger.info({ year, ...r }, "yearly leave granted");
      return 1;
    }),
  );
}
