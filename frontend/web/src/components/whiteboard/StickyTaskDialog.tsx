"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { useT } from "@/lib/i18n/client";
import { useDirectory } from "@/lib/people";
import { btn, btnPrimary, cx, list } from "@/lib/ui";
import { Modal } from "@/components/ui/Modal";
import { Picker } from "@/components/ui/Picker";
import { DateField } from "@/components/ui/DateField";
import type { SelectedSticky } from "./controller";
import { stickyTask } from "./scene";
import type { WbLink } from "./types";

/**
 * "Tạo việc" from the selected stickies: one task per sticky (first line → title, the whole note → description),
 * with one project, assignee and due date for all of them. Empty stickies and those already linked are skipped. The
 * work module creates them under the normal task rules and records which sticky each came from.
 */
export function StickyTaskDialog({
  boardId,
  projectId: boardProject,
  stickies,
  onClose,
  onCreated,
}: {
  boardId: string;
  projectId: string | null;
  stickies: SelectedSticky[];
  onClose: () => void;
  onCreated: (links: WbLink[]) => void;
}) {
  const t = useT();
  const dir = useDirectory();
  const items = stickies.flatMap((s) => {
    const task = s.linked ? null : stickyTask(s.text);
    return task ? [{ elementId: s.id, ...task }] : [];
  });
  const skipped = stickies.length - items.length;
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [projectId, setProjectId] = useState(boardProject ?? "");
  const [assigneeId, setAssigneeId] = useState("");
  const [due, setDue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void api<{ projects: { id: string; name: string }[] }>("work/projects")
      .then((r) => setProjects(r.projects))
      .catch(() => undefined);
  }, []);
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ links: WbLink[] }>(`work/whiteboards/${boardId}/tasks`, {
        method: "POST",
        body: {
          items,
          ...(projectId ? { projectId } : {}),
          ...(assigneeId ? { assigneeId } : {}),
          // A date alone means the end of that working day, as elsewhere in Việc.
          ...(due ? { dueAt: new Date(`${due}T17:00:00`).toISOString() } : {}),
        },
      });
      onCreated(r.links);
      onClose();
    } catch {
      setError(t("whiteboard.tasksFailed"));
      setBusy(false);
    }
  };
  return (
    <Modal
      title={t("whiteboard.tasksTitle")}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btn} onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className={btnPrimary} disabled={busy || !items.length} onClick={() => void create()}>
            {t("whiteboard.tasksCreate", { count: items.length })}
          </button>
        </>
      }
    >
      <div className="grid gap-4">
        {items.length ? (
          <>
            <p className="text-ink-2 m-0 text-sm">{t("whiteboard.tasksIntro", { count: items.length })}</p>
            <ul className={cx(list, "max-h-48 overflow-auto")}>
              {items.map((i) => (
                <li key={i.elementId} className="truncate px-3.5 py-2 text-sm" title={i.title}>
                  {i.title}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="m-0 text-sm">{t("whiteboard.tasksNone")}</p>
        )}
        {skipped > 0 && items.length ? <p className="text-ink-2 m-0 text-xs">{t("whiteboard.tasksSkipped", { count: skipped })}</p> : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5 sm:col-span-2">
            <span className="text-sm font-medium">{t("whiteboard.projectLabel")}</span>
            <Picker
              variant="field"
              label={t("whiteboard.projectLabel")}
              value={projectId}
              onChange={setProjectId}
              options={[{ value: "", label: t("whiteboard.tasksProjectNone") }, ...projects.map((p) => ({ value: p.id, label: p.name }))]}
            />
          </div>
          <div className="grid gap-1.5">
            <span className="text-sm font-medium">{t("whiteboard.tasksAssignee")}</span>
            <Picker
              variant="field"
              label={t("whiteboard.tasksAssignee")}
              value={assigneeId}
              onChange={setAssigneeId}
              options={[{ value: "", label: t("whiteboard.tasksNoAssignee") }, ...dir.people.map((p) => ({ value: p.userId, label: p.displayName, keywords: p.email }))]}
            />
          </div>
          <div className="grid gap-1.5">
            <span className="text-sm font-medium">{t("whiteboard.tasksDue")}</span>
            <DateField label={t("whiteboard.tasksDue")} value={due} onChange={setDue} />
          </div>
        </div>
        {error ? (
          <p role="alert" className="text-block m-0 text-sm">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
