"use client";

import { PersonChip } from "@/components/chat/PersonTrigger";
import { useFeature } from "@/lib/features-context";
import { useT } from "@/lib/i18n/client";
import { Checkbox } from "@/components/ui/Checkbox";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/client";
import { Avatar, useDirectory } from "@/lib/people";
import { btn, btnPrimary, cx, input, searchPill, table, btnDanger } from "@/lib/ui";
import { Modal } from "@/components/ui/Modal";
import { Field } from "@/components/ui/bits";
import { AdminHeader, useCanOpen } from "./AdminNav";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { Menu } from "@/components/ui/Menu";
import { ChevronLeftIcon, ChevronRightIcon, MoreIcon, PlusIcon, SearchIcon } from "@/components/app/icons";
import { Picker } from "@/components/ui/Picker";
import { BULK_ERRORS, checkBulk, parseBulk, type BulkResult } from "./bulk";
import { adminErrorText } from "./api-errors";
import { roleLabel } from "./roleLabel";
import { PickerField } from "./PickerField";
import { DateField } from "@/components/ui/DateField";
import { leaveTypeName, type LeaveType } from "./people-settings";
import { useLocale } from "@/lib/i18n/client";
import { useConfirm } from "@/components/ui/Confirm";
import { MemberDrawer } from "./MemberDrawer";
import { CopyButton } from "@/components/ui/CopyButton";

interface Member {
  userId: string;
  email: string;
  displayName: string;
  status: string;
  roles: string[];
  isOwner: boolean;
}
interface Role {
  id: string;
  name: string;
  system: boolean;
}
interface Emp {
  userId: string;
  title: string;
  department: string | null;
  managerId: string | null;
}

/** A link the admin hands over in person or by chat: an activation, a sign-in page or a password reset. */
type Handover = { url: string; kind: "activate" | "login" | "reset"; name: string };

/** What an invite answers: whether the email went out and, if not, the link to hand over instead. */
type InviteResult = { userId?: string; emailed?: boolean; existingAccount?: boolean; activationUrl?: string | null; activationKind?: "activate" | "login" | null };

