"use client";

import { CalmEmpty, SectionHead } from "./AdminBits";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { useT } from "@/lib/i18n/client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/client";
import { AvatarStack, useDirectory } from "@/lib/people";
import { btn, btnPrimary, cx, input } from "@/lib/ui";
import { Modal } from "@/components/ui/Modal";
import { Menu } from "@/components/ui/Menu";
import { Field } from "@/components/ui/bits";
import { AdminHeader } from "./AdminNav";
import { PeoplePicker } from "@/components/chat/NewConversation";
import { MoreIcon, PencilIcon, PlusIcon, TrashIcon, UsersIcon, WorkIcon } from "@/components/app/icons";
import { useConfirm } from "@/components/ui/Confirm";

type Team = { id: string; name: string; memberIds: string[] };
type Department = { id: string; name: string; headId: string | null; members: number };

/** Teams (TEAM-scope permissions) and departments (organization, managers): create, edit, delete. */
/** `departments` is null when that list did not load: its section offers a retry, teams stay editable. */
export function TeamsAdmin({ teams, departments }: { teams: Team[]; departments: Department[] | null }) {
  const tx = useT();
  const { confirm, dialog } = useConfirm();
  const router = useRouter();
  const dir = useDirectory();
  const [modal, setModal] = useState<{ kind: "team"; team?: Team } | { kind: "dept"; dept?: Department } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const done = () => {
    setModal(null);
    router.refresh();
  };
  const removeTeam = async (t: Team) => {
    if (!(await confirm({ title: tx("admin.teamsadmin.xoa_team_hoi", { p0: t.name }), danger: true }))) return;
    try {
      await api(`identity/teams/${t.id}`, { method: "DELETE" });
      router.refresh();
    } catch {
      setMsg(tx("admin.teamsadmin.chua_xoa_duoc"));
    }
  };
  const removeDept = async (d: Department) => {
    if (d.members > 0 && !(await confirm({ title: tx("admin.teamsadmin.xoa_phong_ban_hoi", { p0: d.name, p1: d.members }), danger: true }))) return;
    try {
      await api(`employee/departments/${d.id}${d.members > 0 ? "?move=1" : ""}`, { method: "DELETE" });
      router.refresh();
    } catch {
      setMsg(tx("admin.teamsadmin.chua_xoa_duoc"));
    }
  };
  const more = (label: string, items: { label: string; icon: React.ReactNode; danger?: boolean; onSelect: () => void }[]) => (
    <Menu
      label={label}
      trigger={
        <span className={cx(btn, "size-8 min-h-0 px-0")}>
          <MoreIcon className="size-4" />
        </span>
      }
      items={items}
    />
  );
  return (
    <>
      {dialog}
      <>
        <AdminHeader title={tx("admin.teamsadmin.team_phong_ban")} sub={tx("admin.teamsadmin.team_quyet_dinh_pham")} />
        {msg ? (
          <p className="text-block mb-3 text-sm" role="alert">
            {msg}
          </p>
        ) : null}
        <section className="mb-10 max-md:mb-8" aria-labelledby="t-h">
          <SectionHead
            id="t-h"
            title="Team"
            icon={<UsersIcon />}
            tone="violet"
            actions={
              <button type="button" className={btn} onClick={() => setModal({ kind: "team" })}>
                <PlusIcon className="size-4" />
                {tx("admin.teamsadmin.tao_team")}
              </button>
            }
          />
          {teams.length === 0 ? (
            <CalmEmpty title={tx("admin.teamsadmin.chua_co_team")} />
          ) : (
            <ul className="divide-divider-soft shadow-card bg-surface m-0 list-none divide-y overflow-hidden rounded-xl p-0">
              {teams.map((t) => (
                <li key={t.id} className="hover:bg-hover/50 flex min-h-12 items-center gap-3 py-2 pl-5 pr-2 transition-colors max-sm:pl-4">
                  <span className="min-w-0 flex-1 truncate font-medium">{t.name}</span>
                  <AvatarStack ids={t.memberIds} />
                  <span className="text-ink-2 w-20 text-right text-sm">{tx("admin.teamsadmin.nguoi", { p0: t.memberIds.length })}</span>
                  {more(tx("admin.teamsadmin.thao_tac"), [
                    { label: tx("admin.teamsadmin.sua_team"), icon: <PencilIcon />, onSelect: () => setModal({ kind: "team", team: t }) },
                    { label: tx("admin.teamsadmin.xoa_team"), icon: <TrashIcon />, danger: true, onSelect: () => void removeTeam(t) },
                  ])}
                </li>
              ))}
            </ul>
          )}
        </section>
        <section aria-labelledby="d-h">
          <SectionHead
            id="d-h"
            title={tx("admin.teamsadmin.phong_ban")}
            icon={<WorkIcon />}
            tone="sky"
            actions={
              <button type="button" className={btn} onClick={() => setModal({ kind: "dept" })}>
                <PlusIcon className="size-4" />
                {tx("admin.teamsadmin.tao_phong_ban")}
              </button>
            }
          />
          {departments === null ? (
            <LoadFailed />
          ) : departments.length === 0 ? (
            <CalmEmpty title={tx("admin.teamsadmin.chua_co_phong_ban")} />
          ) : (
            <ul className="divide-divider-soft shadow-card bg-surface m-0 list-none divide-y overflow-hidden rounded-xl p-0">
              {departments.map((d) => (
                <li key={d.id} className="hover:bg-hover/50 flex min-h-12 items-center gap-3 py-2 pl-5 pr-2 transition-colors max-sm:pl-4">
                  {/* Phones: the lead and head count go under the name, so the name is never cut to "Customer …". */}
                  <span className="flex min-w-0 flex-1 items-baseline gap-x-3 max-sm:flex-col">
                    <span className="min-w-0 flex-1 truncate font-medium max-sm:w-full max-sm:whitespace-normal">{d.name}</span>
                    <span className="text-ink-2 text-sm max-sm:text-xs">
                      {tx("admin.teamsadmin.nguoi_2", { p0: d.headId ? tx("admin.teamsadmin.truong", { p0: dir.name(d.headId) }) : "", p1: d.members })}
                    </span>
                  </span>
                  {more(tx("admin.teamsadmin.thao_tac"), [
                    { label: tx("admin.teamsadmin.sua_phong_ban"), icon: <PencilIcon />, onSelect: () => setModal({ kind: "dept", dept: d }) },
                    { label: tx("admin.teamsadmin.xoa_phong_ban"), icon: <TrashIcon />, danger: true, onSelect: () => void removeDept(d) },
                  ])}
                </li>
              ))}
            </ul>
          )}
        </section>
        {modal?.kind === "team" ? <TeamModal team={modal.team} onClose={() => setModal(null)} onDone={done} /> : null}
        {modal?.kind === "dept" ? <DeptModal dept={modal.dept} onClose={() => setModal(null)} onDone={done} /> : null}
      </>
    </>
  );
}

