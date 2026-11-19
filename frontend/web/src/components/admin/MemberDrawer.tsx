"use client";

import { dateFormat } from "@/lib/intl";
import { PersonChip } from "@/components/chat/PersonTrigger";
import { useFeature } from "@/lib/features-context";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { useFormat, useT } from "@/lib/i18n/client";
import { INTL_TAG } from "@/lib/i18n/config";
import { Avatar, useDirectory } from "@/lib/people";
import { btn, btnSm, cardLink, chip, chipOk, chipWarn, cx } from "@/lib/ui";
import { Drawer } from "@/components/ui/Drawer";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { actionLabel } from "./audit";
import { roleLabel } from "./roleLabel";

export interface DrawerMember {
  userId: string;
  email: string;
  displayName: string;
  status: string;
  roles: string[];
  isOwner: boolean;
}
interface Overview {
  member: { twoStep: boolean; createdAt: string; lastSeenAt: string | null };
  sessions: { id: string; ip: string | null; startedAt: string; lastSeenAt: string; method: string; userAgent: string | null }[];
  signIns: { at: string; type: string; ip: string | null; error: string | null }[];
  activity: { id: string; actor: string; action: string; at: string }[];
}
interface Profile {
  code?: string;
  title?: string | null;
  department?: string | null;
  departmentName?: string | null;
  managerId?: string | null;
  location?: string | null;
  hireDate?: string | null;
}
interface Balance {
  entitled: number | null;
  used: number;
  pending: number;
}
interface Day {
  day: string;
  checkIn: string;
  checkOut: string | null;
  missedCheckout?: boolean;
}

type Load<V> = V | null | "failed";

/** One fetch per section: a section that fails shows its own retry, the rest of the drawer still reads. */
function useLoad<V>(path: string | null): [Load<V>, () => void] {
  const [v, setV] = useState<Load<V>>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    setV(null);
    api<V>(path)
      .then((r) => live && setV(r))
      .catch(() => live && setV("failed"));
    return () => {
      live = false;
    };
  }, [path, n]);
  return [v, () => setN((x) => x + 1)];
}

