"use client";

import { CalmEmpty } from "./AdminBits";
import { IconTile } from "@/components/ui/Bento";
import { CalendarIcon } from "@/components/app/icons";
import { useLocale, useT } from "@/lib/i18n/client";
import { INTL_TAG } from "@/lib/i18n/config";
import { COUNTRIES, hasFullYear, holidaysFor, isCountry, regionName } from "@/lib/country";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/client";
import { btn, btnPrimary, btnSm, control, cx, table } from "@/lib/ui";
import { Checkbox } from "@/components/ui/Checkbox";
import { AdminHeader } from "./AdminNav";
import { PickerField } from "./PickerField";
import { LoadFailed } from "@/components/ui/LoadFailed";
import type { EmployeeSettings } from "./people-settings";

interface Holiday {
  day: string;
  name: string;
}
const WEEKDAY = ["d7", "d1", "d2", "d3", "d4", "d5", "d6"] as const;

/** All-day VEVENTs of a year from an iCalendar file: DTSTART;VALUE=DATE:YYYYMMDD + SUMMARY. */
function holidaysFromIcs(text: string, year: string): Holiday[] {
  const out: Holiday[] = [];
  for (const block of text
    .replace(/\r\n[ \t]/g, "")
    .split("BEGIN:VEVENT")
    .slice(1)) {
    const date = /DTSTART;VALUE=DATE:(\d{4})(\d{2})(\d{2})/.exec(block);
    const summary = /\nSUMMARY[^:\n]*:(.*)/.exec(block);
    if (!date || date[1] !== year) continue;
    const name = (summary?.[1] ?? "").replace(/\\,/g, ",").trim().slice(0, 100);
    if (name) out.push({ day: `${date[1]}-${date[2]}-${date[3]}`, name });
  }
  return out;
}

