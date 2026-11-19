import { gw } from "@/lib/gateway";
import { adminLoad, sectionGate } from "@/components/admin/guard";
import { HolidaysAdmin } from "@/components/admin/HolidaysAdmin";
import type { EmployeeSettings } from "@/components/admin/people-settings";
import { localDate } from "@/lib/format";
import { getTimeZone, getWorkspaceLocale } from "@/lib/setup";
import { defaultHolidayCountry } from "@/components/admin/holiday-country";

export default async function HolidaysPage({ searchParams }: { searchParams: Promise<{ year?: string }> }) {
  const gate = await sectionGate("/admin/workspace/holidays");
  if (gate) return gate;
  const { year } = await searchParams;
  const y = year && /^\d{4}$/.test(year) ? year : localDate(new Date(), await getTimeZone()).slice(0, 4);
  const r = await adminLoad(() =>
    Promise.all([
      gw<{ year: string; holidays: { day: string; name: string }[] }>(`/api/employee/holidays?year=${y}`),
      gw<EmployeeSettings>("/api/employee/settings").catch(() => null),
      gw<{ config: { country?: string | null } }>("/api/platform/workspace").catch(() => null),
    ]),
  );
  if ("denied" in r) return r.denied;
  const [h, settings, ws] = r.data;
  // The country set in Settings first (one source for Settings, Holidays and Leave), else the time zone's guess.
  const country = defaultHolidayCountry(await getTimeZone(), await getWorkspaceLocale(), ws?.config.country) ?? "";
  return <HolidaysAdmin key={y} year={h.year} holidays={h.holidays} settings={settings} defaultCountry={country} />;
}