/** "Chrome on macOS" from a user agent, enough to recognise a device. */
function device(ua: string | null): string {
  if (!ua) return "—";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : ua.split(/[\s/(]/)[0] || "—";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} · ${os}` : browser;
}

/**
 * Admin › Members › one person, opened by clicking their row: who they are in the company (job, department, manager),
 * what they can do (roles, two-step sign-in), this month's attendance, this year's leave, where they are signed in
 * and the latest things done by or to them. Edits open the existing dialogs through `onEdit`.
 */
export function MemberDrawer({ m, canAudit, onClose, onEdit }: { m: DrawerMember; canAudit: boolean; onClose: () => void; onEdit: (kind: "roles" | "profile" | "leave") => void }) {
  const tx = useT();
  const f = useFormat();
  // Start and join dates name their year: "12 March 2019", not a weekday that reads like this week.
  const withYear = (iso: string) =>
    dateFormat(INTL_TAG[f.locale], { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso));
  const dir = useDirectory();
  const month = new Date().toISOString().slice(0, 7);
  const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const id = encodeURIComponent(m.userId);
  const [ov, retryOv] = useLoad<Overview>(`identity/members/${id}/overview`);
  const [profile, retryProfile] = useLoad<Profile>(m.status === "invited" ? null : `employee/employees/${id}`);
  // Attendance and leave are Chấm công: neither asked for nor shown on an installation without it.
  const hasTime = useFeature("time");
  const [leave, retryLeave] = useLoad<{ employees: Balance[] }>(m.status === "invited" || !hasTime ? null : `employee/leave/balances?type=annual&userId=${id}`);
  const [att, retryAtt] = useLoad<{ days: Day[] }>(m.status === "invited" || !hasTime ? null : `employee/attendance?userId=${id}&from=${month}-01&to=${last}`);
  const bal = leave && leave !== "failed" ? leave.employees[0] : undefined;
  const worked = att && att !== "failed" ? att.days.filter((d) => !d.missedCheckout).length : 0;
  const missed = att && att !== "failed" ? att.days.filter((d) => d.missedCheckout || !d.checkOut).length : 0;
  const status =
    m.status === "active" ? (
      <span className={chipOk}>{tx("admin.membersadmin.dang_hoat_dong")}</span>
    ) : m.status === "invited" ? (
      <span className={chipWarn}>{tx("admin.membersadmin.da_moi")}</span>
    ) : (
      <span className={chip}>{tx("admin.membersadmin.vo_hieu")}</span>
    );
  return (
    <Drawer title={m.displayName} onClose={onClose} padded>
      <div className="grid gap-6 text-sm">
        <header className="flex items-center gap-3">
          <Avatar id={m.userId} name={m.displayName} size="lg" />
          <div className="grid min-w-0 gap-0.5">
            <span className="truncate text-base font-semibold">{m.displayName}</span>
            <span className="text-ink-2 truncate">{m.email}</span>
            <span className="mt-1 flex flex-wrap gap-1.5">
              {status}
              {m.isOwner ? <span className={chip}>{tx("admin.membersadmin.chu")}</span> : null}
            </span>
          </div>
        </header>

        <Section title={tx("admin.memberDrawer.job")} action={m.status === "invited" ? null : <EditBtn onClick={() => onEdit("profile")} label={tx("common.edit")} />}>
          {m.status === "invited" ? (
            <p className="text-ink-2 m-0">{tx("admin.memberDrawer.invitedNote")}</p>
          ) : profile === "failed" ? (
            <LoadFailed onRetry={retryProfile} />
          ) : (
            <Facts
              rows={[
                [tx("admin.membersadmin.chuc_danh"), profile?.title || "—"],
                [tx("admin.memberDrawer.department"), profile?.departmentName || profile?.department || "—"],
                [tx("admin.membersadmin.manager"), profile?.managerId ? <PersonChip userId={profile.managerId} dense /> : "—"],
                [tx("admin.memberDrawer.location"), profile?.location || "—"],
                [tx("admin.memberDrawer.hired"), profile?.hireDate ? withYear(profile.hireDate) : "—"],
                [tx("admin.memberDrawer.code"), profile?.code ? <span className="font-mono text-xs">{profile.code}</span> : "—"],
              ]}
              loading={profile === null}
            />
          )}
        </Section>

        <Section title={tx("admin.memberDrawer.access")} action={<EditBtn onClick={() => onEdit("roles")} label={tx("admin.membersadmin.doi_vai_tro")} />}>
          <Facts
            rows={[
              [
                tx("admin.membersadmin.vai_tro"),
                <span key="r" className="flex flex-wrap gap-1">
                  {(m.roles.length > 1 ? m.roles.filter((r) => r !== "Employee") : m.roles).map((r) => (
                    <span key={r} className={chip}>
                      {roleLabel(r, tx)}
                    </span>
                  ))}
                </span>,
              ],
              [tx("admin.memberDrawer.twoStep"), ov && ov !== "failed" ? (ov.member.twoStep ? tx("admin.memberDrawer.on") : tx("admin.memberDrawer.off")) : "—"],
              [tx("admin.memberDrawer.joined"), ov && ov !== "failed" ? withYear(ov.member.createdAt) : "—"],
              [tx("admin.memberDrawer.lastSeen"), ov && ov !== "failed" ? (ov.member.lastSeenAt ? f.ago(ov.member.lastSeenAt) : tx("admin.memberDrawer.never")) : "—"],
            ]}
            loading={ov === null}
          />
        </Section>

        {m.status === "invited" || !hasTime ? null : (
          <div className="grid gap-6 sm:grid-cols-2">
            <Section
              title={tx("admin.memberDrawer.attendance")}
              action={
                <Link href={`/admin/workspace/attendance/${id}`} className={cardLink}>
                  {tx("admin.memberDrawer.open")}
                </Link>
              }
            >
              {att === "failed" ? (
                <LoadFailed onRetry={retryAtt} />
              ) : (
                <p className="m-0">
                  <span className="font-display text-2xl font-semibold tabular-nums">{att ? worked : "—"}</span>{" "}
                  <span className="text-ink-2">{tx("admin.memberDrawer.daysThisMonth")}</span>
                  {missed ? <span className="text-warn mt-1 block text-xs">{tx("admin.memberDrawer.missedOut", { count: missed })}</span> : null}
                </p>
              )}
            </Section>
            <Section title={tx("admin.memberDrawer.leave")} action={<EditBtn onClick={() => onEdit("leave")} label={tx("common.edit")} />}>
              {leave === "failed" ? (
                <LoadFailed onRetry={retryLeave} />
              ) : (
                <p className="m-0">
                  <span className="font-display text-2xl font-semibold tabular-nums">{bal ? f.number(Math.max(0, (bal.entitled ?? 0) - bal.used), 1) : "—"}</span>{" "}
                  <span className="text-ink-2">
                    {bal ? tx("admin.memberDrawer.leaveLeft", { used: f.number(bal.used, 1), total: f.number(bal.entitled ?? 0, 1) }) : tx("admin.memberDrawer.noLeave")}
                  </span>
                  {bal?.pending ? <span className="text-warn mt-1 block text-xs">{tx("admin.memberDrawer.leavePending", { days: f.number(bal.pending, 1) })}</span> : null}
                </p>
              )}
            </Section>
          </div>
        )}

        <Section title={tx("admin.memberDrawer.sessions")}>
          {ov === "failed" ? (
            <LoadFailed onRetry={retryOv} />
          ) : ov === null ? (
            <Skeleton />
          ) : ov.sessions.length ? (
            <ul className="divide-divider-soft m-0 grid list-none divide-y p-0">
              {ov.sessions.slice(0, 5).map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-3 py-2">
                  <span className="min-w-0 truncate">{device(s.userAgent)}</span>
                  <span className="text-ink-2 shrink-0 text-xs">{f.ago(s.lastSeenAt)}</span>
                </li>
              ))}
              {ov.sessions.length > 5 ? <li className="text-ink-2 py-2 text-xs">{tx("admin.memberDrawer.moreSessions", { count: ov.sessions.length - 5 })}</li> : null}
            </ul>
          ) : (
            <p className="text-ink-2 m-0">{tx("admin.memberDrawer.noSessions")}</p>
          )}
        </Section>

        <Section
          title={tx("admin.memberDrawer.activity")}
          action={
            canAudit ? (
              <Link href={`/admin/workspace/audit?range=all&targetType=member&targetId=${id}`} className={cardLink}>
                {tx("admin.trail.history")}
              </Link>
            ) : null
          }
        >
          {ov === "failed" ? null : ov === null ? (
            <Skeleton />
          ) : ov.activity.length ? (
            <ul className="m-0 grid list-none gap-2 p-0">
              {ov.activity.slice(0, 8).map((a) => (
                <li key={a.id} className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0">
                    <span className="text-ink">{a.actor === m.userId ? m.displayName : dir.name(a.actor)}</span> <span className="text-ink-2">{actionLabel(tx, a.action)}</span>
                  </span>
                  <span className="text-ink-2 shrink-0 text-xs">{f.ago(a.at)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-ink-2 m-0">{tx("admin.memberDrawer.noActivity")}</p>
          )}
        </Section>
      </div>
    </Drawer>
  );
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="grid gap-2">
      <div className="flex min-h-7 items-center justify-between gap-3">
        <h3 className="text-ink-2 m-0 text-xs font-semibold uppercase tracking-[0.04em]">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function EditBtn({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button type="button" className={cx(btn, btnSm)} onClick={onClick}>
      {label}
    </button>
  );
}

function Facts({ rows, loading }: { rows: [string, React.ReactNode][]; loading?: boolean }) {
  return (
    <dl className="m-0 grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-4 gap-y-2">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-ink-2">{k}</dt>
          <dd className="m-0 min-w-0">{loading ? <span className="shimmer inline-block h-3 w-24 rounded-md" /> : v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Skeleton() {
  return (
    <div className="grid gap-2">
      <span className="shimmer block h-3 w-3/5 rounded-md" />
      <span className="shimmer block h-3 w-2/5 rounded-md" />
    </div>
  );
}
