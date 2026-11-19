import { gw } from "@/lib/gateway";
import { getLocale } from "@/lib/i18n/server";
import { adminLoad, sectionGate } from "@/components/admin/guard";
import { LeaveRequestsAdmin, type LeaveRequestRow, type RequestFilter } from "@/components/admin/LeaveRequestsAdmin";
import { leaveTypeLabels, type LeaveType } from "@/components/admin/people-settings";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = ["pending", "approved", "rejected", "cancelled", "all"];

/** Admin › Nghỉ phép › Đơn nghỉ: every leave request, for HR with leave.approve for the whole company. */
export default async function LeaveRequestsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const gate = await sectionGate("/admin/workspace/leave/requests");
  if (gate) return gate;
  const locale = await getLocale();
  const sp = await searchParams;
  const filter: RequestFilter = {
    status: STATUSES.includes(sp.status ?? "") ? sp.status! : "pending",
    userId: sp.userId ?? "",
    departmentId: sp.departmentId ?? "",
    from: DAY.test(sp.from ?? "") ? sp.from! : "",
    to: DAY.test(sp.to ?? "") ? sp.to! : "",
  };
  const q = new URLSearchParams(Object.entries(filter).filter(([, v]) => v) as [string, string][]);
  const r = await adminLoad(() =>
    Promise.all([
      gw<{ requests: LeaveRequestRow[] }>(`/api/employee/leave/requests?${q}`),
      // Types only turn codes into names here; the requests stand without them (showing the code).
      gw<{ types: LeaveType[] }>("/api/employee/leave/types").catch(() => ({ types: [] as LeaveType[] })),
      gw<{ departments: { id: string; name: string }[] }>("/api/employee/departments").catch(() => ({ departments: [] })),
    ]),
  );
  if ("denied" in r) return r.denied;
  const [requests, types, departments] = r.data;
  return <LeaveRequestsAdmin key={q.toString()} rows={requests.requests} types={leaveTypeLabels(types.types, locale)} departments={departments.departments} filter={filter} />;
}
