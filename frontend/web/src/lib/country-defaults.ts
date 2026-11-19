import "server-only";
import { gw } from "@/lib/gateway";
import { COUNTRY_RULES, holidaysFor, type Country } from "@/lib/country";
import type { EmployeeSettings } from "@/components/admin/people-settings";

/**
 * A new workspace's people settings for its country: the work week, the default annual leave, and the national
 * holidays of this year and next. Existing holidays are kept (the bulk insert skips days already set).
 */
export async function applyCountryDefaults(country: Country) {
  const rules = COUNTRY_RULES[country];
  const s = await gw<EmployeeSettings>("/api/employee/settings");
  await gw("/api/employee/settings", {
    method: "PUT",
    body: { workWeek: rules.workWeek, shift: s.shift, leavePolicy: { ...s.leavePolicy, defaultDays: rules.leaveDays, seniority: country === "VN" } },
  });
  const year = new Date().getUTCFullYear();
  await gw("/api/employee/holidays/bulk", { method: "POST", body: { holidays: [...holidaysFor(country, year), ...holidaysFor(country, year + 1)] } });
}
