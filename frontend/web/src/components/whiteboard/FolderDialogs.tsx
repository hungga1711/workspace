"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/client";
import { useT } from "@/lib/i18n/client";
import { btn, btnDanger, btnPrimary, cx, iconBtn, input } from "@/lib/ui";
import { Avatar, useDirectory } from "@/lib/people";
import { Picker } from "@/components/ui/Picker";
import { Segmented } from "@/components/ui/Segmented";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { CheckIcon, CloseIcon, FolderIcon, UsersIcon, WhiteboardIcon } from "@/components/app/icons";
import { flattenFolders, folderSubtree } from "./folders";
import type { Role, WbFolder, WbGrant } from "./types";

const ROLES: Role[] = ["view", "edit", "manage"];
const grantKey = (g: Pick<WbGrant, "subjectType" | "subjectId">) => `${g.subjectType}:${g.subjectId}`;

/**
 * Who a new folder is for, chosen while creating it instead of in Chia sẻ afterwards: people and departments with a
 * role each. The creator always manages, so they are never offered.
 */
function MemberPicker({ grants, onChange }: { grants: WbGrant[]; onChange: (g: WbGrant[]) => void }) {
  const t = useT();
  const dir = useDirectory();
  const [departments, setDepartments] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    // Departments are optional: without the list, people can still be added.
    void api<{ departments: { id: string; name: string }[] }>("employee/departments")
      .then((r) => setDepartments(r.departments))
      .catch(() => undefined);
  }, []);
  const label = (g: WbGrant) =>
    g.subjectType === "department" ? (departments.find((d) => d.id === g.subjectId)?.name ?? t("whiteboard.access.department")) : dir.name(g.subjectId);
  const taken = useMemo(() => new Set(grants.map(grantKey)), [grants]);
  const options = useMemo(() => {
    const opts = [];
    for (const d of departments) if (!taken.has(`department:${d.id}`)) opts.push({ value: `department:${d.id}`, label: d.name, group: t("whiteboard.access.departments") });
    for (const p of dir.people)
      if (p.status !== "disabled" && p.userId !== dir.me && !taken.has(`user:${p.userId}`))
        opts.push({ value: `user:${p.userId}`, label: p.displayName, keywords: p.email ?? "", group: t("whiteboard.access.people") });
    return opts;
  }, [taken, departments, dir.people, dir.me, t]);
  return (
    <div className="grid min-w-0 gap-2">
      <Picker
        variant="field"
        label={t("whiteboard.folder.addMembers")}
        placeholder={t("whiteboard.folder.addMembers")}
        value=""
        onChange={(v) => {
          const i = v.indexOf(":");
          onChange([...grants, { subjectType: v.slice(0, i) as WbGrant["subjectType"], subjectId: v.slice(i + 1), role: "edit" }]);
        }}
        options={options}
      />
      {grants.length ? (
        <ul className="divide-divider-soft m-0 grid max-h-56 list-none divide-y overflow-auto p-0">
          {grants.map((g) => (
            <li key={grantKey(g)} className="flex min-h-11 items-center gap-2.5 py-1.5">
              {g.subjectType === "user" ? (
                <Avatar id={g.subjectId} size="sm" />
              ) : (
                <span className="bg-selected text-ink-soft grid size-6 shrink-0 place-items-center rounded-full">
                  <UsersIcon className="size-3.5" />
                </span>
              )}
              <span className="min-w-0 flex-1 truncate text-sm">{label(g)}</span>
              <Picker
                variant="button"
                align="right"
                label={t("whiteboard.access.roleFor", { name: label(g) })}
                value={g.role}
                onChange={(v) => onChange(grants.map((x) => (grantKey(x) === grantKey(g) ? { ...x, role: v as Role } : x)))}
                options={ROLES.map((r) => ({ value: r, label: t(`whiteboard.access.role.${r}`) }))}
              />
              <button
                type="button"
                className={iconBtn}
                aria-label={t("whiteboard.access.remove", { name: label(g) })}
                onClick={() => onChange(grants.filter((x) => grantKey(x) !== grantKey(g)))}
              >
                <CloseIcon />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** New folder (in `parentId`) or rename `folder`. */
export function FolderNameDialog({ folder, parentId, onClose, onDone }: { folder?: WbFolder; parentId?: string | null; onClose: () => void; onDone: (f: WbFolder) => void }) {
  const t = useT();
  const [name, setName] = useState(folder?.name ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A top-level folder is for the whole company unless narrowed here; a sub-folder follows its parent plus anyone added.
  const [who, setWho] = useState<"company" | "chosen">("company");
  const [grants, setGrants] = useState<WbGrant[]>([]);
  const save = async () => {
    const next = name.trim();
    if (!next) return;
    if (folder && next === folder.name) return onClose();
    setBusy(true);
    try {
      const f = folder
        ? await api<WbFolder>(`work/whiteboards/folders/${folder.id}`, { method: "PATCH", body: { name: next } })
        : await api<WbFolder>("work/whiteboards/folders", {
            method: "POST",
            body: { name: next, parentId: parentId ?? null, ...((parentId ? grants.length : who === "chosen") ? { grants } : {}) },
          });
      onDone(f);
      onClose();
    } catch {
      setError(t("whiteboard.folder.failed"));
      setBusy(false);
    }
  };
  return (
    <Modal
      title={folder ? t("whiteboard.folder.rename") : parentId ? t("whiteboard.folder.newSub") : t("whiteboard.folder.new")}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btn} onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" form="wb-folder" className={btnPrimary} disabled={busy || !name.trim()}>
            {folder ? t("common.save") : t("whiteboard.folder.create")}
          </button>
        </>
      }
    >
      <form
        id="wb-folder"
        className="grid min-w-0 gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label className="grid gap-1.5 text-sm font-medium">
          {t("whiteboard.folder.nameLabel")}
          <input className={input} value={name} maxLength={120} autoFocus onChange={(e) => setName(e.target.value)} />
        </label>
        {folder ? null : parentId ? (
          <div className="grid min-w-0 gap-1.5">
            <span className="text-sm font-medium">{t("whiteboard.folder.members")}</span>
            <MemberPicker grants={grants} onChange={setGrants} />
            <span className="text-ink-2 text-xs">{t("whiteboard.folder.inheritHint")}</span>
          </div>
        ) : (
          <div className="grid min-w-0 gap-2">
            <span className="text-sm font-medium">{t("whiteboard.folder.members")}</span>
            <Segmented
              label={t("whiteboard.folder.members")}
              value={who}
              onChange={setWho}
              options={[
                { value: "company", label: t("whiteboard.folder.whoCompany") },
                { value: "chosen", label: t("whiteboard.folder.whoChosen") },
              ]}
            />
            {who === "chosen" ? <MemberPicker grants={grants} onChange={setGrants} /> : null}
            <span className="text-ink-2 text-xs">{who === "company" ? t("whiteboard.folder.topHint") : t("whiteboard.folder.chosenHint")}</span>
          </div>
        )}
        {error ? (
          <p role="alert" className="text-block m-0 text-sm">
            {error}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}

/** Deleting a folder never deletes boards: what is inside moves up, with the access it had. */
export function DeleteFolderDialog({ folder, parentName, onClose, onDone }: { folder: WbFolder; parentName: string | null; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={t("whiteboard.folder.deleteTitle", { name: folder.name })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btn} onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className={btnDanger}
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void api(`work/whiteboards/folders/${folder.id}`, { method: "DELETE" })
                .then(() => {
                  onDone();
                  onClose();
                })
                .catch(() => {
                  toast({ message: t("whiteboard.folder.failed") });
                  setBusy(false);
                });
            }}
          >
            {t("whiteboard.folder.delete")}
          </button>
        </>
      }
    >
      <p className="m-0 text-sm">{t("whiteboard.folder.deleteBody", { parent: parentName ?? t("whiteboard.folder.all") })}</p>
    </Modal>
  );
}

/**
 * "Chuyển đến…": a board or a folder to another folder (or the top level). Only folders the reader can add to are
 * offered; a folder cannot go into itself or its own sub-folders.
 */
export function MoveDialog({
  item,
  folders,
  canTop,
  onClose,
  onDone,
}: {
  item: { type: "board" | "folder"; id: string; name: string; folderId: string | null };
  folders: WbFolder[];
  canTop: boolean;
  onClose: () => void;
  onDone: (folderId: string | null) => void;
}) {
  const t = useT();
  const toast = useToast();
  const [dest, setDest] = useState<string | null>(item.folderId);
  const [busy, setBusy] = useState(false);
  const blocked = item.type === "folder" ? folderSubtree(folders, item.id) : new Set<string>();
  const options = flattenFolders(folders).filter(({ folder }) => !blocked.has(folder.id));
  const move = async () => {
    setBusy(true);
    try {
      if (item.type === "board") await api(`work/whiteboards/${item.id}`, { method: "PATCH", body: { folderId: dest } });
      else await api(`work/whiteboards/folders/${item.id}`, { method: "PATCH", body: { parentId: dest } });
      const name = dest ? (folders.find((f) => f.id === dest)?.name ?? "") : t("whiteboard.folder.all");
      toast({ message: t("whiteboard.folder.moved", { name }) });
      onDone(dest);
      onClose();
    } catch {
      toast({ message: t("whiteboard.folder.moveFailed") });
      setBusy(false);
    }
  };
  const opt = (id: string | null, label: string, depth: number, enabled: boolean, icon: React.ReactNode) => (
    <li key={id ?? "root"} role="option" aria-selected={dest === id} aria-disabled={!enabled}>
      <button
        type="button"
        disabled={!enabled}
        onClick={() => setDest(id)}
        className={cx(
          "flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm disabled:cursor-not-allowed disabled:opacity-50 max-md:min-h-11",
          dest === id ? "bg-selected text-ink" : "hover:bg-hover text-ink-soft",
        )}
        // Indentation is the folder's depth: a dynamic value.
        style={{ paddingLeft: `${8 + depth * 16}px` }}
      >
        {icon}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {dest === id ? <CheckIcon className="size-4 shrink-0" /> : null}
      </button>
    </li>
  );
  return (
    <Modal
      title={t("whiteboard.folder.moveTitle", { name: item.name })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btn} onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className={btnPrimary} disabled={busy || dest === item.folderId} onClick={() => void move()}>
            {t("whiteboard.folder.move")}
          </button>
        </>
      }
    >
      <ul role="listbox" aria-label={t("whiteboard.folder.tree")} className="border-hairline m-0 grid max-h-80 list-none gap-0.5 overflow-auto rounded-md border p-1">
        {opt(null, t("whiteboard.folder.all"), 0, canTop, <WhiteboardIcon className="text-ink-2 size-4 shrink-0" />)}
        {options.map(({ folder, depth }) => opt(folder.id, folder.name, depth + 1, folder.canEdit, <FolderIcon className="text-ink-2 size-4 shrink-0" />))}
      </ul>
      <p className="text-ink-2 m-0 mt-2 text-xs">{t("whiteboard.folder.moveHint")}</p>
    </Modal>
  );
}