/** People: invite, roles, employee profile, leave entitlement. Every change is audited server-side. */
export function MembersAdmin({
  members,
  roles: rolesOrNull,
  employees,
  departments,
}: {
  members: Member[];
  /** Null when the role list did not load: the members still show, while inviting and changing roles (which need a role
   * to pick) wait for a retry. */
  roles: Role[] | null;
  employees: Emp[];
  departments: { id: string; name: string }[];
}) {
  const roles = rolesOrNull ?? [];
  const tx = useT();
  const { confirm, dialog } = useConfirm();
  const router = useRouter();
  const canAudit = useCanOpen("/admin/workspace/audit");
  const hasTime = useFeature("time");
  const dir = useDirectory();
  const [modal, setModal] = useState<{ kind: "invite" | "bulk" } | { kind: "roles" | "profile" | "leave" | "disable" | "handover" | "resetpw"; m: Member } | null>(null);
  const [q, setQ] = useState("");
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "err" } | null>(null);
  const [open, setOpen] = useState<Member | null>(null);
  /** A link to hand over in person or by chat (activation, sign-in or password reset), shown with a Copy button. */
  const [handover, setHandover] = useState<Handover | null>(null);
  // Without SMTP (production without SMTP_URL) invites and resets are handed over as links, so the screen says so.
  const [mailConfigured, setMailConfigured] = useState<boolean | null>(null);
  useEffect(() => {
    void api<{ configured: boolean }>("identity/mail/status")
      .then((r) => setMailConfigured(r.configured))
      .catch(() => setMailConfigured(null));
  }, []);
  const meIsOwner = members.some((m) => m.userId === dir.me && m.isOwner);
  const emp = Object.fromEntries(employees.map((e) => [e.userId, e]));
  /** Shows an activation (or sign-in) link to hand over, with a Copy button: never silently on the clipboard. */
  const copyLink = (link: { url: string; kind?: string | null }, name?: string) =>
    setHandover({ url: link.url, kind: link.kind === "login" ? "login" : "activate", name: name ?? "" });
  const done = (text: string) => {
    setModal(null);
    setMsg({ text, tone: "ok" });
    router.refresh();
  };
  const fail = (e: unknown, fallback: string) => {
    const s = (e as { status?: number }).status;
    setMsg({ tone: "err", text: adminErrorText(tx, e, s === 409 ? tx("admin.membersadmin.nguoi_nay_da_la") : fallback) });
  };
  // Filters for a company of a few hundred people: name/email/title, role, department and status, 50 rows a page.
  const [fRole, setFRole] = useState("");
  const [fDept, setFDept] = useState("");
  const [fStatus, setFStatus] = useState("");
  const [page, setPage] = useState(0);
  const PAGE = 50;
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return members.filter(
      (m) =>
        (!needle || `${m.displayName} ${m.email} ${emp[m.userId]?.title ?? ""}`.toLowerCase().includes(needle)) &&
        (!fRole || m.roles.includes(fRole)) &&
        (!fDept || (fDept === "-" ? !emp[m.userId]?.department : emp[m.userId]?.department === fDept)) &&
        (!fStatus || m.status === fStatus),
    );
    // emp is rebuilt each render from the same props; members and employees change together.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members, employees, q, fRole, fDept, fStatus]);
  const pages = Math.max(1, Math.ceil(list.length / PAGE));
  const at = Math.min(page, pages - 1);
  const shown = list.slice(at * PAGE, at * PAGE + PAGE);
  const counts = { active: 0, invited: 0, disabled: 0 } as Record<string, number>;
  for (const m of members) counts[m.status] = (counts[m.status] ?? 0) + 1;
  const deptNames = [...new Set(employees.map((e) => e.department).filter((d): d is string => !!d))].sort((a, b) => a.localeCompare(b));
  const filtered = !!(q || fRole || fDept || fStatus);

  return (
    <>
      {dialog}
      <>
        <AdminHeader
          title={tx("admin.membersadmin.thanh_vien")}
          sub={tx("admin.membersadmin.activeMembers", { count: members.filter((m) => m.status === "active").length })}
          actions={
            <>
              <button type="button" className={btn} disabled={!rolesOrNull} onClick={() => setModal({ kind: "bulk" })}>
                {tx("admin.membersadmin.moi_nhieu_nguoi")}
              </button>
              <button type="button" className={btnPrimary} disabled={!rolesOrNull} onClick={() => setModal({ kind: "invite" })}>
                <PlusIcon className="size-4" />
                {tx("admin.membersadmin.moi_thanh_vien")}
              </button>
            </>
          }
        />
        {mailConfigured === false ? (
          <p className="bg-warn-wash text-warn mb-4 rounded-lg px-3 py-2 text-sm" role="status">
            {tx("admin.membersadmin.mailOff")}
          </p>
        ) : null}
        {rolesOrNull ? null : <LoadFailed what={tx("admin.membersadmin.vai_tro")} className="mb-4" />}
        {msg ? (
          <p className={cx("mb-4 rounded-lg px-3 py-2 text-sm", msg.tone === "ok" ? "bg-ok-wash text-ok" : "bg-block-wash text-block")} role="status">
            {msg.text}
          </p>
        ) : null}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <label className={cx(searchPill, "min-h-9 w-72 max-w-full")}>
            <SearchIcon className="pointer-events-none size-4 shrink-0" />
            <input
              className="text-ink placeholder:text-ink-2 min-h-9 min-w-0 flex-1 bg-transparent outline-none"
              placeholder={tx("admin.membersadmin.tim_theo_ten_hoac")}
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(0);
              }}
              aria-label={tx("admin.membersadmin.tim_thanh_vien")}
            />
          </label>
          <Picker
            variant="button"
            label={tx("admin.membersadmin.vai_tro")}
            value={fRole}
            onChange={(v) => {
              setFRole(v);
              setPage(0);
            }}
            options={[{ value: "", label: tx("admin.membersadmin.r2.allRoles") }, ...roles.map((r) => ({ value: r.name, label: roleLabel(r.name, tx) }))]}
          />
          <Picker
            variant="button"
            label={tx("admin.membersadmin.r2.department")}
            value={fDept}
            onChange={(v) => {
              setFDept(v);
              setPage(0);
            }}
            options={[
              { value: "", label: tx("admin.membersadmin.r2.allDepartments") },
              ...deptNames.map((d) => ({ value: d, label: d })),
              { value: "-", label: tx("admin.membersadmin.r2.noDepartment") },
            ]}
          />
          <Picker
            variant="button"
            label={tx("admin.membersadmin.trang_thai")}
            value={fStatus}
            onChange={(v) => {
              setFStatus(v);
              setPage(0);
            }}
            options={[
              { value: "", label: tx("admin.membersadmin.r2.allStatuses", { count: members.length }) },
              { value: "active", label: `${tx("admin.membersadmin.dang_hoat_dong")} · ${counts.active ?? 0}` },
              { value: "invited", label: `${tx("admin.membersadmin.da_moi")} · ${counts.invited ?? 0}` },
              { value: "disabled", label: `${tx("admin.membersadmin.vo_hieu")} · ${counts.disabled ?? 0}` },
            ]}
          />
          {filtered ? (
            <button
              type="button"
              className="text-ink-2 hover:text-ink text-sm underline-offset-2 hover:underline"
              onClick={() => {
                setQ("");
                setFRole("");
                setFDept("");
                setFStatus("");
                setPage(0);
              }}
            >
              {tx("admin.membersadmin.r2.clear")}
            </button>
          ) : null}
        </div>
        <div className="bg-surface shadow-card overflow-x-auto rounded-xl">
          <table className={table}>
            <thead>
              <tr>
                <th>{tx("admin.membersadmin.thanh_vien")}</th>
                <th className="max-lg:hidden">{tx("admin.membersadmin.chuc_danh")}</th>
                <th className="max-lg:hidden">{tx("admin.membersadmin.manager")}</th>
                <th className="max-md:hidden">{tx("admin.membersadmin.vai_tro")}</th>
                <th className="max-sm:hidden">{tx("admin.membersadmin.trang_thai")}</th>
                <th className="w-10">
                  <span className="sr-only">{tx("admin.membersadmin.thao_tac")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((m) => (
                <tr
                  key={m.userId}
                  className="hover:bg-hover/50 cursor-pointer"
                  onClick={(e) => {
                    // The row opens the person; buttons and the menu inside it keep their own action.
                    if (!(e.target as HTMLElement).closest("button,a,[role=menu]")) setOpen(m);
                  }}
                >
                  <td>
                    <span className="flex items-center gap-2.5">
                      <Avatar id={m.userId} name={m.displayName} size="md" />
                      <span>
                        <button type="button" className="text-ink block text-left font-medium hover:underline" onClick={() => setOpen(m)}>
                          {m.displayName}
                          {m.isOwner ? (
                            <span className="border-hairline text-ink-2 ml-1.5 rounded-md border px-1.5 py-px text-xs font-medium">{tx("admin.membersadmin.chu")}</span>
                          ) : null}
                        </button>
                        <span className="text-ink-2 block text-xs">{m.email}</span>
                        {emp[m.userId]?.title ? <span className="text-ink-2 block text-xs lg:hidden">{emp[m.userId]!.title}</span> : null}
                      </span>
                    </span>
                  </td>
                  <td className="max-lg:hidden">
                    {emp[m.userId]?.title || <span className="text-ink-2">—</span>}
                    {emp[m.userId]?.department ? <span className="text-ink-2 block text-xs">{emp[m.userId]!.department}</span> : null}
                  </td>
                  <td className="max-lg:hidden">
                    {emp[m.userId]?.managerId ? (
                      <PersonChip userId={emp[m.userId]!.managerId!} dense className="text-sm" />
                    ) : m.isOwner ? (
                      <span className="text-ink-2 text-xs">{tx("admin.membersadmin.top")}</span>
                    ) : (
                      <button type="button" className="text-warn text-xs font-medium underline" onClick={() => setModal({ kind: "profile", m })}>
                        {tx("admin.membersadmin.noManager")}
                      </button>
                    )}
                  </td>
                  <td className="max-md:hidden">
                    <span className="flex flex-wrap gap-1">
                      {/* Everyone has Employee: list it only when it is the only role. */}
                      {(m.roles.length > 1 ? m.roles.filter((r) => r !== "Employee") : m.roles).map((r) => (
                        <span key={r} className={cx("rounded-md px-1.5 py-0.5 text-xs", r === "Employee" ? "text-ink-2" : "bg-hover text-ink")}>
                          {roleLabel(r, tx)}
                        </span>
                      ))}
                    </span>
                  </td>
                  <td className="max-sm:hidden">
                    <span className="text-ink-2 inline-flex items-center gap-1.5 whitespace-nowrap text-xs">
                      <span className={cx("size-1.5 rounded-full", m.status === "active" ? "bg-ok" : m.status === "invited" ? "bg-warn" : "bg-ink-2/40")} aria-hidden="true" />
                      {m.status === "invited"
                        ? tx("admin.membersadmin.da_moi")
                        : m.status === "active"
                          ? tx("admin.membersadmin.dang_hoat_dong")
                          : tx("admin.membersadmin.vo_hieu")}
                    </span>
                  </td>
                  <td>
                    <Menu
                      label={tx("admin.membersadmin.thao_tac_cho", { p0: m.displayName })}
                      items={[
                        ...(rolesOrNull ? [{ label: tx("admin.membersadmin.doi_vai_tro"), onSelect: () => setModal({ kind: "roles", m }) }] : []),
                        { label: tx("admin.membersadmin.ho_so_nhan_vien_2"), onSelect: () => setModal({ kind: "profile", m }) },
                        ...(hasTime ? [{ label: tx("admin.membersadmin.cap_ngay_phep_2"), onSelect: () => setModal({ kind: "leave", m }) }] : []),
                        // Everything done to this member (roles, sign-ins, resets…) on the audit trail.
                        ...(canAudit
                          ? [
                              {
                                label: tx("admin.trail.history"),
                                onSelect: () => router.push(`/admin/workspace/audit?range=all&targetType=member&targetId=${encodeURIComponent(m.userId)}`),
                              },
                            ]
                          : []),
                        ...(m.status === "active" && m.userId !== dir.me
                          ? [
                              {
                                label: tx("admin.membersadmin.dang_xuat_moi_noi"),
                                onSelect: async () => {
                                  if (await confirm({ title: tx("admin.membersadmin.dang_xuat_khoi_moi", { p0: m.displayName }), danger: true }))
                                    void api(`identity/members/${m.userId}/sessions/logout`, { method: "POST" })
                                      .then(() => done(tx("admin.membersadmin.da_dang_xuat_khoi", { p0: m.displayName })))
                                      .catch((e) => fail(e, tx("admin.membersadmin.chua_dang_xuat_duoc")));
                                },
                              },
                            ]
                          : []),
                        ...(m.status === "active" && m.userId !== dir.me
                          ? [
                              { label: tx("admin.membersadmin.resetPassword"), onSelect: () => setModal({ kind: "resetpw", m }) },
                              {
                                label: tx("admin.membersadmin.resetMfa"),
                                onSelect: async () => {
                                  if (await confirm({ title: tx("admin.membersadmin.resetMfaConfirm", { p0: m.displayName }), danger: true }))
                                    void api(`identity/members/${m.userId}/mfa/reset`, { method: "POST" })
                                      .then(() => done(tx("admin.membersadmin.resetMfaDone", { p0: m.displayName })))
                                      .catch((e) => fail(e, tx("admin.membersadmin.resetMfaFailed")));
                                },
                              },
                            ]
                          : []),
                        ...(meIsOwner && m.status === "active" && !m.isOwner && m.userId !== dir.me
                          ? [
                              {
                                label: tx("admin.membersadmin.transferOwner"),
                                onSelect: async () => {
                                  if (await confirm({ title: tx("admin.membersadmin.transferOwnerConfirm", { p0: m.displayName }), danger: true }))
                                    void api("identity/workspace/owner", { method: "POST", body: { userId: m.userId } })
                                      .then(() => done(tx("admin.membersadmin.transferOwnerDone", { p0: m.displayName })))
                                      .catch((e) => fail(e, tx("admin.membersadmin.transferOwnerFailed")));
                                },
                              },
                            ]
                          : []),
                        ...(m.status === "active" && !m.isOwner && m.userId !== dir.me
                          ? [{ label: tx("admin.membersadmin.vo_hieu_hoa_nghi"), danger: true, onSelect: () => setModal({ kind: "disable", m }) }]
                          : []),
                        ...(m.status === "disabled"
                          ? [
                              { label: tx("admin.membersadmin.ban_giao_cong_viec_2"), onSelect: () => setModal({ kind: "handover", m }) },
                              {
                                label: tx("admin.membersadmin.kich_hoat_lai"),
                                onSelect: () =>
                                  void api(`identity/members/${m.userId}/enable`, { method: "POST" })
                                    .then(() => done(tx("admin.membersadmin.da_kich_hoat_lai", { p0: m.displayName })))
                                    .catch((e) => fail(e, tx("admin.membersadmin.chua_kich_hoat_lai"))),
                              },
                            ]
                          : []),
                        ...(m.status === "invited"
                          ? [
                              {
                                label: tx("admin.membersadmin.copyActivationLink"),
                                onSelect: () =>
                                  void api<{ url: string; kind: "activate" | "login" }>(`identity/members/${m.userId}/activation-link`)
                                    .then((l) => copyLink(l, m.displayName))
                                    .catch((e) => fail(e, tx("admin.membersadmin.chua_gui_lai_duoc"))),
                              },
                              ...(mailConfigured !== false
                                ? [
                                    {
                                      label: tx("admin.membersadmin.gui_lai_email_kich"),
                                      onSelect: () =>
                                        void api(`identity/members/${m.userId}/invite/resend`, { method: "POST" })
                                          .then(() => done(tx("admin.membersadmin.da_gui_lai_email", { p0: m.email })))
                                          .catch((e) => {
                                            // The email could not go out: the answer carries the link to hand over instead.
                                            const b = (e as { body?: { error?: string; url?: string; kind?: string } }).body;
                                            if (b?.error === "email_not_sent" && b.url) copyLink({ url: b.url, kind: b.kind }, m.displayName);
                                            else fail(e, tx("admin.membersadmin.chua_gui_lai_duoc"));
                                          }),
                                    },
                                  ]
                                : []),
                              {
                                label: tx("admin.membersadmin.huy_loi_moi"),
                                danger: true,
                                onSelect: async () => {
                                  if (
                                    await confirm({
                                      title: tx("admin.membersadmin.r2.cancelInviteTitle", { p0: m.email }),
                                      body: tx("admin.membersadmin.r2.cancelInviteBody"),
                                      confirmLabel: tx("admin.membersadmin.huy_loi_moi"),
                                      danger: true,
                                    })
                                  )
                                    void api(`identity/members/${m.userId}/invite`, { method: "DELETE" })
                                      .then(() => done(tx("admin.membersadmin.da_huy_loi_moi")))
                                      .catch((e) => fail(e, tx("admin.membersadmin.chua_huy_duoc")));
                                },
                              },
                            ]
                          : []),
                      ]}
                      trigger={
                        <span className="text-ink-2 hover:bg-hover grid size-8 place-items-center rounded-md">
                          <MoreIcon />
                        </span>
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {shown.length === 0 ? <p className="text-ink-2 m-0 px-4 py-6 text-center text-sm">{tx("admin.membersadmin.r2.none")}</p> : null}
        </div>
        {list.length > PAGE ? (
          <nav className="text-ink-2 mt-3 flex items-center justify-end gap-2 text-sm" aria-label={tx("admin.membersadmin.r2.pages")}>
            <span className="tabular-nums">{tx("admin.membersadmin.r2.range", { from: at * PAGE + 1, to: Math.min(list.length, at * PAGE + PAGE), total: list.length })}</span>
            <button type="button" className={cx(btn, "min-h-8 px-2")} disabled={at === 0} onClick={() => setPage(at - 1)} aria-label={tx("admin.membersadmin.r2.prev")}>
              <ChevronLeftIcon className="size-4" />
            </button>
            <button type="button" className={cx(btn, "min-h-8 px-2")} disabled={at >= pages - 1} onClick={() => setPage(at + 1)} aria-label={tx("admin.membersadmin.r2.next")}>
              <ChevronRightIcon className="size-4" />
            </button>
          </nav>
        ) : null}
        {modal?.kind === "bulk" ? (
          <BulkInviteModal
            roles={roles}
            departments={departments}
            members={members}
            onClose={() => {
              setModal(null);
              router.refresh();
            }}
          />
        ) : null}
        {modal?.kind === "invite" ? (
          <InviteModal
            roles={roles}
            departments={departments}
            members={members}
            onClose={() => setModal(null)}
            onDone={done}
            onFail={fail}
            onLink={(h) => {
              setModal(null);
              router.refresh();
              setHandover(h);
            }}
          />
        ) : null}
        {modal?.kind === "roles" ? <RolesModal m={modal.m} roles={roles} onClose={() => setModal(null)} onDone={done} onFail={fail} /> : null}
        {modal?.kind === "profile" ? (
          <ProfileModal m={modal.m} emp={emp[modal.m.userId]} members={members} departments={departments} onClose={() => setModal(null)} onDone={done} onFail={fail} />
        ) : null}
        {modal?.kind === "leave" ? <LeaveModal m={modal.m} onClose={() => setModal(null)} onDone={done} onFail={fail} /> : null}
        {modal?.kind === "resetpw" ? (
          <ResetPasswordModal
            m={modal.m}
            onClose={() => setModal(null)}
            onDone={done}
            onFail={fail}
            onLink={(h) => {
              setModal(null);
              setHandover(h);
            }}
          />
        ) : null}
        {open ? (
          <MemberDrawer
            m={open}
            canAudit={canAudit}
            onClose={() => setOpen(null)}
            onEdit={(kind) => {
              const m = open;
              setOpen(null);
              setModal({ kind, m });
            }}
          />
        ) : null}
        {handover ? <HandoverModal h={handover} onClose={() => setHandover(null)} /> : null}
        {modal?.kind === "disable" || modal?.kind === "handover" ? (
          <DisableModal m={modal.m} members={members} handoverOnly={modal.kind === "handover"} onClose={() => setModal(null)} onDone={done} onFail={fail} />
        ) : null}
      </>
    </>
  );
}

type Cb = { onClose: () => void; onDone: (t: string) => void; onFail: (e: unknown, f: string) => void };

function InviteModal({
  roles,
  departments,
  members,
  onClose,
  onDone,
  onFail,
  onLink,
}: { roles: Role[]; departments: { id: string; name: string }[]; members: Member[]; onLink: (h: Handover) => void } & Cb) {
  const tx = useT();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState(roles.find((r) => r.name === "Employee")?.name ?? roles[0]?.name ?? "");
  // Department and manager at invite time: someone without them is missing from progress per department and from
  // leave approvals until an admin goes back to fill them in.
  const [dept, setDept] = useState("");
  const [manager, setManager] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try {
      const r = await api<InviteResult>("identity/members/invite", { method: "POST", body: { email, displayName: name, roleNames: [role] } });
      let profileSaved = true;
      if (r.userId && (dept || manager))
        await api(`employee/employees/${r.userId}`, { method: "PUT", body: { displayName: name, departmentId: dept || null, managerId: manager || null } }).catch(() => {
          profileSaved = false;
        });
      if (!r.emailed && r.activationUrl) return onLink({ url: r.activationUrl, kind: r.activationKind === "login" ? "login" : "activate", name });
      const text = r.emailed ? tx("admin.membersadmin.da_moi_email_kich", { p0: name, p1: email }) : tx("admin.membersadmin.da_them_vao_workspace", { p0: name });
      onDone(profileSaved ? text : `${text} ${tx("admin.membersadmin.inviteProfileFailed")}`);
    } catch (e) {
      onFail(e, tx("admin.membersadmin.chua_gui_duoc_loi"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={tx("admin.membersadmin.moi_thanh_vien")}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btn} onClick={onClose}>
            {tx("admin.membersadmin.huy")}
          </button>
          <button type="button" className={btnPrimary} disabled={!email || !name || busy} onClick={() => void send()}>
            {tx("admin.membersadmin.gui_loi_moi")}
          </button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4">
        <Field label={tx("admin.membersadmin.email_cong_viec")}>
          <input className={input} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </Field>
        <Field label={tx("admin.membersadmin.ho_ten")} hint={tx("admin.membersadmin.viet_ho_truoc_ten")}>
          <input className={input} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <PickerField
          label={tx("admin.membersadmin.vai_tro")}
          hint={tx("admin.membersadmin.chu_so_huu_khong")}
          value={role}
          onChange={setRole}
          options={roles.filter((r) => r.name !== "Owner").map((r) => ({ value: r.name, label: roleLabel(r.name, tx) }))}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <PickerField
            label={tx("admin.membersadmin.phong_ban")}
            hint={departments.length ? undefined : tx("admin.membersadmin.tao_phong_ban_o")}
            value={dept}
            onChange={setDept}
            options={[{ value: "", label: "—" }, ...departments.map((d) => ({ value: d.id, label: d.name }))]}
          />
          <PickerField
            label={tx("admin.membersadmin.quan_ly_truc_tiep")}
            value={manager}
            onChange={setManager}
            options={[
              { value: "", label: "—" },
              ...members.filter((x) => x.status === "active").map((x) => ({ value: x.userId, label: x.displayName, keywords: x.email, icon: <Avatar id={x.userId} size="xs" /> })),
            ]}
          />
        </div>
      </div>
    </Modal>
  );
}

/**
 * The link an admin hands over in person or by chat when no email went out: shown in full with a Copy button (never
 * silently put on the clipboard), with one line on what the person does with it.
 */
function HandoverModal({ h, onClose }: { h: Handover; onClose: () => void }) {
  const tx = useT();
  const title =
    h.kind === "reset"
      ? tx("admin.membersadmin.handoverResetTitle", { p0: h.name })
      : h.kind === "login"
        ? tx("admin.membersadmin.handoverLoginTitle", { p0: h.name })
        : tx("admin.membersadmin.handoverTitle", { p0: h.name });
  const body =
    h.kind === "reset" ? tx("admin.membersadmin.handoverResetBody") : h.kind === "login" ? tx("admin.membersadmin.activationLinkIsLogin") : tx("admin.membersadmin.handoverBody");
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <button type="button" className={btnPrimary} onClick={onClose}>
          {tx("admin.membersadmin.done")}
        </button>
      }
    >
      <div className="grid gap-3 text-sm">
        <p className="text-ink-2 m-0">{body}</p>
        <div className="flex min-w-0 items-center gap-2">
          <input className={cx(input, "min-w-0 flex-1 font-mono text-xs")} readOnly value={h.url} aria-label={title} onFocus={(e) => e.currentTarget.select()} />
          <CopyButton text={h.url} primary />
        </div>
      </div>
    </Modal>
  );
}

/** A temporary password for a colleague who is locked out: generated here, shown once, replaced at their first sign-in. */
function ResetPasswordModal({ m, onClose, onDone, onFail, onLink }: { m: Member; onLink: (h: Handover) => void } & Cb) {
  const tx = useT();
  const [result, setResult] = useState<{ password: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const generate = () => {
    setBusy(true);
    void api<{ password: string }>(`identity/members/${m.userId}/password/reset`, { method: "POST", body: {} })
      .then(setResult)
      .catch((e) => onFail(e, tx("admin.membersadmin.resetPasswordFailed")))
      .finally(() => setBusy(false));
  };
  // The other way to hand over access: a one-time link where the person picks their own password.
  const link = () => {
    setBusy(true);
    void api<{ url: string }>(`identity/members/${m.userId}/password/reset-link`, { method: "POST" })
      .then((r) => onLink({ url: r.url, kind: "reset", name: m.displayName }))
      .catch((e) => onFail(e, tx("admin.membersadmin.resetPasswordFailed")))
      .finally(() => setBusy(false));
  };
  return (
    <Modal
      title={tx("admin.membersadmin.resetPasswordTitle", { p0: m.displayName })}
      onClose={onClose}
      footer={
        result ? (
          // The password stays in this dialog only: closing it never repeats it on the page.
          <button type="button" className={btnPrimary} onClick={() => onDone(tx("admin.membersadmin.resetPasswordDone", { p0: m.displayName }))}>
            {tx("admin.membersadmin.done")}
          </button>
        ) : (
          <>
            <button type="button" className={btn} onClick={onClose}>
              {tx("admin.membersadmin.huy")}
            </button>
            <button type="button" className={btn} disabled={busy} onClick={link}>
              {tx("admin.membersadmin.resetLinkCta")}
            </button>
            <button type="button" className={btnPrimary} disabled={busy} onClick={generate}>
              {tx("admin.membersadmin.resetPasswordGenerate")}
            </button>
          </>
        )
      }
    >
      <div className="grid gap-3 text-sm">
        <p className="text-ink-2 m-0">{tx("admin.membersadmin.resetPasswordBody", { p0: m.displayName })}</p>
        {result ? (
          <div className="grid gap-2">
            <p className="m-0 font-medium">{tx("admin.membersadmin.resetPasswordShown")}</p>
            <div className="flex flex-wrap items-center gap-2">
              <code className="bg-hover select-all rounded-md px-3 py-2 text-base tracking-wide">{result.password}</code>
              <CopyButton text={result.password} label={tx("admin.membersadmin.copyPassword")} copiedLabel={tx("admin.membersadmin.passwordCopied")} />
            </div>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

function RolesModal({ m, roles, onClose, onDone, onFail }: { m: Member; roles: Role[] } & Cb) {
  const tx = useT();
  // Every member always holds Employee (the base permissions); other roles add to it.
  const base = roles.find((r) => r.system && r.name === "Employee")?.id;
  const [sel, setSel] = useState([...new Set([...roles.filter((r) => m.roles.includes(r.name)).map((r) => r.id), ...(base ? [base] : [])])]);
  return (
    <Modal
      title={tx("admin.membersadmin.vai_tro_cua", { p0: m.displayName })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btn} onClick={onClose}>
            {tx("admin.membersadmin.huy")}
          </button>
          <button
            type="button"
            className={btnPrimary}
            disabled={!sel.length}
            onClick={() =>
              void api(`identity/members/${m.userId}/roles`, { method: "PUT", body: { roleIds: sel } })
                .then(() => onDone(tx("admin.membersadmin.da_doi_vai_tro")))
                .catch((e) => onFail(e, tx("admin.membersadmin.chua_doi_duoc_vai")))
            }
          >
            {tx("admin.membersadmin.luu")}
          </button>
        </>
      }
    >
      <p className="text-ink-2 mb-3 text-sm">{tx("admin.membersadmin.nhieu_vai_tro")}</p>
      <div className="grid grid-cols-1 gap-1.5">
        {roles.map((r) => (
          <label
            key={r.id}
            className={cx(
              "flex items-center gap-2.5 rounded-md border px-3 py-2",
              r.id === base ? "cursor-default" : "cursor-pointer",
              sel.includes(r.id) ? "border-brand-text bg-brand-wash" : "border-hairline",
            )}
          >
            <Checkbox checked={sel.includes(r.id)} disabled={r.id === base} onChange={(e) => setSel((s) => (e.target.checked ? [...s, r.id] : s.filter((x) => x !== r.id)))} />
            {roleLabel(r.name, tx)}
            {r.id === base ? (
              <span className="text-ink-2 text-xs">{tx("admin.membersadmin.luon_co")}</span>
            ) : r.system ? (
              <span className="text-ink-2 text-xs">{tx("admin.membersadmin.mac_dinh")}</span>
            ) : null}
          </label>
        ))}
      </div>
    </Modal>
  );
}

function ProfileModal({ m, emp, members, departments, onClose, onDone, onFail }: { m: Member; emp?: Emp; members: Member[]; departments: { id: string; name: string }[] } & Cb) {
  const tx = useT();
  const [title, setTitle] = useState(emp?.title ?? "");
  const [dept, setDept] = useState(departments.find((d) => d.name === emp?.department)?.id ?? "");
  const [manager, setManager] = useState(emp?.managerId ?? "");
  const [location, setLocation] = useState("");
  const [hire, setHire] = useState("");
  // The list only carries title, department and manager: load the rest so saving does not blank the work location
  // and hire date that were already set.
  useEffect(() => {
    let live = true;
    void api<{ title?: string; departmentId?: string | null; managerId?: string | null; location?: string | null; hireDate?: string | null }>(`employee/employees/${m.userId}`)
      .then((p) => {
        if (!live) return;
        if (p.title) setTitle(p.title);
        if (p.departmentId) setDept(p.departmentId);
        if (p.managerId) setManager(p.managerId);
        setLocation(p.location ?? "");
        setHire(p.hireDate?.slice(0, 10) ?? "");
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [m.userId]);
  return (
    <Modal
      title={tx("admin.membersadmin.ho_so_nhan_vien", { p0: m.displayName })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btn} onClick={onClose}>
            {tx("admin.membersadmin.huy")}
          </button>
          <button
            type="button"
            className={btnPrimary}
            onClick={() =>
              void api(`employee/employees/${m.userId}`, {
                method: "PUT",
                body: { displayName: m.displayName, title, departmentId: dept || null, managerId: manager || null, location, hireDate: hire || null },
              })
                .then(() => onDone(tx("admin.membersadmin.da_luu_ho_so")))
                .catch((e) => onFail(e, tx("admin.membersadmin.chua_luu_duoc_ho")))
            }
          >
            {tx("admin.membersadmin.luu")}
          </button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4">
        <Field label={tx("admin.membersadmin.chuc_danh")}>
          <input className={input} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={tx("admin.membersadmin.ky_su_phan_mem")} />
        </Field>
        <PickerField
          label={tx("admin.membersadmin.phong_ban")}
          hint={departments.length ? undefined : tx("admin.membersadmin.tao_phong_ban_o")}
          value={dept}
          onChange={setDept}
          options={[{ value: "", label: "—" }, ...departments.map((d) => ({ value: d.id, label: d.name }))]}
        />
        <PickerField
          label={tx("admin.membersadmin.quan_ly_truc_tiep")}
          hint={tx("admin.membersadmin.quan_ly_duyet_don")}
          value={manager}
          onChange={setManager}
          options={[
            { value: "", label: "—" },
            ...members.filter((x) => x.userId !== m.userId).map((x) => ({ value: x.userId, label: x.displayName, keywords: x.email, icon: <Avatar id={x.userId} size="xs" /> })),
          ]}
        />
        <div className="grid grid-cols-2 gap-3">
          <Field label={tx("admin.membersadmin.noi_lam_viec")}>
            <input className={input} value={location} onChange={(e) => setLocation(e.target.value)} />
          </Field>
          <div className="grid min-w-0 content-start gap-1.5">
            <span className="text-sm font-medium" aria-hidden="true">
              {tx("admin.membersadmin.ngay_vao_lam")}
            </span>
            <DateField label={tx("admin.membersadmin.ngay_vao_lam")} value={hire} onChange={setHire} />
          </div>
        </div>
      </div>
    </Modal>
  );
}

function LeaveModal({ m, onClose, onDone, onFail }: { m: Member } & Cb) {
  const tx = useT();
  const locale = useLocale();
  const [type, setType] = useState("annual");
  const [days, setDays] = useState("12");
  // The workspace's own balance-bearing types (Admin › Nghỉ phép defines them).
  const [types, setTypes] = useState<LeaveType[]>([]);
  useEffect(() => {
    void api<{ types: LeaveType[] }>("employee/leave/types")
      .then((r) => setTypes(r.types.filter((t) => t.active && t.requiresBalance)))
      .catch(() => undefined);
  }, []);
  return (
    <Modal
      title={tx("admin.membersadmin.cap_ngay_phep", { p0: m.displayName })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btn} onClick={onClose}>
            {tx("admin.membersadmin.huy")}
          </button>
          <button
            type="button"
            className={btnPrimary}
            onClick={() =>
              void api(`employee/leave/balances/${m.userId}`, { method: "PUT", body: { type, year: new Date().getFullYear(), entitledDays: Number(days) } })
                .then(() => onDone(tx("admin.membersadmin.da_cap_ngay_phep")))
                .catch((e) => onFail(e, tx("admin.membersadmin.chua_cap_duoc")))
            }
          >
            {tx("admin.membersadmin.luu")}
          </button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <PickerField
          label={tx("admin.membersadmin.loai")}
          value={type}
          onChange={setType}
          options={types.length ? types.map((t) => ({ value: t.code, label: leaveTypeName(t, locale) })) : [{ value: "annual", label: tx("admin.membersadmin.phep_nam") }]}
        />
        <Field label={tx("admin.membersadmin.so_ngay_nam", { p0: new Date().getFullYear() })}>
          <input className={input} inputMode="decimal" value={days} onChange={(e) => setDays(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

interface Held {
  tasks: number;
  approvals: number;
  decisions: number;
  projects: number;
  leaveApprovals: number;
  reports: number;
}

/** Offboarding: shows what the person still holds and hands it to a colleague before (or after) disabling. */
function DisableModal({ m, members, handoverOnly, onClose, onDone, onFail }: { m: Member; members: Member[]; handoverOnly: boolean } & Cb) {
  const tx = useT();
  const [busy, setBusy] = useState(false);
  const [held, setHeld] = useState<Held | null>(null);
  const [to, setTo] = useState("");
  useEffect(() => {
    const none = { leaveApprovals: 0, reports: 0 };
    void Promise.all([api<Omit<Held, keyof typeof none>>(`work/handover/${m.userId}`), api<typeof none>(`employee/handover/${m.userId}`).catch(() => none)])
      .then(([w, e]) => setHeld({ ...w, ...e }))
      .catch(() => setHeld(null));
  }, [m.userId]);
  const total = held ? held.tasks + held.approvals + held.decisions + held.projects + held.leaveApprovals + held.reports : 0;
  const parts = held
    ? [
        held.tasks ? tx("admin.membersadmin.viec_dang_mo", { p0: held.tasks }) : "",
        held.projects ? tx("admin.membersadmin.du_an_phu_trach", { p0: held.projects }) : "",
        held.approvals ? tx("admin.membersadmin.yeu_cau_cho_duyet", { p0: held.approvals }) : "",
        held.decisions ? tx("admin.membersadmin.quyet_dinh_cho_chot", { p0: held.decisions }) : "",
        held.leaveApprovals ? tx("admin.membersadmin.don_nghi_cho_duyet", { p0: held.leaveApprovals }) : "",
        held.reports ? tx("admin.membersadmin.nhan_vien_bao_cao", { p0: held.reports }) : "",
      ].filter(Boolean)
    : [];
  const submit = async () => {
    setBusy(true);
    try {
      let moved = "";
      if (to && total) {
        await api(`work/handover/${m.userId}`, { method: "POST", body: { toUserId: to } });
        if (held && (held.leaveApprovals || held.reports)) await api(`employee/handover/${m.userId}`, { method: "POST", body: { toUserId: to } });
        moved = tx("admin.membersadmin.da_ban_giao_cho", { p0: members.find((x) => x.userId === to)?.displayName ?? tx("admin.membersadmin.dong_nghiep") });
      }
      if (!handoverOnly) await api(`identity/members/${m.userId}/disable`, { method: "POST" });
      onDone(
        handoverOnly ? tx("admin.membersadmin.da_ban_giao_cong", { p0: m.displayName, p1: moved }) : tx("admin.membersadmin.da_vo_hieu_hoa", { p0: m.displayName, p1: moved }),
      );
    } catch (e) {
      setBusy(false);
      onFail(e, handoverOnly ? tx("admin.membersadmin.chua_ban_giao_duoc") : tx("admin.membersadmin.chua_vo_hieu_hoa"));
    }
  };
  return (
    <Modal
      title={handoverOnly ? tx("admin.membersadmin.ban_giao_cong_viec", { p0: m.displayName }) : tx("admin.membersadmin.vo_hieu_hoa", { p0: m.displayName })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btn} onClick={onClose}>
            {tx("admin.membersadmin.huy")}
          </button>
          <button type="button" className={handoverOnly ? btnPrimary : btnDanger} disabled={busy || (handoverOnly && (!to || !total))} onClick={() => void submit()}>
            {handoverOnly ? tx("admin.membersadmin.ban_giao") : tx("admin.membersadmin.vo_hieu_hoa_2")}
          </button>
        </>
      }
    >
      <div className="grid gap-4 text-sm">
        {handoverOnly ? null : (
          <ul className="m-0 grid list-disc gap-1.5 pl-5">
            <li>{tx("admin.membersadmin.khong_vao_duoc_workspace", { p0: m.displayName })}</li>
            <li>{tx("admin.membersadmin.tin_nhan_viec_tai")}</li>
            <li>{tx("admin.membersadmin.ban_co_the_kich")}</li>
          </ul>
        )}
        <div className="border-hairline rounded-md border p-3">
          <p className="m-0 font-medium">{tx("admin.membersadmin.cong_viec_dang_giu")}</p>
          <p className="text-ink-2 m-0 mt-0.5">
            {held === null ? tx("admin.membersadmin.dang_kiem_tra") : total ? parts.join(" · ") : tx("admin.membersadmin.khong_con_viec_phe")}
          </p>
          {total ? (
            <PickerField
              label={tx("admin.membersadmin.ban_giao_cho")}
              hint={tx("admin.membersadmin.moi_thu_o_tren")}
              value={to}
              onChange={setTo}
              options={[
                { value: "", label: handoverOnly ? tx("admin.membersadmin.chon_nguoi_nhan") : tx("admin.membersadmin.khong_ban_giao_luc") },
                ...members
                  .filter((x) => x.userId !== m.userId && x.status === "active")
                  .map((x) => ({ value: x.userId, label: x.displayName, keywords: x.email, icon: <Avatar id={x.userId} size="xs" /> })),
              ]}
            />
          ) : null}
        </div>
      </div>
    </Modal>
  );
}

function BulkInviteModal({ roles, departments, members, onClose }: { roles: Role[]; departments: { id: string; name: string }[]; members: Member[]; onClose: () => void }) {
  const tx = useT();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<BulkResult[] | null>(null);
  const [error, setError] = useState("");
  const errorText = BULK_ERRORS(tx);
  // Checked before sending: each row shows its problems, and only the rows without any are invited.
  const checked = checkBulk(parseBulk(text), { roles: roles.map((r) => r.name), departments, people: members });
  const good = checked.filter((r) => !r.errors.length);
  const load = async (f: File | undefined) => {
    if (f) setText(await f.text());
  };
  const send = async () => {
    setBusy(true);
    setError("");
    try {
      const rows = good.map(({ email, displayName, roleName }) => ({ email, displayName, ...(roleName ? { roleName } : {}) }));
      const out = (await api<{ results: BulkResult[] }>("identity/members/invite/bulk", { method: "POST", body: { rows } })).results;
      // Department and manager go on the employee profile once each person exists; a manager invited in the same file
      // is found by email among the new results.
      const byEmail = new Map(out.filter((r) => r.userId).map((r) => [r.email.toLowerCase(), r.userId!]));
      await Promise.all(
        good
          .filter((r) => r.departmentId || r.manager)
          .map((r) => {
            const userId = byEmail.get(r.email.toLowerCase());
            const managerId = r.managerId ?? (r.manager ? (byEmail.get(r.manager.toLowerCase()) ?? null) : null);
            return userId
              ? api(`employee/employees/${userId}`, { method: "PUT", body: { displayName: r.displayName, departmentId: r.departmentId, managerId } }).catch(() => undefined)
              : undefined;
          }),
      );
      setResults(out);
    } catch {
      setError(tx("admin.membersadmin.chua_gui_duoc_danh"));
    } finally {
      setBusy(false);
    }
  };
  const ok = results?.filter((r) => r.status !== "error").length ?? 0;
  return (
    <Modal
      title={tx("admin.membersadmin.moi_nhieu_nguoi")}
      wide
      onClose={onClose}
      footer={
        results ? (
          <button type="button" className={btnPrimary} onClick={onClose}>
            {tx("admin.membersadmin.done")}
          </button>
        ) : (
          <>
            <button type="button" className={btn} onClick={onClose}>
              {tx("admin.membersadmin.huy")}
            </button>
            <button type="button" className={btnPrimary} disabled={busy || !good.length || good.length > 200} onClick={() => void send()}>
              {busy ? tx("admin.membersadmin.dang_moi") : tx("admin.membersadmin.moi_nguoi", { p0: good.length })}
            </button>
          </>
        )
      }
    >
      {results ? (
        <div className="grid gap-3 text-sm">
          <p className="m-0" role="status">
            {tx("admin.membersadmin.da_moi_ket_qua", { p0: ok, p1: results.length })}
          </p>
          <ul className="m-0 grid max-h-72 list-none gap-1 overflow-y-auto p-0">
            {results.map((r, i) => (
              <li key={i} className="odd:bg-hover flex flex-wrap items-center gap-x-3 gap-y-1 rounded-sm px-2 py-1">
                <span className="min-w-0 flex-1 truncate">{r.email || "—"}</span>
                <span className={r.status === "error" ? "text-block" : r.emailed === false ? "text-warn" : "text-ok"}>
                  {r.status === "error"
                    ? (errorText[r.error ?? "failed"] ?? r.error)
                    : r.emailed === false
                      ? tx("admin.membersadmin.bulkEmailNotSent")
                      : r.status === "added"
                        ? tx("admin.membersadmin.da_them")
                        : tx("admin.membersadmin.da_gui_loi_moi")}
                </span>
                {r.activationUrl ? <CopyButton text={r.activationUrl} label={tx("admin.membersadmin.copyActivationLink")} /> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="grid gap-3 text-sm">
          <p className="text-ink-2 m-0">
            {tx("admin.membersadmin.moi_dong_mot_nguoi")} <span className="font-mono text-xs">{tx("admin.membersadmin.bulkColumns")}</span>. {tx("admin.membersadmin.bulk_help")}
          </p>
          <textarea
            className={cx(input, "min-h-32 font-mono text-xs")}
            aria-label={tx("admin.membersadmin.danh_sach_nguoi_can")}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={tx("admin.membersadmin.bulkPlaceholder")}
          />
          <div className="flex flex-wrap items-center gap-3">
            <label className={cx(btn, "cursor-pointer")}>
              {tx("admin.membersadmin.chon_file_csv")}
              <input type="file" accept=".csv,text/csv,text/plain" className="sr-only" onChange={(e) => void load(e.target.files?.[0])} />
            </label>
            <span className="text-ink-2">
              {checked.length ? tx("admin.membersadmin.bulkReady", { ok: good.length, bad: checked.length - good.length }) : tx("admin.membersadmin.chua_co_ai")}
            </span>
          </div>
          {checked.length ? (
            <div className="border-hairline max-h-64 overflow-auto rounded-lg border">
              <table className={cx(table, "text-xs")}>
                <thead>
                  <tr>
                    <th>{tx("admin.membersadmin.email_cong_viec")}</th>
                    <th>{tx("admin.membersadmin.ho_ten")}</th>
                    <th className="max-sm:hidden">{tx("admin.membersadmin.phong_ban")}</th>
                    <th className="max-sm:hidden">{tx("admin.membersadmin.manager")}</th>
                    <th>{tx("admin.membersadmin.trang_thai")}</th>
                  </tr>
                </thead>
                <tbody>
                  {checked.map((r, i) => (
                    <tr key={i} className={r.errors.length ? "bg-block-wash/40" : undefined}>
                      <td className="max-w-48 truncate">{r.email || "—"}</td>
                      <td className="max-w-40 truncate">{r.displayName || "—"}</td>
                      <td className="max-sm:hidden">{r.department || "—"}</td>
                      <td className="max-w-40 truncate max-sm:hidden">{r.manager || "—"}</td>
                      <td className={r.errors.length ? "text-block" : "text-ok"}>
                        {r.errors.length ? r.errors.map((e) => errorText[e] ?? e).join(" · ") : tx("admin.membersadmin.bulkRowOk")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {good.length > 200 ? <p className="text-block m-0">{tx("admin.membersadmin.toi_da_200")}</p> : null}
          <p className="text-ink-2 m-0 text-xs">
            {tx("admin.membersadmin.vai_tro_co_the", {
              p0: roles
                .filter((r) => r.name !== "Owner")
                .map((r) => r.name)
                .join(", "),
            })}
          </p>
          {error ? (
            <p className="text-block m-0" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      )}
    </Modal>
  );
}
