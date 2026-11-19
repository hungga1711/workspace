"use client";

import { PersonTrigger } from "@/components/chat/PersonTrigger";
import { useT, useFormat } from "@/lib/i18n/client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/client";
import { useDirectory } from "@/lib/people";
import { btn, cx } from "@/lib/ui";
import { Menu } from "@/components/ui/Menu";
import dynamic from "next/dynamic";
import { MoreIcon } from "@/components/app/icons";
import { Avatar } from "@/lib/people";
import { ProjectBadge } from "@/components/ui/ProjectBadge";
import { Chip } from "@/components/ui/Bento";
import { ScreenCrumb } from "@/components/shell/ScreenTitle";

// Dialogs load when opened, not with the project page.
const EditProject = dynamic(() => import("./ProjectEditDialog").then((m) => m.EditProject), { ssr: false });
const ImportTasksDialog = dynamic(() => import("./ImportTasksDialog").then((m) => m.ImportTasksDialog), { ssr: false });

export interface ProjectDetail {
  id: string;
  code: string;
  name: string;
  description: string;
  ownerId: string;
  teamId: string | null;
  status: string;
  dueAt: string | null;
  version: number;
  history: { actor: string; action: string; changes: Record<string, unknown>; at: string }[];
}

/** Project header: due date, owner, description; edit, archive/restore; who changed what. */
export function ProjectHeader({
  p,
  openTasks,
  overdueTasks,
  canManageTeams = false,
}: {
  p: ProjectDetail;
  openTasks: number;
  overdueTasks: number;
  /** May make a new team for the project in Edit project (member.manage), as in "Dự án mới". */
  canManageTeams?: boolean;
}) {
  const { ago, dayInline } = useFormat();
  const tx = useT();
  const router = useRouter();
  const dir = useDirectory();
  const [editing, setEditing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const archive = async () => {
    if (p.status === "active" && !window.confirm(tx("work.projectheader.luu_tru_du_an", { p0: p.name }))) return;
    try {
      await api(`work/projects/${p.id}`, { method: "PATCH", body: { expectedVersion: p.version, status: p.status === "active" ? "archived" : "active" } });
      router.refresh();
    } catch (e) {
      setMsg((e as { status?: number }).status === 403 ? tx("work.projectheader.chi_nguoi_phu_trach") : tx("work.projectheader.chua_thuc_hien_duoc"));
    }
  };
  const lastDue = p.history.find((h) => h.changes && "due_at" in h.changes);
  return (
    <>
      {/* The top bar carries "Việc / <project>" (one title per screen); the page keeps the project's name as its h1. */}
      <ScreenCrumb label={p.name} />
      {/* Home's head: "Dự án · P-002" as the eyebrow, the project's tile and a tight display title, its
          numbers as chips, the actions on the right. */}
      <header className="mb-5 flex flex-wrap items-start gap-x-4 gap-y-3">
        <div className="flex min-w-[min(100%,18rem)] flex-1 items-start gap-4">
          <ProjectBadge id={p.id} name={p.name} size="lg" className="mt-1" />
          <div className="min-w-0 flex-1">
            <p className="text-ink-2 m-0 mb-1 inline-flex items-center gap-2 text-xs">
              <Link href="/app/work/tasks?view=projects" className="text-ink-2 hover:text-ink font-mono tabular-nums no-underline">
                {p.code}
              </Link>
              {p.status === "archived" ? <span>{tx("work.projectheader.da_luu_tru_paren")}</span> : null}
            </p>
            <h1 className="font-display text-ink m-0 text-balance text-[28px]/[1.15] font-semibold tracking-[-0.035em] max-sm:text-2xl/[1.2]">{p.name}</h1>
            <div className="text-ink-2 mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px]">
              <PersonTrigger userId={p.ownerId} className="inline-flex items-center gap-1.5 rounded-md hover:underline">
                <Avatar id={p.ownerId} size="xs" />
                {tx("work.projectheader.phu_trach", { p0: dir.name(p.ownerId) })}
              </PersonTrigger>
              <span>{p.dueAt ? tx("work.projectheader.han", { p0: dayInline(p.dueAt) }) : tx("work.projectheader.chua_co_han")}</span>
              <span className="flex flex-wrap gap-1.5">
                <Chip n={openTasks} label={tx("work.projectheader.openShort")} title={tx("work.projectheader.viec_dang_mo", { p0: openTasks })} />
                {overdueTasks ? (
                  <Chip n={overdueTasks} label={tx("work.projectheader.lateShort")} tone="alert" title={tx("work.projectheader.qua_han", { p0: overdueTasks })} />
                ) : null}
              </span>
            </div>
            {p.description ? <p className="text-ink m-0 mt-2.5 max-w-[70ch] text-sm">{p.description}</p> : null}
            {lastDue ? (
              <p className="text-ink-2 m-0 mt-1 text-xs">
                {tx("work.projectheader.han_doi_boi", {
                  p0: dir.name(lastDue.actor.replace(/^\w+:/, "")),
                  p1: ago(lastDue.at),
                  p2: lastDue.changes.reason ? ` · ${String(lastDue.changes.reason)}` : "",
                })}
              </p>
            ) : null}
          </div>
        </div>
        <button type="button" className={btn} onClick={() => setEditing(true)}>
          {tx("work.projectheader.sua_du_an")}
        </button>
        <Menu
          label={tx("work.projectheader.more")}
          items={[
            { label: tx("work.import.button"), onSelect: () => setImporting(true) },
            { label: tx("work.projectheader.xuat_csv"), onSelect: () => (window.location.href = `/app/work/projects/${p.id}/export`) },
            { label: p.status === "active" ? tx("work.projectheader.luu_tru") : tx("work.projectheader.khoi_phuc"), onSelect: () => void archive() },
          ]}
          trigger={
            <span className={cx(btn, "w-9 px-0")}>
              <MoreIcon className="size-4" />
            </span>
          }
        />
      </header>
      {msg ? (
        <p className="bg-block-wash text-block mb-4 rounded-xl px-3 py-2 text-sm" role="alert">
          {msg}
        </p>
      ) : null}
      {importing ? <ImportTasksDialog projectId={p.id} onClose={() => setImporting(false)} /> : null}
      {editing ? (
        <EditProject
          p={p}
          canManageTeams={canManageTeams}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            router.refresh();
          }}
        />
      ) : null}
    </>
  );
}