function TeamModal({ team, onClose, onDone }: { team: Team | undefined; onClose: () => void; onDone: () => void }) {
  const tx = useT();
  const [name, setName] = useState(team?.name ?? "");
  const [ids, setIds] = useState<string[]>(team?.memberIds ?? []);
  const [err, setErr] = useState<string | null>(null);
  const save = () =>
    void (team ? api(`identity/teams/${team.id}`, { method: "PATCH", body: { name, memberIds: ids } }) : api("identity/teams", { method: "POST", body: { name, memberIds: ids } }))
      .then(onDone)
      .catch(() => setErr(team ? tx("admin.teamsadmin.chua_luu_duoc") : tx("admin.teamsadmin.chua_tao_duoc_team")));
  return (
    <Modal
      title={team ? tx("admin.teamsadmin.sua_team") : tx("admin.teamsadmin.tao_team")}
      wide
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btn} onClick={onClose}>
            {tx("admin.teamsadmin.huy")}
          </button>
          <button type="button" className={btnPrimary} disabled={!name.trim()} onClick={save}>
            {team ? tx("admin.teamsadmin.luu") : tx("admin.teamsadmin.tao")}
          </button>
        </>
      }
    >
      <div className="grid gap-4 md:grid-cols-2">
        <Field label={tx("admin.teamsadmin.ten_team")} error={err}>
          <input className={input} value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Key Accounts" />
        </Field>
        <Field label={tx("admin.teamsadmin.thanh_vien")}>
          <PeoplePicker selected={ids} onChange={setIds} />
        </Field>
      </div>
    </Modal>
  );
}

function DeptModal({ dept, onClose, onDone }: { dept: Department | undefined; onClose: () => void; onDone: () => void }) {
  const tx = useT();
  const [name, setName] = useState(dept?.name ?? "");
  const [head, setHead] = useState<string[]>(dept?.headId ? [dept.headId] : []);
  const [err, setErr] = useState<string | null>(null);
  const save = () =>
    void (
      dept
        ? api(`employee/departments/${dept.id}`, { method: "PATCH", body: { name, headId: head[0] ?? null } })
        : api("employee/departments", { method: "POST", body: { name, headId: head[0] ?? null } })
    )
      .then(onDone)
      .catch(() => setErr(dept ? tx("admin.teamsadmin.chua_luu_duoc") : tx("admin.teamsadmin.chua_tao_duoc_phong")));
  return (
    <Modal
      title={dept ? tx("admin.teamsadmin.sua_phong_ban") : tx("admin.teamsadmin.tao_phong_ban")}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btn} onClick={onClose}>
            {tx("admin.teamsadmin.huy")}
          </button>
          <button type="button" className={btnPrimary} disabled={!name.trim()} onClick={save}>
            {dept ? tx("admin.teamsadmin.luu") : tx("admin.teamsadmin.tao")}
          </button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4">
        <Field label={tx("admin.teamsadmin.ten_phong_ban")} error={err}>
          <input className={input} value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder={tx("admin.teamsadmin.phong_ky_thuat")} />
        </Field>
        <Field label={tx("admin.teamsadmin.truong_phong")} hint={head.length ? undefined : tx("admin.teamsadmin.khong_truong_phong")}>
          <PeoplePicker single selected={head} onChange={setHead} />
        </Field>
      </div>
    </Modal>
  );
}
