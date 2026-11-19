"use client";

import { PersonChip, PersonTrigger } from "@/components/chat/PersonTrigger";
import { ManagerSees } from "./ManagerSees";
import type { T } from "@/lib/i18n/core";
import { useT, useFormat } from "@/lib/i18n/client";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/client";
import { localDate } from "@/lib/format";
import { Avatar, AvatarStack, useDirectory } from "@/lib/people";
import { btn, btnPrimary, btnSm, cx, list, textarea } from "@/lib/ui";
import { IconTile, card } from "@/components/ui/Bento";
import { SpotArea } from "@/components/ui/SpotArea";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { AllClear, Intro } from "@/components/ai-hub/Intro";
import { Picker } from "@/components/ui/Picker";
import { DateField } from "@/components/ui/DateField";
import { Checkbox } from "@/components/ui/Checkbox";
import { Modal } from "@/components/ui/Modal";
import { PageHeader } from "@/components/ui/PageHeader";
import { Field, StatusPill } from "@/components/ui/bits";
import { ReasonDialog } from "@/components/ui/ReasonDialog";
import { ApprovalIcon, ClockIcon, PlaneIcon, SendIcon, UsersIcon } from "@/components/app/icons";

import { ChangePasswordModal } from "./ChangePassword";
import { meGroup, type MeGroup, type MeTab } from "./groups";
import { TeamToday, type TeamTodayData } from "./TeamToday";
import { MyAi, type MyAiData } from "./MyAi";
import { PanelCard, ProfileForm, SectionHead, SectionNav, SettingRow, SettingsCard, ThemeCard, type AccountSection } from "./AccountSettings";
import { SessionsPanel } from "./SessionsPanel";
import { TwoStep } from "./TwoStep";
import { NotificationSettings } from "./NotificationSettings";
import { AttendanceFix } from "./AttendanceFix";
import { AttendanceHistory } from "./AttendanceHistory";
import { addDays } from "./attendanceGrid";
import { DelegationSettings } from "./DelegationSettings";
import { useNewParam } from "@/lib/deeplink";
import { missedDay, type ClockResult } from "@/components/shell/clock";
import type { LeaveRequest, MeData } from "@/app/app/me/page";

// Few people make API keys: the panel loads with the security section, not with Của tôi.
const PersonalKeys = dynamic(() => import("./PersonalKeys").then((m) => m.PersonalKeys), { ssr: false });
// AI agents (MCP): the connect panel and connected apps load only when the section is opened, from the same chunk as
// the keys (every on-demand chunk adds an entry to the webpack runtime that each route loads).
const AgentConnections = dynamic(() => import("./PersonalKeys").then((m) => m.AgentConnections), { ssr: false });
// The photo cropper loads only when someone opens it.
const AvatarEditor = dynamic(() => import("./AvatarEditor").then((m) => m.AvatarEditor), { ssr: false });

const LEAVE = (tx: T): Record<string, string> => ({ annual: tx("me.meview.phep_nam"), sick: tx("me.meview.nghi_om"), unpaid: tx("me.meview.khong_luong") });
const vnDate = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

export type { MeGroup, MeTab } from "./groups";
export interface Person {
  userId: string;
  code: string;
  displayName: string;
  title: string;
  department: string | null;
  managerId: string | null;
}
export interface MeExtra {
  /** Upcoming company holidays (Leave tab). */
  holidays?: { day: string; name: string }[];
  /** "Tên gọi": the name greetings use (the account's given name). */
  givenName?: string;
  /** Leave types from platform master data (code → Vietnamese label). */
  leaveTypes?: Record<string, string>;
  people?: Person[];
  departments?: { id: string; name: string; headId: string | null; members: number }[];
  attendanceDays?: { day: string; checkIn: string; checkOut: string | null; lateMinutes?: number; source?: string; correctionNote?: string | null; missedCheckout?: boolean }[];
  /** The workspace's today (YYYY-MM-DD): the last day of the attendance grid. */
  today?: string;
  isManager?: boolean;
  email?: string | null;
  /** Me › AI: what the company records about my AI use. */
  ai?: MyAiData;
  /** My employee record didn't load: the profile says so instead of showing empty facts. */
  meFailed?: boolean;
  /** Chấm công › Team today, for managers and HR (null: not theirs, or it failed). */
  teamToday?: TeamTodayData | null;
  /** Where to download the desktop app (Admin › Settings); null: no desktop app offered. */
  desktopDownload?: string | null;
}

