import Link from "next/link";
import { getT } from "@/lib/i18n/server";
import { gw } from "@/lib/gateway";
import { adminLoad, sectionGate } from "@/components/admin/guard";
import { AdminHeader } from "@/components/admin/AdminNav";
import { AttendanceDays, type Day } from "@/components/admin/AttendanceDays";
import { monthLabel, recentMonths } from "@/components/admin/attendance";

export default async function PersonAttendance({ params, searchParams }: { params: Promise<{ userId: string }>; searchParams: Promise<{ month?: string }> }) {
  const gate = await sectionGate("/admin/workspace/attendance");
  if (gate) return gate;
  const tx = await getT();
  const { userId } = await params;
  const { month } = await searchParams;
  const months = recentMonths();
  const m = month && months.includes(month) ? month : months[0]!;
  const last = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const r = await adminLoad(() =>
    Promise.all([
      gw<{ days: Day[] }>(`/api/employee/attendance?userId=${encodeURIComponent(userId)}&from=${m}-01&to=${last}`),
      gw<{ displayName: string; code: string }>(`/api/employee/employees/${encodeURIComponent(userId)}`),
    ]),
  );
  if ("denied" in r) return r.denied;
  const [att, emp] = r.data;
  return (
    <>
      <nav className="text-ink-2 mb-2 text-sm">
        <Link href={`/admin/workspace/attendance?month=${m}`}>{tx("admin.attendanceUseridPage.bang_cham_cong")}</Link> / {emp.displayName}
      </nav>
      <AdminHeader title={emp.displayName} sub={`${emp.code} · ${monthLabel(tx, m)}`} />
      <AttendanceDays userId={userId} month={m} days={att.days} />
    </>
  );
}
