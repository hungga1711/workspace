import { requireFeature } from "@/lib/features";
import { leaveTypeLabels, type LeaveType } from "@/components/admin/people-settings";
import { gw } from "@/lib/gateway";
import { readSession } from "@/lib/session";
import { localDate } from "@/lib/format";
import { getTimeZone } from "@/lib/setup";
import { getLocale } from "@/lib/i18n/server";
import { MeView, type MeExtra, type Person } from "./MeView";
import { meGroup, type MeTab } from "./groups";
import { calendarWeeks } from "./attendanceGrid";
import type { TeamTodayData } from "./TeamToday";
import type { LeaveRequest, MeData } from "@/app/app/me/page";

const none =
  <T,>(v: T) =>
  () =>
    v;

/** Hồ sơ của tôi (/app/me) and Chấm công (/app/time): one view, each page loads only its data. */
export async function renderMe(tab: MeTab) {
  const tz = await getTimeZone();
  const group = meGroup(tab);
  // Chấm công (attendance and leave) left out at deploy time: its page and tabs do not exist.
  if (group === "time") await requireFeature("time");
  const [me, ws, toApprove, departments, people, session] = await Promise.all([
    // A failed read (a restart, the rate limit after a burst) shows "couldn't load" in place, never the crash page.
    gw<MeData>("/api/employee/me").catch(() => null),
    gw<{ features: Record<string, boolean>; config?: { desktopDownloadUrl?: string | null } }>("/api/platform/workspace").catch(none({ features: {} as Record<string, boolean> })),
    gw<{ requests: LeaveRequest[] }>("/api/employee/leave?role=approver").catch(none({ requests: [] as LeaveRequest[] })),
    gw<{ departments: { id: string; name: string; headId: string | null; members: number }[] }>("/api/employee/departments").catch(
      none({ departments: [] as { id: string; name: string; headId: string | null; members: number }[] }),
    ),
    gw<{ employees: Person[] }>("/api/employee/employees?all=1").catch(none({ employees: [] as Person[] })),
    readSession(),
  ]);
  const leaveTypes = await gw<{ types: LeaveType[] }>("/api/employee/leave/types").catch(() => ({ types: [] as LeaveType[] }));
  const extra: MeExtra = {
    leaveTypes: leaveTypeLabels(leaveTypes.types, await getLocale()),
    people: people.employees,
    departments: departments.departments,
    isManager: people.employees.some((e) => e.managerId === me?.profile?.userId),
    email: session?.email ?? null,
    givenName: session?.givenName ?? "",
    meFailed: !me,
    desktopDownload: ("config" in ws ? ws.config?.desktopDownloadUrl : null) ?? null,
  };
  let mine: LeaveRequest[] = [];
  if (group === "time" && ws.features.attendance) {
    // A year of days for the history grid (53 weeks, ending with this one).
    const today = localDate(new Date(), tz);
    const [first] = calendarWeeks(today)[0]!;
    extra.today = today;
    const [days, team] = await Promise.all([
      gw<{ days: MeExtra["attendanceDays"] }>(`/api/employee/attendance?from=${first}&to=${today}`).catch(none({ days: [] })),
      // Team today: managers' reporting line, HR's company; "none" for everyone else (nothing shown).
      gw<TeamTodayData>("/api/employee/attendance/team").catch(() => null),
    ]);
    extra.attendanceDays = days.days;
    extra.teamToday = team && team.scope !== "none" ? team : null;
  }
  if (group === "time") {
    const from = new Date();
    const [r, hol] = await Promise.all([
      gw<{ requests: LeaveRequest[] }>("/api/employee/leave").catch(none({ requests: [] as LeaveRequest[] })),
      gw<{ holidays: { day: string; name: string }[] }>(`/api/employee/holidays?year=${localDate(from, tz).slice(0, 4)}`).catch(none({ holidays: [] })),
    ]);
    mine = r.requests;
    extra.holidays = hol.holidays.filter((h) => h.day >= localDate(from, tz)).slice(0, 5);
  }
  if (group === "profile" && ws.features.aiMonitoring) {
    extra.ai = await gw<NonNullable<MeExtra["ai"]>>("/api/ai/oversight/me").catch(
      none({ policy: { detail: "summary" as const, captureResponses: false, retentionDays: 180 }, stats: [], views: [], extension: null }),
    );
  }
  return (
    <MeView
      me={me ?? { profile: null, attendanceToday: null, leaveBalances: [] }}
      myLeave={mine}
      toApprove={toApprove.requests}
      features={ws.features}
      tab={tab}
      extra={extra}
      department={departments.departments.find((d) => d.id === me?.profile?.departmentId)?.name ?? null}
    />
  );
}