/**
 * Two pages from one view: Hồ sơ của tôi (/app/me: profile, organisation, my AI) and Chấm công (/app/time:
 * attendance, leave and, for managers, the leave requests waiting for them).
 */
export function MeView({
  me,
  myLeave,
  toApprove,
  features,
  department,
  tab,
  extra,
}: {
  me: MeData;
  myLeave: LeaveRequest[];
  toApprove: LeaveRequest[];
  features: Record<string, boolean>;
  department: string | null;
  tab: MeTab;
  extra: MeExtra;
}) {
  const { time, dayInline } = useFormat();
  const tx = useT();
  const router = useRouter();
  const dir = useDirectory();
  const [leaveLink, setLeaveLink] = useNewParam("leave");
  const [modal, setModalRaw] = useState<"leave" | "password" | "photo" | null>(leaveLink ? "leave" : null);
  const setModal = (m: typeof modal) => {
    setModalRaw(m);
    if (!m) setLeaveLink(false);
  };
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "err" | "warn"; fix?: string } | null>(null);
  // `?fix=<day>` (the top bar's "forgot to check out" toast) opens the correction form on that day.
  const sp = useSearchParams();
  const [fixDay, setFixDayRaw] = useState<string | null>(() => (/^\d{4}-\d{2}-\d{2}$/.test(sp.get("fix") ?? "") ? sp.get("fix") : null));
  const setFixDay = (d: string | null) => {
    setFixDayRaw(d);
    if (!d && typeof window !== "undefined" && new URL(window.location.href).searchParams.has("fix")) {
      const url = new URL(window.location.href);
      url.searchParams.delete("fix");
      window.history.replaceState(window.history.state, "", url);
    }
  };
  // Check-in/out: a forgotten check-out from an earlier day is closed by the server with no hours; say which day and
  // offer the correction form instead of a bare "done". Already on the clock (another tab): just show the fresh state.
  const clock = async (kind: "check-in" | "check-out") => {
    setMsg(null);
    try {
      const r = await api<ClockResult>(`employee/attendance/${kind}`, { method: "POST" });
      const missed = missedDay(r);
      setMsg(
        missed
          ? { tone: "warn", text: tx("shell.top.missedClosed", { day: dayInline(`${missed}T12:00:00Z`) }), fix: missed }
          : { tone: "ok", text: tx(kind === "check-in" ? "me.meview.da_cham_cong_vao" : "me.meview.da_cham_cong_ra") },
      );
    } catch (e) {
      const b = (e as { body?: { error?: string } }).body;
      if (b?.error !== "already_checked_in") setMsg({ tone: "err", text: tx("me.meview.chua_thuc_hien_duoc") });
    }
    router.refresh();
  };
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg(null);
    try {
      await fn();
      setMsg({ text: ok, tone: "ok" });
      router.refresh();
    } catch (e) {
      const b = (e as { body?: { error?: string; available?: number; message?: string } }).body;
      setMsg({
        tone: "err",
        text:
          b?.error === "insufficient_balance"
            ? tx("me.meview.khong_du_ngay_phep", { p0: b.available ?? 0 })
            : b?.error === "overlapping_request"
              ? tx("me.meview.trung_voi_don_nghi")
              : b?.error === "already_decided"
                ? tx("me.meview.don_nay_da_duoc")
                : b?.error === "no_working_days"
                  ? tx("me.meview.noWorkingDays")
                  : b?.error === "reason_required"
                    ? tx("me.meview.reasonRequired")
                    : b?.error === "no_approver" || String(b?.message ?? "").includes("no manager")
                      ? tx("me.meview.ban_chua_co_quan_2")
                      : tx("me.meview.chua_thuc_hien_duoc"),
      });
    }
  };
  const p = me.profile;
  const name = dir.byId.get(dir.me)?.displayName ?? p?.displayName ?? dir.name(dir.me);
  const att = me.attendanceToday;
  const pendingApprovals = toApprove.filter((r) => r.status === "pending");
  const [refusing, setRefusing] = useState<(typeof pendingApprovals)[number] | null>(null);
  const people = extra.people ?? [];
  const leaveLabel = { ...LEAVE(tx), ...(extra.leaveTypes ?? {}) };

  const group = meGroup(tab);
  const section: AccountSection =
    tab === "ai" ? "privacy" : tab === "org" ? "profile" : ((["security", "agents", "notify", "away", "privacy"] as const).find((k) => k === tab) ?? "profile");
  const sections: AccountSection[] = ["profile", "security", "agents", "notify", "away", ...(extra.ai || me.profile?.managerId ? (["privacy"] as const) : [])];
  const showTeam = pendingApprovals.length > 0;
  const teamToday = features.attendance && extra.teamToday ? <TeamToday initial={extra.teamToday} /> : null;

  // Today's attendance as one control: not in → one solid button; in → an outline "ra"; done → nothing (the title says the times).
  const attendance = features.attendance ? (
    <div className="flex items-center gap-2 text-sm" role="group" aria-label={tx("me.meview.cham_cong_hom_nay")}>
      {/* The times are the page's title (Intro), so the control is only the next action. */}
      {att ? null : <span className="sr-only">{tx("me.meview.chua_cham_cong")}</span>}
      {!att ? (
        <button type="button" className={cx(btnPrimary, btnSm)} onClick={() => void clock("check-in")}>
          <ClockIcon className="size-3.5" />
          {tx("me.meview.cham_cong_vao")}
        </button>
      ) : null}
      {att && !att.checkOut ? (
        <button type="button" className={cx(btn, btnSm)} onClick={() => void clock("check-out")}>
          {tx("me.meview.cham_cong_ra")}
        </button>
      ) : null}
    </div>
  ) : null;
  // Chấm công: its own destination, the day's clock-in, leave and the team's leave to approve.
  const annual = me.leaveBalances.find((b) => b.type === "annual");
  const timeTitle = features.attendance
    ? att
      ? att.checkOut
        ? tx("me.overview.headDone", { in: time(att.checkIn), out: time(att.checkOut) })
        : tx("me.overview.headIn", { time: time(att.checkIn) })
      : tx("me.overview.headNotYet")
    : annual
      ? tx("me.overview.headLeave", { count: Math.max(0, annual.entitled - annual.used - annual.pending) })
      : tx("shell.nav.time");
  const timeHeader = (
    <>
      {/* The h1 stays for screen readers (the top bar names the page); the visible line is the day's state. */}
      <PageHeader title={tx("shell.nav.time")} />
      <Intro
        className="mb-6 max-md:mb-5"
        title={timeTitle}
        actions={
          <>
            {/* Phones: icon buttons (the label is the accessible name). Xin nghỉ sits on the leave section below. */}
            <button
              type="button"
              className={cx(btn, btnSm, "max-sm:w-8 max-sm:px-0")}
              onClick={() => router.push("/app/work/ops?new=request")}
              aria-label={tx("me.overview.newRequest")}
            >
              <SendIcon className="size-3.5" />
              <span className="max-sm:sr-only">{tx("me.overview.newRequest")}</span>
            </button>
            {attendance}
          </>
        }
      />
    </>
  );
  const reports = people.filter((x) => x.managerId === dir.me);
  const sectionH = "m-0 flex min-w-0 items-center gap-3 text-sm font-semibold tracking-[-0.01em]";

  // A forgotten check-out the server closed (no hours) reads as "no check-out", so the history flags it and the
  // correction form starts without an end time.
  const days = (extra.attendanceDays ?? []).map((d) => (d.missedCheckout ? { ...d, checkOut: null } : d));
  const today = extra.today ?? localDate(new Date());
  // A forgotten check-out in the last week stays on the Time page until it is fixed (the server clears the flag then).
  const recentMissed =
    days
      .filter((d) => d.missedCheckout && d.day >= addDays(today, -6))
      .map((d) => d.day)
      .sort()
      .at(-1) ?? null;
  const attendanceTab = (
    <div className="grid min-w-0 gap-4">
      {/* Corrections are asked for recent days only (45 days), from the chosen day in the history. */}
      <AttendanceHistory days={days} today={today} leaves={myLeave.filter((l) => l.status === "approved")} onFix={setFixDay} fixFrom={addDays(today, -44)} />
      <AttendanceFix days={days} request={fixDay} onClose={() => setFixDay(null)} />
    </div>
  );

  const approvalsList = pendingApprovals.length ? (
    <section aria-labelledby="leave-approvals-h" id="leave-approvals" className="grid gap-3">
      <h2 className={sectionH} id="leave-approvals-h">
        <IconTile tone="violet">
          <ApprovalIcon />
        </IconTile>
        {tx("me.meview.don_nghi_cho_ban")} <span className="text-ink-2 font-normal tabular-nums">{pendingApprovals.length}</span>
      </h2>
      <ul className={list}>
        {pendingApprovals.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <PersonTrigger userId={r.userId}>
              <Avatar id={r.userId} size="md" />
            </PersonTrigger>
            <span className="min-w-0 flex-1">
              <span className="block font-medium">{tx("me.meview.ngay_2", { p0: dir.name(r.userId), p1: leaveLabel[r.type] ?? r.type, p2: r.days })}</span>
              <span className="text-ink-2 text-xs">
                {vnDate(r.startDate)} → {vnDate(r.endDate)}
                {r.reason ? ` · ${r.reason}` : ""}
              </span>
            </span>
            <button
              type="button"
              className={btnPrimary}
              onClick={() => void run(() => api(`employee/leave/${r.id}/decision`, { method: "POST", body: { decision: "approved" } }), tx("me.meview.da_duyet_don_nghi"))}
            >
              {tx("me.meview.duyet")}
            </button>
            <button type="button" className={btn} onClick={() => setRefusing(r)}>
              {tx("me.meview.tu_choi")}
            </button>
          </li>
        ))}
      </ul>
    </section>
  ) : null;

  const leaveTab = (
    <div className="grid grid-cols-1 gap-8 max-md:gap-6">
      <section aria-labelledby="leave-h" className="grid gap-3">
        <div className="flex items-center gap-3">
          <h2 id="leave-h" className={cx(sectionH, "flex-1")}>
            <IconTile tone="green">
              <PlaneIcon />
            </IconTile>
            {tx("me.meview.so_ngay_phep_nam", { p0: new Date().getFullYear() })}
          </h2>
          <button type="button" className={btn} onClick={() => setModal("leave")}>
            {tx("me.meview.xin_nghi")}
          </button>
        </div>
        {extra.holidays?.length ? (
          <p className="text-ink-2 m-0 text-sm">
            {tx("me.meview.nghi_le_sap_toi")} {extra.holidays.map((h) => `${h.name} ${h.day.slice(8, 10)}/${h.day.slice(5, 7)}`).join(" · ")}
          </p>
        ) : null}
        {me.leaveBalances.length === 0 ? (
          <p className="text-ink-2 m-0 text-sm">
            {tx("me.meview.quan_tri_vien_chua")}{" "}
            {dir.byId.get(dir.me)?.roles?.some((r) => r === "Owner" || r === "Admin") ? <Link href="/admin/workspace/leave">{tx("me.meview.cap_phep_ngay")}</Link> : null}
          </p>
        ) : (
          <div className="grid gap-3 max-md:gap-2.5 sm:grid-cols-3">
            {me.leaveBalances.map((b) => {
              const left = b.entitled - b.used - b.pending;
              return (
                <div key={b.type} className={cx(card, "min-w-0 rounded-xl p-5 max-sm:p-4")}>
                  <p className="text-ink-2 m-0 text-[13px]">{leaveLabel[b.type] ?? b.type}</p>
                  <p className="m-0 mt-3 flex flex-wrap items-baseline gap-x-1.5">
                    <span className="font-display text-[38px]/none font-semibold tabular-nums tracking-[-0.045em]">{left}</span>
                    <span className="text-ink-2 text-[13px]">{tx("me.meview.ngay_con_lai", { p0: b.entitled })}</span>
                  </p>
                  <div className="bg-progress-track mt-4 h-1.5 overflow-hidden rounded-full" aria-hidden="true">
                    <div
                      className="bg-progress animate-grow-x h-full origin-left rounded-full"
                      style={{ width: `${Math.min(100, ((b.used + b.pending) / Math.max(b.entitled, 1)) * 100)}%` }}
                    />
                  </div>
                  <p className="text-ink-2 mt-2 text-xs">{tx("me.meview.da_dung_dang_cho", { p0: b.used, p1: b.pending })}</p>
                </div>
              );
            })}
          </div>
        )}
      </section>
      <section aria-labelledby="myleave-h" className="grid gap-3">
        <h2 id="myleave-h" className={sectionH}>
          <IconTile tone="sky">
            <SendIcon />
          </IconTile>
          {tx("me.meview.don_cua_ban")}
        </h2>
        {myLeave.length ? (
          <ul className={list}>
            {myLeave.map((r) => (
              <li key={r.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <span className="flex-1">
                  {leaveLabel[r.type] ?? r.type} · {vnDate(r.startDate)} → {vnDate(r.endDate)}{" "}
                  <span className="text-ink-2">
                    {tx("me.meview.n_ngay_paren", { p0: r.days })}
                    {r.reason ? ` · ${r.reason}` : ""}
                  </span>
                </span>
                <StatusPill status={r.status} />
                {r.status === "pending" ? (
                  <button
                    type="button"
                    className={cx(btn, btnSm)}
                    onClick={() => void run(() => api(`employee/leave/${r.id}/cancel`, { method: "POST" }), tx("me.meview.da_huy_don"))}
                  >
                    {tx("me.meview.huy_don")}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <div className={cx(card, "rounded-xl px-5 py-4 max-sm:px-4")}>
            <AllClear>{tx("me.meview.ban_chua_gui_don")}</AllClear>
          </div>
        )}
      </section>
    </div>
  );

  // Each tab stacks its sections in the order people reach for them. A `?tab=org|ai` link
  // lands on Hồ sơ with that section already open.
  const body: Record<MeGroup, React.ReactNode[]> = {
    profile: [
      // A section menu on the left and one section at a time,
      // each a few cards of label-and-control rows. The reporting line and the department live in Danh bạ.
      <div key="profile" className="grid grid-cols-1 gap-6 lg:grid-cols-[14rem_minmax(0,1fr)] lg:gap-10">
        <SectionNav active={section} sections={sections} />
        <div className="grid min-w-0 max-w-3xl grid-cols-1 content-start gap-5">
          <SectionHead section={section} />
          {section === "profile" && extra.meFailed ? <LoadFailed what={tx("me.meview.ho_so")} /> : null}
          {section === "profile" && !extra.meFailed ? (
            <>
              {p ? (
                <ProfileForm
                  initial={{ displayName: name, givenName: extra.givenName ?? "", phone: p.phone, location: p.location }}
                  onPhoto={() => setModal("photo")}
                  onSave={({ displayName, givenName, ...contact }) =>
                    run(async () => {
                      // The directory (identity) first: the employee profile's copy follows through identity.member.renamed.
                      if (displayName !== name) await api("identity/me/display-name", { method: "PUT", body: { displayName } });
                      await api("employee/me", { method: "PATCH", body: contact });
                      if (givenName && givenName !== extra.givenName) {
                        await api("identity/me/name", { method: "PUT", body: { givenName } });
                        await fetch("/api/session/name", { method: "POST", headers: { "x-wos-csrf": "1" } }); // the greeting reads the session
                      }
                    }, tx("me.settings.saved"))
                  }
                />
              ) : null}
              <ThemeCard desktopDownload={extra.desktopDownload ?? null} />
              <SettingsCard
                title={tx("me.settings.workCard")}
                desc={tx("me.profile.adminFacts")}
                footer={
                  <Link href="/app/me/people" className={cx(btn, "no-underline")}>
                    <UsersIcon className="size-4" />
                    {tx("me.meview.mo_danh_ba_cong")}
                  </Link>
                }
              >
                <SettingRow label="Email">
                  <span className="text-ink">{extra.email ?? "—"}</span>
                </SettingRow>
                <SettingRow label={tx("me.settings.workTitle")}>
                  <span className="text-ink">{[p?.title, department].filter(Boolean).join(" · ") || "—"}</span>
                </SettingRow>
                <SettingRow label={tx("me.meview.quan_ly_truc_tiep")}>
                  {p?.managerId ? <PersonChip userId={p.managerId} size="sm" className="text-ink" /> : <span className="text-ink-2">—</span>}
                </SettingRow>
                {reports.length ? (
                  <SettingRow label={tx("me.meview.bao_cao_truc_tiep")}>
                    <span className="flex items-center gap-2">
                      <AvatarStack ids={reports.map((x) => x.userId)} max={8} />
                      <span className="text-ink-2 tabular-nums">{reports.length}</span>
                    </span>
                  </SettingRow>
                ) : null}
                <SettingRow label={tx("me.meview.ma_nhan_vien")}>
                  <span className="text-ink font-mono text-[13px]">{p?.code || "—"}</span>
                </SettingRow>
              </SettingsCard>
            </>
          ) : null}
          {section === "security" ? (
            <>
              <SettingsCard>
                <SettingRow label={tx("me.settings.password")} hint={tx("me.meview.ban_dang_nhap_bang")}>
                  <span className="flex sm:justify-end">
                    <button type="button" className={btn} onClick={() => setModal("password")}>
                      {tx("me.meview.doi_mat_khau")}
                    </button>
                  </span>
                </SettingRow>
              </SettingsCard>
              <PanelCard>
                <TwoStep />
              </PanelCard>
              <PanelCard>
                <SessionsPanel />
              </PanelCard>
              <PanelCard>
                <PersonalKeys />
              </PanelCard>
            </>
          ) : null}
          {section === "agents" ? <AgentConnections /> : null}
          {section === "notify" ? (
            <PanelCard>
              <NotificationSettings />
            </PanelCard>
          ) : null}
          {section === "away" ? (
            <PanelCard>
              <DelegationSettings />
            </PanelCard>
          ) : null}
          {section === "privacy" ? (
            <>
              {p?.managerId ? <ManagerSees manager={dir.name(p.managerId)} /> : null}
              {/* My AI's sections are cards of their own: no card around them. */}
              {extra.ai ? <MyAi data={extra.ai} /> : null}
            </>
          ) : null}
        </div>
      </div>,
    ],
    // ?tab=team opens on Team today; otherwise it follows the person's own attendance.
    time:
      tab === "team"
        ? [teamToday, leaveTab, features.attendance ? attendanceTab : null, showTeam ? approvalsList : null]
        : [leaveTab, features.attendance ? attendanceTab : null, teamToday, showTeam ? approvalsList : null],
  };
  return (
    <div className="grid grid-cols-1">
      {/* Hồ sơ của tôi has no header: the profile card under the top bar's title is the person. */}
      {group === "time" ? timeHeader : null}
      {!msg && group === "time" && recentMissed ? (
        <p className="bg-warn-wash text-warn mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-3 py-2 text-sm" role="status">
          <span className="min-w-0 flex-1">{tx("shell.top.missedStrip", { day: dayInline(`${recentMissed}T12:00:00Z`) })}</span>
          <button type="button" className={cx(btn, btnSm, "shrink-0")} onClick={() => setFixDay(recentMissed)}>
            {tx("shell.top.missedFix")}
          </button>
        </p>
      ) : null}
      {msg ? (
        <p
          className={cx(
            "mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-3 py-2 text-sm",
            msg.tone === "ok" ? "bg-ok-wash text-ok" : msg.tone === "warn" ? "bg-warn-wash text-warn" : "bg-block-wash text-block",
          )}
          role="status"
        >
          <span className="min-w-0 flex-1">{msg.text}</span>
          {msg.fix ? (
            <button type="button" className={cx(btn, btnSm, "shrink-0")} onClick={() => setFixDay(msg.fix ?? null)}>
              {tx("shell.top.missedFix")}
            </button>
          ) : null}
        </p>
      ) : null}
      <SpotArea className="grid grid-cols-1 gap-10 max-md:gap-8">
        {body[group].filter(Boolean).map((b, i) => (
          <div key={i} className="min-w-0">
            {b}
          </div>
        ))}
      </SpotArea>
      {refusing ? (
        <ReasonDialog
          title={tx("ui.reason.leaveTitle")}
          subject={tx("me.meview.ngay_2", { p0: dir.name(refusing.userId), p1: leaveLabel[refusing.type] ?? refusing.type, p2: refusing.days })}
          onClose={() => setRefusing(null)}
          onConfirm={(note) => {
            const r = refusing;
            setRefusing(null);
            void run(() => api(`employee/leave/${r.id}/decision`, { method: "POST", body: { decision: "rejected", note } }), tx("me.meview.da_tu_choi_don"));
          }}
        />
      ) : null}
      {modal === "leave" ? (
        <LeaveModal
          types={leaveLabel}
          balances={me.leaveBalances}
          onClose={() => setModal(null)}
          onSubmit={(b) => {
            setModal(null);
            void run(() => api("employee/leave", { method: "POST", body: b }), tx("me.meview.da_gui_don_nghi"));
          }}
        />
      ) : null}
      {modal === "photo" ? (
        <AvatarEditor
          hasPhoto={(dir.byId.get(dir.me)?.avatarVersion ?? 0) > 0}
          onClose={() => setModal(null)}
          onDone={(text) => {
            setModal(null);
            setMsg({ text, tone: "ok" });
            // The directory comes with the layout: a refresh brings the new photo version everywhere.
            router.refresh();
          }}
        />
      ) : null}
      {modal === "password" ? (
        <ChangePasswordModal
          onClose={() => setModal(null)}
          onDone={() => {
            setModal(null);
            setMsg({ text: tx("me.meview.da_doi_mat_khau"), tone: "ok" });
          }}
        />
      ) : null}
    </div>
  );
}

function LeaveModal({
  types,
  balances,
  onClose,
  onSubmit,
}: {
  types: Record<string, string>;
  balances: MeData["leaveBalances"];
  onClose: () => void;
  onSubmit: (b: Record<string, unknown>) => void;
}) {
  const tx = useT();
  // The next working day (Monday to Friday) after today: leave is asked ahead, and a request starting today would read
  // "already started" to the approver the moment it is sent. Today is still one click away in the date field.
  const today = firstWorkingDay(addDays(localDate(), 1));
  const [type, setType] = useState("annual");
  const [start, setStart] = useState(today);
  const [end, setEnd] = useState(today);
  const [halfDay, setHalfDay] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const bal = balances.find((b) => b.type === type);
  return (
    <Modal
      title={tx("me.meview.xin_nghi_phep")}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btn} onClick={onClose}>
            {tx("me.meview.huy")}
          </button>
          <button
            type="button"
            className={btnPrimary}
            onClick={() => {
              if (end < start) {
                setError(tx("me.meview.ngay_ket_thuc_phai"));
                return;
              }
              onSubmit({ type, startDate: start, endDate: end, reason, halfDay });
            }}
          >
            {tx("me.meview.gui_don")}
          </button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4">
        <Field label={tx("me.meview.loai_nghi")} hint={bal ? tx("me.meview.con_ngay", { p0: bal.entitled - bal.used - bal.pending }) : undefined}>
          <Picker variant="field" label={tx("me.meview.loai_nghi")} value={type} onChange={setType} options={Object.entries(types).map(([k, v]) => ({ value: k, label: v }))} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={tx("me.meview.tu_ngay")} error={error}>
            <DateField
              label={tx("me.meview.tu_ngay")}
              value={start}
              clearable={false}
              onChange={(v) => {
                setStart(v);
                if (end < v) setEnd(v);
                setError(null);
              }}
            />
          </Field>
          <Field label={tx("me.meview.den_ngay")}>
            <DateField label={tx("me.meview.den_ngay")} value={end} clearable={false} align="right" onChange={setEnd} />
          </Field>
        </div>
        <Checkbox checked={halfDay} onChange={(e) => setHalfDay(e.target.checked)} label={tx("me.meview.nghi_nua_ngay")} />
        <Field label={tx("me.meview.ly_do_tuy_chon")}>
          <textarea className={textarea} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} />
        </Field>
      </div>
    </Modal>
  );
}

/** `day` itself when it is Monday to Friday, else the next Monday ("YYYY-MM-DD" in, out). */
function firstWorkingDay(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
