"use client";

import { IconTile } from "@/components/ui/Bento";
import { PlaneIcon } from "@/components/app/icons";
import { useLocale, useT } from "@/lib/i18n/client";
import { INTL_TAG } from "@/lib/i18n/config";
import { COUNTRY_RULES, regionName, type Country } from "@/lib/country";
import { Checkbox } from "@/components/ui/Checkbox";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/client";
import { btn, btnPrimary, btnSm, control, cx, table, tableScroll } from "@/lib/ui";
import { Segmented } from "@/components/ui/Segmented";
import { AdminHeader } from "./AdminNav";
import { LeaveTypesPolicy } from "./LeaveTypesPolicy";
import { LoadFailed } from "@/components/ui/LoadFailed";
import type { EmployeeSettings, LeaveType } from "./people-settings";

export interface BalanceRow {
  userId: string;
  code: string;
  displayName: string;
  hireDate: string | null;
  entitled: number | null;
  used: number;
  pending: number;
}

/** Leave entitlements for everyone (leave): overview, one-person edit, and the start-of-year bulk grant. */
export function LeaveAdmin({
  year,
  type,
  types,
  rows,
  leaveTypes,
  settings,
  country = null,
}: {
  year: number;
  type: string;
  types: Record<string, string>;
  rows: BalanceRow[];
  leaveTypes: LeaveType[];
  /** Null when the leave policy did not load: the grant form starts unticked and the policy section offers a retry. */
  settings: EmployeeSettings | null;
  /** Where the company works: the legal minimum under the form follows it (lib/country.ts). */
  country?: Country | null;
}) {
  const tx = useT();
  const router = useRouter();
  const intlTag = INTL_TAG[useLocale()];
  // The company's own default (Admin › Leave › policy), else the country's minimum: never a fixed 12.
  const [days, setDays] = useState(String(settings?.leavePolicy.defaultDays ?? (country ? COUNTRY_RULES[country].leaveDays : 12)));
  const law = country ? COUNTRY_RULES[country] : null;
  const [seniority, setSeniority] = useState(settings?.leavePolicy.seniority ?? false);
  const [prorate, setProrate] = useState(settings?.leavePolicy.prorate ?? false);
  const [carry, setCarry] = useState("0");
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "err" } | null>(null);
  const [edit, setEdit] = useState<{ userId: string; value: string } | null>(null);
  const missing = rows.filter((r) => r.entitled === null).length;
  const grant = async () => {
    setMsg(null);
    try {
      const r = await api<{ updated: number }>("employee/leave/balances/bulk", {
        method: "POST",
        body: { type, year, entitledDays: Number(days), seniority, carryOverMax: Number(carry), onlyMissing: true, prorate },
      });
      setMsg({ tone: "ok", text: tx("admin.leaveadmin.da_cap_nam_cho", { p0: types[type] ?? type, p1: year, p2: r.updated }) });
      router.refresh();
    } catch {
      setMsg({ tone: "err", text: tx("admin.leaveadmin.chua_cap_duoc_kiem") });
    }
  };
  const saveOne = async () => {
    if (!edit) return;
    try {
      await api(`employee/leave/balances/${edit.userId}`, { method: "PUT", body: { type, year, entitledDays: Number(edit.value) } });
      setEdit(null);
      router.refresh();
    } catch (e) {
      setMsg({
        tone: "err",
        text: (e as { body?: { error?: string } }).body?.error === "below_used" ? tx("admin.leaveadmin.khong_the_thap_hon") : tx("admin.leaveadmin.chua_luu_duoc"),
      });
    }
  };
  const link = (y: number, t: string) => `/admin/workspace/leave?year=${y}&type=${t}`;
  return (
    <>
      <AdminHeader
        title={tx("admin.leaveadmin.phep_nam")}
        actions={
          <span className="border-hairline bg-surface flex items-center rounded-md border">
            <Link className="text-ink-2 hover:text-ink px-2.5 py-1.5 text-sm no-underline" href={link(year - 1, type)} aria-label={String(year - 1)}>
              ‹
            </Link>
            <span className="px-1 text-sm font-medium tabular-nums">{year}</span>
            <Link className="text-ink-2 hover:text-ink px-2.5 py-1.5 text-sm no-underline" href={link(year + 1, type)} aria-label={String(year + 1)}>
              ›
            </Link>
          </span>
        }
      />
      <Segmented
        className="mb-4"
        label={tx("admin.leaveadmin.loai_phep")}
        value={type}
        options={Object.entries(types).map(([k, l]) => ({ value: k, label: l, href: link(year, k) }))}
      />
      {msg ? (
        <p className={cx("mb-4 rounded-lg px-3 py-2 text-sm", msg.tone === "ok" ? "bg-ok-wash text-ok" : "bg-block-wash text-block")} role="status">
          {msg.text}
        </p>
      ) : null}
      <section className="bg-surface shadow-card mb-6 rounded-xl p-5 text-sm max-sm:p-4" aria-labelledby="grant-h">
        <h2 id="grant-h" className="mb-3 flex min-w-0 items-center gap-3 text-sm/6 font-semibold tracking-[-0.01em]">
          <IconTile tone="tangerine">
            <PlaneIcon />
          </IconTile>
          {tx("admin.leaveadmin.cap_cho_nguoi_chua_co", { p0: year, p1: missing })}
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2">
            {tx("admin.leaveadmin.so_ngay")}{" "}
            <input
              className={cx(control, "h-9 min-h-0 w-20")}
              inputMode="decimal"
              value={days}
              onChange={(e) => setDays(e.target.value)}
              aria-label={tx("admin.leaveadmin.so_ngay_cap")}
            />
          </label>
          <label className="flex items-center gap-2">
            <Checkbox checked={seniority} onChange={(e) => setSeniority(e.target.checked)} />
            {tx("admin.leaveadmin.n1_ngay_cho_moi")}
          </label>
          <label className="flex items-center gap-2">
            <Checkbox checked={prorate} onChange={(e) => setProrate(e.target.checked)} />
            {tx("admin.people.prorate_bulk")}
          </label>
          <label className="flex items-center gap-2">
            {tx("admin.leaveadmin.chuyen_phep_du_nam")}{" "}
            <input
              className={cx(control, "h-9 min-h-0 w-16")}
              inputMode="decimal"
              value={carry}
              onChange={(e) => setCarry(e.target.value)}
              aria-label={tx("admin.leaveadmin.so_ngay_chuyen_toi")}
            />{" "}
            {tx("admin.leaveadmin.ngay")}
          </label>
          <button type="button" className={btnPrimary} disabled={!missing || !(Number(days) >= 0)} onClick={() => void grant()}>
            {tx("admin.leaveadmin.cap_phep")}
          </button>
        </div>
        <p className="text-ink-2 mt-2 text-xs">
          {country && law
            ? tx(law.leaveStatutory ? "admin.leaveadmin.lawMinimum" : "admin.leaveadmin.noLawMinimum", { country: regionName(country, intlTag), days: law.leaveDays })
            : tx("admin.leaveadmin.lawUnknown")}{" "}
          {country === "VN" ? tx("admin.leaveadmin.seniorityVn") : country === "GB" ? tx("admin.leaveadmin.bankHolidaysGb") : null}
        </p>
      </section>
      <div className="bg-surface shadow-card overflow-x-auto rounded-xl">
        {/* Below 768px the start date goes under the name and the number headings wrap, so the balance fits a phone. */}
        <table className={cx(table, tableScroll, "max-lg:[&_th]:!whitespace-normal")}>
          <thead>
            <tr>
              <th>{tx("admin.leaveadmin.nhan_vien")}</th>
              <th className="max-md:hidden">{tx("admin.leaveadmin.ngay_vao_lam")}</th>
              <th className="text-right!">{tx("admin.leaveadmin.duoc_cap")}</th>
              <th className="text-right!">{tx("admin.leaveadmin.da_dung")}</th>
              <th className="text-right! max-sm:hidden">{tx("admin.leaveadmin.dang_cho_duyet")}</th>
              <th className="text-right!">{tx("admin.leaveadmin.con_lai")}</th>
              <th className="w-24">
                <span className="sr-only">{tx("admin.leaveadmin.thao_tac")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.userId}>
                <td>
                  <span className="text-ink block font-medium">{r.displayName}</span>
                  <span className="text-ink-2 font-mono text-xs">{r.code}</span>
                  {r.hireDate ? (
                    <span className="text-ink-2 block text-xs tabular-nums md:hidden">{`${r.hireDate.slice(8, 10)}/${r.hireDate.slice(5, 7)}/${r.hireDate.slice(0, 4)}`}</span>
                  ) : null}
                </td>
                <td className="text-ink-2 tabular-nums max-md:hidden">{r.hireDate ? `${r.hireDate.slice(8, 10)}/${r.hireDate.slice(5, 7)}/${r.hireDate.slice(0, 4)}` : "—"}</td>
                <td className="text-right tabular-nums">
                  {edit?.userId === r.userId ? (
                    <input
                      className={cx(control, "h-8 min-h-0 w-16 text-right")}
                      autoFocus
                      inputMode="decimal"
                      aria-label={tx("admin.leaveadmin.so_ngay_cap_cho", { p0: r.displayName })}
                      value={edit.value}
                      onChange={(e) => setEdit({ userId: r.userId, value: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void saveOne();
                        if (e.key === "Escape") setEdit(null);
                      }}
                    />
                  ) : (
                    (r.entitled ?? <span className="text-ink-2">{tx("admin.leaveadmin.chua_cap")}</span>)
                  )}
                </td>
                <td className="text-right tabular-nums">{r.used}</td>
                <td className="text-right tabular-nums max-sm:hidden">{r.pending}</td>
                <td className="text-right font-semibold tabular-nums">{r.entitled === null ? "—" : r.entitled - r.used - r.pending}</td>
                <td>
                  {edit?.userId === r.userId ? (
                    <button type="button" className={cx(btn, btnSm)} onClick={() => void saveOne()}>
                      {tx("admin.leaveadmin.luu")}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className={cx(btn, btnSm, "text-ink-2 hover:text-ink border-transparent bg-transparent shadow-none")}
                      onClick={() => setEdit({ userId: r.userId, value: String(r.entitled ?? days) })}
                      aria-label={tx("admin.leaveadmin.sua_phep_cua", { p0: r.displayName })}
                    >
                      {tx("admin.leaveadmin.sua")}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-6">{settings ? <LeaveTypesPolicy types={leaveTypes} settings={settings} /> : <LoadFailed />}</div>
    </>
  );
}
