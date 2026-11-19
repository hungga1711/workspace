import { INTL_TAG } from "@/lib/i18n/config";
import { getLocale } from "@/lib/i18n/server";
import Link from "next/link";
import { getT } from "@/lib/i18n/server";
import { gw, GatewayError } from "@/lib/gateway";
import { adminLoad, sectionGate } from "@/components/admin/guard";
import { AdminHeader } from "@/components/admin/AdminNav";
import { btn, cx, table, tableScroll } from "@/lib/ui";
import { ChevronLeftIcon, ChevronRightIcon } from "@/components/app/icons";
import { monthLabel, recentMonths, type AttendanceReport } from "@/components/admin/attendance";
import { AttendanceSettings } from "@/components/admin/AttendanceSettings";
import { AttendanceCorrections, type Correction } from "@/components/admin/AttendanceCorrections";
import type { EmployeeSettings } from "@/components/admin/people-settings";
import { LoadFailed } from "@/components/ui/LoadFailed";

/** HR monthly attendance: worked days and hours per person, open check-outs, approved leave; CSV for payroll. */
export default async function AttendancePage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const gate = await sectionGate("/admin/workspace/attendance");
  if (gate) return gate;
  const intlTag = INTL_TAG[await getLocale()];
  const tx = await getT();
  const { month } = await searchParams;
  const months = recentMonths();
  const m = month && months.includes(month) ? month : months[0]!;
  const r = await adminLoad(() =>
    Promise.all([
      gw<AttendanceReport>(`/api/employee/attendance/report?month=${m}`),
      // The shift settings and the correction queue are sections of their own: a failed read shows a retry there and
      // the month's report still renders. A 403 on corrections only means this admin approves none.
      gw<EmployeeSettings>("/api/employee/settings").catch(() => null),
      gw<{ corrections: Correction[] }>("/api/employee/attendance/corrections?role=approver").catch((e: unknown) =>
        e instanceof GatewayError && e.status === 403 ? { corrections: [] as Correction[] } : null,
      ),
    ]),
  );
  if ("denied" in r) return r.denied;
  const [rep, settings, corr] = r.data;
  const open = rep.employees.reduce((n, e) => n + e.open, 0);
  const at = months.indexOf(rep.month);
  const older = months[at + 1];
  const newer = at > 0 ? months[at - 1] : undefined;
  const step = "text-ink-2 hover:text-ink grid h-8 w-8 place-items-center no-underline";
  return (
    <>
      <AdminHeader
        title={tx("admin.attendancePage.bang_cham_cong")}
        sub={tx("admin.attendancePage.ngay_lam_viec_t2t6", { p0: monthLabel(tx, rep.month), p1: rep.workingDays })}
        actions={
          <>
            {/* Month switch like Phép năm's year switch: the last twelve months, newest on the right. */}
            <nav aria-label={tx("admin.attendancePage.thang")} className="border-hairline bg-surface flex items-center rounded-md border">
              {older ? (
                <Link className={step} href={`?month=${older}`} aria-label={monthLabel(tx, older)}>
                  <ChevronLeftIcon className="size-4" />
                </Link>
              ) : (
                <span className={cx(step, "opacity-40")} aria-hidden="true">
                  <ChevronLeftIcon className="size-4" />
                </span>
              )}
              <span className="px-1 text-sm font-medium tabular-nums">{monthLabel(tx, rep.month)}</span>
              {newer ? (
                <Link className={step} href={`?month=${newer}`} aria-label={monthLabel(tx, newer)}>
                  <ChevronRightIcon className="size-4" />
                </Link>
              ) : (
                <span className={cx(step, "opacity-40")} aria-hidden="true">
                  <ChevronRightIcon className="size-4" />
                </span>
              )}
            </nav>
            <a className={btn} href={`/admin/workspace/attendance/export?month=${rep.month}`} download>
              {tx("admin.attendancePage.xuat_csv")}
            </a>
          </>
        }
      />
      {open ? <p className="text-warn -mt-2 mb-4 text-sm">{tx("admin.attendancePage.ngay_quen_cham_cong", { p0: open })}</p> : null}
      {settings ? <AttendanceSettings settings={settings} /> : <LoadFailed what={tx("admin.people.ca_lam")} className="mb-6" />}
      {corr ? <AttendanceCorrections corrections={corr.corrections} /> : <LoadFailed what={tx("admin.people.yeu_cau_sua")} className="mb-6" />}
      {rep.employees.length === 0 ? (
        <p className="text-ink-2">{tx("admin.attendancePage.chua_co_nhan_vien")}</p>
      ) : (
        <div className="bg-surface shadow-card overflow-x-auto rounded-xl">
          {/* Below 1024px the department goes under the name and the number headings wrap, so every column fits a tablet. */}
          <table className={cx(table, tableScroll, "max-lg:[&_th]:!whitespace-normal")}>
            <thead>
              <tr>
                <th>{tx("admin.attendancePage.nhan_vien")}</th>
                <th className="max-lg:hidden">{tx("admin.attendancePage.phong_ban")}</th>
                <th className="text-right!">{tx("admin.attendancePage.ngay_cong")}</th>
                <th className="text-right!">{tx("admin.attendancePage.gio_lam")}</th>
                <th className="text-right!">{tx("admin.attendancePage.quen_cham_ra")}</th>
                {rep.shift ? <th className="text-right!">{tx("admin.people.di_muon_ngay")}</th> : null}
                <th className="text-right!">{tx("admin.attendancePage.nghi_phep_ngay")}</th>
              </tr>
            </thead>
            <tbody>
              {rep.employees.map((e) => (
                <tr key={e.userId}>
                  <td>
                    <Link href={`/admin/workspace/attendance/${e.userId}?month=${rep.month}`} className="text-ink block font-medium no-underline hover:underline">
                      {e.displayName}
                    </Link>
                    <span className="text-ink-2 font-mono text-xs">{e.code}</span>
                    {e.department ? <span className="text-ink-2 block text-xs lg:hidden">{e.department}</span> : null}
                  </td>
                  <td className="max-lg:hidden">{e.department ?? <span className="text-ink-2">—</span>}</td>
                  <td className="text-right tabular-nums">{e.days}</td>
                  <td className="text-right tabular-nums">{e.hours.toLocaleString(intlTag, { maximumFractionDigits: 1 })}</td>
                  <td className={cx("text-right tabular-nums", e.open ? "text-warn" : "text-ink-2")}>{e.open}</td>
                  {rep.shift ? <td className={cx("text-right tabular-nums", e.lateDays ? "text-warn" : "text-ink-2")}>{e.lateDays}</td> : null}
                  <td className="text-right tabular-nums">{e.leaveDays}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
