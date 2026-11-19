import { gw, GatewayError } from "@/lib/gateway";
import { getT } from "@/lib/i18n/server";
import { csvFile, csvResponse } from "@/lib/csv";
import type { AttendanceReport } from "@/components/admin/attendance";

/** Monthly attendance as CSV for payroll (HR only: the API enforces attendance.read company-wide). */
export async function GET(req: Request) {
  const tx = await getT();
  const month = new URL(req.url).searchParams.get("month") ?? "";
  try {
    const r = await gw<AttendanceReport>(`/api/employee/attendance/report?month=${encodeURIComponent(month)}`);
    const rows = r.employees.map((e) => [e.code, e.displayName, e.department ?? "", e.days, e.hours, e.open, e.lateDays, e.leaveDays, r.workingDays]);
    // Data leaving the app goes on the audit trail (Admin › Nhật ký); a failed record never blocks the download.
    await gw("/api/platform/audit/record", {
      method: "POST",
      body: { action: "employee.attendance.exported", targetType: "settings", targetId: "attendance", targetLabel: r.month, meta: { month: r.month, employees: rows.length } },
    }).catch(() => undefined);
    return csvResponse(
      csvFile(
        [
          tx("admin.attendanceExportRoute.ma_nv"),
          tx("admin.attendanceExportRoute.ho_ten"),
          tx("admin.attendanceExportRoute.phong_ban"),
          tx("admin.attendanceExportRoute.ngay_cong"),
          tx("admin.attendanceExportRoute.gio_lam"),
          tx("admin.attendanceExportRoute.ngay_quen_cham_ra"),
          tx("admin.people.di_muon_ngay"),
          tx("admin.attendanceExportRoute.nghi_phep_ngay"),
          tx("admin.attendanceExportRoute.ngay_lam_viec_trong"),
        ],
        rows,
      ),
      `cham-cong-${r.month}.csv`,
    );
  } catch (e) {
    if (e instanceof GatewayError && e.status === 403) return new Response(tx("admin.attendanceExportRoute.ban_khong_co_quyen"), { status: 403 });
    throw e;
  }
}