/** Company holidays (not counted as leave or working days) and the work week they sit on. */
export function HolidaysAdmin({
  year,
  holidays,
  settings,
  defaultCountry,
}: {
  year: string;
  holidays: Holiday[];
  /** Null when the work week did not load: that section offers a retry, the holidays stay editable. */
  settings: EmployeeSettings | null;
  /** From the workspace's time zone and language (holiday-country.ts); "" when they do not tell. */
  defaultCountry: string;
}) {
  const tx = useT();
  const router = useRouter();
  const [day, setDay] = useState(`${year}-`);
  const [name, setName] = useState("");
  const [country, setCountry] = useState(defaultCountry);
  const [week, setWeek] = useState<number[]>(settings?.workWeek ?? []);
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "err" } | null>(null);
  const have = new Set(holidays.map((h) => h.day));
  const intlTag = INTL_TAG[useLocale()];
  // The national days of this year for the chosen country (lib/country.ts), movable ones included for 2026–2027.
  const preset = isCountry(country) ? holidaysFor(country, Number(year)) : null;
  const missing = preset ? preset.filter((h) => !have.has(h.day)) : [];
  const add = async (d: string, n: string) => api(`employee/holidays/${d}`, { method: "PUT", body: { name: n } });
  const submit = async () => {
    try {
      await add(day, name.trim());
      setName("");
      setDay(`${year}-`);
      setMsg({ tone: "ok", text: tx("admin.holidaysadmin.da_them_ngay_nghi") });
      router.refresh();
    } catch {
      setMsg({ tone: "err", text: tx("admin.holidaysadmin.ngay_chua_hop_le") });
    }
  };
  const addPreset = async () => {
    await api("employee/holidays/bulk", { method: "POST", body: { holidays: missing } });
    setMsg({ tone: "ok", text: tx("admin.holidaysadmin.da_them_ngay_le", { p0: missing.length }) });
    router.refresh();
  };
  const importIcs = async (file: File) => {
    const found = holidaysFromIcs(await file.text(), year);
    if (!found.length) {
      setMsg({ tone: "err", text: tx("admin.people.ics_rong", { p0: year }) });
      return;
    }
    const r = await api<{ added: number; skipped: number }>("employee/holidays/bulk", { method: "POST", body: { holidays: found.slice(0, 200) } });
    setMsg({ tone: "ok", text: tx("admin.people.da_nhap", { p0: r.added, p1: r.skipped }) });
    router.refresh();
  };
  const saveWeek = async () => {
    if (!settings) return;
    try {
      await api("employee/settings", { method: "PUT", body: { workWeek: week, shift: settings.shift, leavePolicy: settings.leavePolicy } });
      setMsg({ tone: "ok", text: tx("admin.people.da_luu_tuan") });
      router.refresh();
    } catch {
      setMsg({ tone: "err", text: tx("admin.leaveadmin.chua_luu_duoc") });
    }
  };
  const remove = async (d: string) => {
    await api(`employee/holidays/${d}`, { method: "DELETE" });
    router.refresh();
  };
  const y = Number(year);
  const isoDay = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay() || 7;
  return (
    <>
      <AdminHeader
        title={tx("admin.holidaysadmin.ngay_nghi_le")}
        sub={tx("admin.holidaysadmin.nam_khong_tinh_vao", { p0: year })}
        actions={
          <span className="flex gap-2">
            <Link className={btn} href={`/admin/workspace/holidays?year=${y - 1}`}>
              ← {y - 1}
            </Link>
            <Link className={btn} href={`/admin/workspace/holidays?year=${y + 1}`}>
              {y + 1} →
            </Link>
          </span>
        }
      />
      {msg ? (
        <p className={cx("mb-4 rounded-lg px-3 py-2 text-sm", msg.tone === "ok" ? "bg-ok-wash text-ok" : "bg-block-wash text-block")} role="status">
          {msg.text}
        </p>
      ) : null}

      <section className="bg-surface shadow-card mb-6 rounded-xl p-5 text-sm max-sm:p-4" aria-labelledby="week-h">
        <h2 id="week-h" className="mb-3 flex min-w-0 items-center gap-3 text-sm/6 font-semibold tracking-[-0.01em]">
          <IconTile tone="tangerine">
            <CalendarIcon />
          </IconTile>
          {tx("admin.people.tuan_lam_viec")}
        </h2>
        <p className="text-ink-2 mb-3 text-xs">{tx("admin.people.tuan_lam_viec_mo_ta")}</p>
        {settings ? (
          <div className="flex flex-wrap items-center gap-4">
            {[1, 2, 3, 4, 5, 6, 7].map((d) => (
              <label key={d} className="flex items-center gap-2">
                <Checkbox checked={week.includes(d)} onChange={(e) => setWeek(e.target.checked ? [...week, d].sort() : week.filter((x) => x !== d))} />
                {tx(`admin.people.d${d as 1}`)}
              </label>
            ))}
            <button type="button" className={cx(btn, btnSm)} disabled={!week.length || week.join() === settings.workWeek.join()} onClick={() => void saveWeek()}>
              {tx("admin.leaveadmin.luu")}
            </button>
          </div>
        ) : (
          <LoadFailed />
        )}
      </section>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input
          type="date"
          className={cx(control, "h-9 min-h-0 w-44")}
          aria-label={tx("admin.holidaysadmin.ngay")}
          value={day.length === 10 ? day : ""}
          min={`${year}-01-01`}
          max={`${year}-12-31`}
          onChange={(e) => setDay(e.target.value)}
        />
        <input
          className={cx(control, "h-9 min-h-0 w-64")}
          aria-label={tx("admin.holidaysadmin.ten_ngay_nghi")}
          placeholder={tx("admin.holidaysadmin.tet_nguyen_dan_nghi")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={100}
        />
        <button type="button" className={btnPrimary} disabled={day.length !== 10 || !name.trim()} onClick={() => void submit()}>
          {tx("admin.holidaysadmin.them")}
        </button>
      </div>
      <div className="mb-4 flex flex-wrap items-end gap-2">
        <div className="w-48">
          <PickerField
            label={tx("admin.people.quoc_gia")}
            value={country}
            onChange={setCountry}
            options={COUNTRIES.map((c) => ({ value: c, label: regionName(c, intlTag) })).sort((a, b) => a.label.localeCompare(b.label, intlTag))}
            placeholder="—"
          />
        </div>
        {missing.length ? (
          <button type="button" className={btn} onClick={() => void addPreset()}>
            {tx("admin.people.them_mau", { p0: missing.length })}
          </button>
        ) : preset ? (
          <span className="text-ink-2 pb-2 text-sm">{tx("admin.people.du_mau", { p0: regionName(country, intlTag) })}</span>
        ) : (
          <span className="text-ink-2 pb-2 text-sm">{tx("admin.people.chon_quoc_gia")}</span>
        )}
        <label className={cx(btn, "cursor-pointer")}>
          {tx("admin.people.nhap_ics")}
          <input type="file" accept=".ics,text/calendar" className="sr-only" onChange={(e) => e.target.files?.[0] && void importIcs(e.target.files[0])} />
        </label>
      </div>
      <p className="text-ink-2 mb-4 text-sm">
        {isCountry(country) && hasFullYear(country, Number(year))
          ? tx("admin.holidaysadmin.fullYearNote", { p0: regionName(country, intlTag), p1: year })
          : tx("admin.people.nhap_ics_hint", { p0: year })}
      </p>
      {holidays.length === 0 ? (
        <CalmEmpty title={tx("admin.holidaysadmin.chua_co_ngay_nghi", { p0: year })} />
      ) : (
        <table className={table}>
          <thead>
            <tr>
              <th>{tx("admin.holidaysadmin.ngay")}</th>
              <th>{tx("admin.holidaysadmin.ten")}</th>
              <th className="w-24">
                <span className="sr-only">{tx("admin.holidaysadmin.thao_tac")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {holidays.map((h) => (
              <tr key={h.day}>
                <td className="tabular-nums">
                  {tx(`admin.people.${WEEKDAY[new Date(`${h.day}T00:00:00Z`).getUTCDay()]!}`)}, {h.day.slice(8, 10)}/{h.day.slice(5, 7)}/{h.day.slice(0, 4)}
                </td>
                <td>
                  {h.name}
                  {!week.includes(isoDay(h.day)) ? <span className="text-warn ml-2 text-xs">{tx("admin.holidaysadmin.roi_vao_cuoi_tuan")}</span> : null}
                </td>
                <td>
                  <button type="button" className={cx(btn, btnSm)} onClick={() => void remove(h.day)} aria-label={tx("admin.holidaysadmin.xoa", { p0: h.name })}>
                    {tx("admin.holidaysadmin.xoa_2")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
