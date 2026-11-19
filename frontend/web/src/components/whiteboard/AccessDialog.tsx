"use client";

import { PersonChip } from "@/components/chat/PersonTrigger";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/client";
import { useT } from "@/lib/i18n/client";
import { Avatar, useDirectory } from "@/lib/people";
import { btn, btnPrimary, chip, cx, iconBtn } from "@/lib/ui";
import { Modal } from "@/components/ui/Modal";
import { Picker } from "@/components/ui/Picker";
import { Checkbox } from "@/components/ui/Checkbox";
import { useToast } from "@/components/ui/Toast";
import { CloseIcon, GlobeIcon, LinkIcon, UsersIcon } from "@/components/app/icons";
import type { AccessSummary, Role, WbAccess, WbGrant } from "./types";

const ROLES: Role[] = ["view", "edit", "manage"];
const key = (g: Pick<WbGrant, "subjectType" | "subjectId">) => `${g.subjectType}:${g.subjectId}`;

/**
 * Chia sẻ a board or a folder: who views, edits or manages it. Grants go to everyone in the company, a department or
 * a person; a board or sub-folder also follows its folder's access unless that is switched off. The creator (and the
 * creators of the folders above) always manage; admins manage anything shared. Viewers see the summary only.
 */
export function AccessDialog({
  target,
  parentName,
  link,
  project,
  onClose,
  onSaved,
}: {
  target: { type: "board" | "folder"; id: string; name: string };
  /** The folder it sits in (null: the top level, nothing to inherit). */
  parentName: string | null;
  /** A copyable link (boards). */
  link?: string;
  /** A board's project, changeable here by its managers. */
  project?: { projectId: string | null; projects: { id: string; name: string }[] };
  onClose: () => void;
  onSaved: (s: { visibility: AccessSummary; projectId?: string | null; projectName?: string | null }) => void;
}) {
  const t = useT();
  const toast = useToast();
  const dir = useDirectory();
  const base = target.type === "board" ? `work/whiteboards/${target.id}/access` : `work/whiteboards/folders/${target.id}/access`;
  const [data, setData] = useState<WbAccess | null>(null);
  const [failed, setFailed] = useState(false);
  const [grants, setGrants] = useState<WbGrant[]>([]);
  const [inherit, setInherit] = useState(true);
  const [projectId, setProjectId] = useState(project?.projectId ?? "");
  const [departments, setDepartments] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setFailed(false);
    void api<WbAccess>(base)
      .then((a) => {
        setData(a);
        setGrants(a.grants);
        setInherit(a.inherit);
      })
      .catch(() => setFailed(true));
  }, [base, attempt]);
  useEffect(() => {
    // Departments are optional: without them (no access to the list), people and everyone still work.
    void api<{ departments: { id: string; name: string }[] }>("employee/departments")
      .then((r) => setDepartments(r.departments))
      .catch(() => undefined);
  }, []);

  const deptName = (id: string) => departments.find((d) => d.id === id)?.name ?? t("whiteboard.access.department");
  const subjectLabel = (g: Pick<WbGrant, "subjectType" | "subjectId">) =>
    g.subjectType === "everyone" ? t("whiteboard.access.everyone") : g.subjectType === "department" ? deptName(g.subjectId) : dir.name(g.subjectId);
  const subjectIcon = (g: Pick<WbGrant, "subjectType" | "subjectId">) =>
    g.subjectType === "user" ? (
      <Avatar id={g.subjectId} size="sm" />
    ) : (
      <span className="bg-selected text-ink-soft grid size-6 shrink-0 place-items-center rounded-full">
        {g.subjectType === "everyone" ? <GlobeIcon className="size-3.5" /> : <UsersIcon className="size-3.5" />}
      </span>
    );
  const roleLabel = (r: Role) => t(`whiteboard.access.role.${r}`);

  const taken = useMemo(() => new Set(grants.map(key)), [grants]);
  const addOptions = useMemo(() => {
    const opts = [];
    if (!taken.has("everyone:")) opts.push({ value: "everyone:", label: t("whiteboard.access.everyone") });
    for (const d of departments) if (!taken.has(`department:${d.id}`)) opts.push({ value: `department:${d.id}`, label: d.name, group: t("whiteboard.access.departments") });
    for (const p of dir.people)
      if (p.status !== "disabled" && p.userId !== data?.ownerId && !taken.has(`user:${p.userId}`))
        opts.push({ value: `user:${p.userId}`, label: p.displayName, keywords: p.email ?? "", group: t("whiteboard.access.people") });
    return opts;
  }, [taken, departments, dir.people, data?.ownerId, t]);

  const canManage = !!data?.canManage;
  const save = async () => {
    setBusy(true);
    try {
      const r = await api<WbAccess>(base, { method: "PUT", body: { inherit: parentName ? inherit : true, grants } });
      let extra: { projectId?: string | null; projectName?: string | null } = {};
      if (project && (projectId || null) !== project.projectId) {
        await api(`work/whiteboards/${target.id}`, { method: "PATCH", body: { projectId: projectId || null } });
        extra = { projectId: projectId || null, projectName: project.projects.find((p) => p.id === projectId)?.name ?? null };
      }
      toast({ message: t("whiteboard.access.saved") });
      onSaved({ visibility: r.visibility, ...extra });
      onClose();
    } catch {
      toast({ message: t("whiteboard.access.failed") });
      setBusy(false);
    }
  };
  const copy = () =>
    link
      ? void navigator.clipboard
          .writeText(new URL(link, window.location.origin).toString())
          .then(() => toast({ message: t("whiteboard.copied") }))
          .catch(() => undefined)
      : undefined;

  const row = "flex min-h-11 items-center gap-2.5 py-1.5";
  return (
    <Modal
      title={t("whiteboard.access.title", { name: target.name })}
      onClose={onClose}
      footer={
        <>
          {link ? (
            <button type="button" className={cx(btn, "max-sm:px-2.5")} onClick={copy}>
              <LinkIcon />
              {t("whiteboard.copyLink")}
            </button>
          ) : null}
          <span className="flex-1" />
          <button type="button" className={btn} onClick={onClose}>
            {canManage ? t("common.cancel") : t("common.close")}
          </button>
          {canManage ? (
            <button type="button" className={btnPrimary} disabled={busy} onClick={() => void save()}>
              {t("common.save")}
            </button>
          ) : null}
        </>
      }
    >
      {failed ? (
        <div className="grid gap-2">
          <p className="text-ink-2 m-0 text-sm">{t("whiteboard.access.loadFailed")}</p>
          <button type="button" className={cx(btn, "justify-self-start")} onClick={() => setAttempt((n) => n + 1)}>
            {t("common.retry")}
          </button>
        </div>
      ) : !data ? (
        <p className="text-ink-2 m-0 animate-pulse text-sm" role="status">
          {t("whiteboard.loading")}
        </p>
      ) : (
        <div className="grid min-w-0 gap-4">
          {canManage ? (
            <Picker
              variant="field"
              label={t("whiteboard.access.add")}
              placeholder={t("whiteboard.access.add")}
              value=""
              onChange={(v) => {
                const i = v.indexOf(":");
                const subjectType = v.slice(0, i) as WbGrant["subjectType"];
                setGrants((g) => [...g, { subjectType, subjectId: v.slice(i + 1), role: subjectType === "everyone" ? "view" : "edit" }]);
              }}
              options={addOptions}
            />
          ) : null}

          <section aria-label={t("whiteboard.access.who")} className="grid min-w-0">
            <h3 className="text-ink-2 m-0 pb-1 text-xs font-medium">{t("whiteboard.access.who")}</h3>
            <ul className="divide-divider-soft m-0 grid list-none divide-y p-0">
              <li className={row}>
                <span className="flex min-w-0 flex-1">
                  <PersonChip userId={data.ownerId} size="sm" className="gap-2.5 text-sm" />
                </span>
                <span className={chip}>{t("whiteboard.access.creator")}</span>
              </li>
              {data.managers.map((id) => (
                <li key={`m:${id}`} className={row}>
                  <span className="flex min-w-0 flex-1">
                    <PersonChip userId={id} size="sm" className="gap-2.5 text-sm" />
                  </span>
                  <span className="text-ink-2 shrink-0 text-xs">{t("whiteboard.access.folderCreator")}</span>
                </li>
              ))}
              {grants.map((g) => (
                <li key={key(g)} className={row}>
                  {subjectIcon(g)}
                  <span className="min-w-0 flex-1 truncate text-sm">{subjectLabel(g)}</span>
                  {canManage ? (
                    <>
                      <Picker
                        variant="button"
                        align="right"
                        label={t("whiteboard.access.roleFor", { name: subjectLabel(g) })}
                        value={g.role}
                        onChange={(v) => setGrants((list) => list.map((x) => (key(x) === key(g) ? { ...x, role: v as Role } : x)))}
                        options={ROLES.map((r) => ({ value: r, label: roleLabel(r) }))}
                      />
                      <button
                        type="button"
                        className={iconBtn}
                        aria-label={t("whiteboard.access.remove", { name: subjectLabel(g) })}
                        onClick={() => setGrants((list) => list.filter((x) => key(x) !== key(g)))}
                      >
                        <CloseIcon />
                      </button>
                    </>
                  ) : (
                    <span className="text-ink-2 shrink-0 text-xs">{roleLabel(g.role)}</span>
                  )}
                </li>
              ))}
            </ul>
            {!grants.length && !(parentName && inherit) ? <p className="text-ink-2 m-0 pt-1 text-xs">{t("whiteboard.access.onlyCreator")}</p> : null}
          </section>

          {parentName ? (
            <section className="border-divider grid min-w-0 gap-2 border-t pt-3">
              <Checkbox
                checked={inherit}
                disabled={!canManage}
                onChange={(e) => setInherit(e.target.checked)}
                label={<span className="text-sm">{t("whiteboard.access.inherit", { name: parentName })}</span>}
                hint={inherit ? undefined : t("whiteboard.access.inheritOff")}
              />
              {inherit && data.inherited.length ? (
                <ul className="m-0 grid list-none gap-0.5 p-0 pl-6">
                  {data.inherited.map((g) => (
                    <li key={`${g.from}:${key(g)}`} className="text-ink-2 flex min-w-0 items-center gap-2 text-xs max-md:text-[13px]">
                      <span className="text-ink-soft min-w-0 truncate">{subjectLabel(g)}</span>
                      <span className="shrink-0">· {roleLabel(g.role)}</span>
                      <span className="min-w-0 truncate">· {t("whiteboard.access.from", { name: g.fromName })}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}

          {project && canManage ? (
            <div className="border-divider grid gap-1.5 border-t pt-3">
              <span className="text-sm font-medium">{t("whiteboard.projectLabel")}</span>
              <Picker
                variant="field"
                label={t("whiteboard.projectLabel")}
                value={projectId}
                onChange={setProjectId}
                options={[{ value: "", label: t("whiteboard.noProject") }, ...project.projects.map((p) => ({ value: p.id, label: p.name }))]}
              />
              <span className="text-ink-2 text-xs">{t("whiteboard.access.projectHint")}</span>
            </div>
          ) : null}

          <p className="text-ink-2 m-0 text-xs">{canManage ? t("whiteboard.access.adminNote") : t("whiteboard.access.readOnly")}</p>
        </div>
      )}
    </Modal>
  );
}
