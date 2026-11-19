import { gw } from "@/lib/gateway";
import { getLocale } from "@/lib/i18n/server";
import { adminLoad, sectionGate } from "@/components/admin/guard";
import { LeaveAdmin, type BalanceRow } from "@/components/admin/LeaveAdmin";
import { leaveTypeLabels, type EmployeeSettings, type LeaveType } from "@/components/admin/people-settings";
import { localDate } from "@/lib/format";
import { getTimeZone } from "@/lib/setup";
import { countryFromZone, isCountry } from "@/lib/country";

export default async function LeavePage({ searchParams }: { searchParams: Promise<{ year?: string; type?: string }> }) {
  const gate = await sectionGate("/admin/workspace/leave");
  if (gate) return gate;
  const locale = await getLocale();
  const sp = await searchParams;
  const year = /^\d{4}$/.test(sp.year ?? "") ? sp.year! : localDate(new Date(), await getTimeZone()).slice(0, 4);
  const r = await adminLoad(() =>
    Promise.all([
      gw<{ year: number; type: string; employees: BalanceRow[] }>(`/api/employee/leave/balances?year=${year}&type=${encodeURIComponent(sp.type ?? "annual")}`),
      gw<{ types: LeaveType[] }>("/api/employee/leave/types"),
      // The policy only feeds the grant defaults and the section below the table; the balances stand without it.
      gw<EmployeeSettings>("/api/employee/settings").catch(() => null),
      gw<{ config: { country?: string | null; timezone?: string; locale?: string } }>("/api/platform/workspace").catch(() => null),
    ]),
  );
  if ("denied" in r) return r.denied;
  const [b, lt, settings, ws] = r.data;
  // The legal minimum shown under the grant form follows the company's country (Settings), else its time zone.
  const country = (isCountry(ws?.config.country) ? ws.config.country : countryFromZone(ws?.config.timezone ?? (await getTimeZone()), ws?.config.locale)) ?? null;
  // The balance tabs show the types that carry a balance; the rest are managed below the table.
  const types = leaveTypeLabels(
    lt.types.filter((t) => t.active && t.requiresBalance),
    locale,
  );
  return <LeaveAdmin key={`${b.year}-${b.type}`} year={b.year} type={b.type} types={types} rows={b.employees} leaveTypes={lt.types} settings={settings} country={country} />;
}
