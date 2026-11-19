"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useT } from "@/lib/i18n/client";
import { api } from "@/lib/client";
import { useToast } from "@/components/ui/Toast";
import type { MenuItem } from "@/components/ui/Menu";
import { ArrowUpIcon, BellIcon, BellOffIcon, BookmarkIcon, CopyIcon, FolderIcon, ListIcon } from "@/components/app/icons";
import { taskHref } from "@/lib/links";
import type { Project, Task } from "./types";

const MoveDialog = dynamic(() => import("./TaskActionDialogs").then((m) => m.MoveDialog), { ssr: false });
const DuplicateDialog = dynamic(() => import("./TaskActionDialogs").then((m) => m.DuplicateDialog), { ssr: false });
const TemplateDialog = dynamic(() => import("./TaskActionDialogs").then((m) => m.TemplateDialog), { ssr: false });
const SubtaskDialog = dynamic(() => import("./TaskActionDialogs").then((m) => m.SubtaskDialog), { ssr: false });

type Dialog = "move" | "duplicate" | "template" | "subtask" | null;

/**
 * The everyday actions in a task's "…" menu beyond its fields: follow it, move it to another project, copy it, save it
 * as a template, and turn it into a subtask (or back). Returns the menu items and the small dialogs they open.
 */
export function useTaskActions({
  task,
  subtaskCount,
  projects,
  watching: initialWatching,
  onChange,
}: {
  task: Task;
  subtaskCount: number;
  projects: Project[];
  watching: boolean;
  /** The task after a change made here (moved, re-parented): the page shows it at once. */
  onChange: (t: Task) => void;
}) {
  const tx = useT();
  const router = useRouter();
  const toast = useToast();
  const [watching, setWatching] = useState(initialWatching);
  const [open, setOpen] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  const fail = (e: unknown) => {
    const s = (e as { status?: number }).status;
    toast({ message: s === 403 ? tx("taskActions.forbidden") : s === 409 ? tx("taskActions.conflict") : tx("common.actionFailed") });
  };
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      setOpen(null);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const toggleWatch = async () => {
    const next = !watching;
    setWatching(next);
    try {
      await api(`work/tasks/${task.id}/watch`, { method: next ? "PUT" : "DELETE" });
      toast({ message: next ? tx("taskActions.watchOn") : tx("taskActions.watchOff") });
    } catch (e) {
      setWatching(!next);
      fail(e);
    }
  };

  const items: MenuItem[] = [
    { label: watching ? tx("taskActions.unwatch") : tx("taskActions.watch"), icon: watching ? <BellOffIcon /> : <BellIcon />, onSelect: () => void toggleWatch() },
    ...(task.parentId ? [] : [{ label: tx("taskActions.move"), icon: <FolderIcon />, onSelect: () => setOpen("move") }]),
    { label: tx("taskActions.duplicate"), icon: <CopyIcon />, onSelect: () => setOpen("duplicate") },
    { label: tx("taskActions.saveTemplate"), icon: <BookmarkIcon />, onSelect: () => setOpen("template") },
    ...(task.parentId
      ? [
          {
            label: tx("taskActions.makeTask"),
            icon: <ArrowUpIcon />,
            onSelect: () =>
              void run(async () => {
                const t = await api<Task>(`work/tasks/${task.id}/parent`, { method: "POST", body: { parentId: null, expectedVersion: task.version } });
                onChange(t);
                toast({ message: tx("taskActions.madeTask") });
                router.refresh();
              }),
          },
        ]
      : subtaskCount === 0 && task.projectId
        ? [{ label: tx("taskActions.makeSubtask"), icon: <ListIcon />, onSelect: () => setOpen("subtask") }]
        : []),
  ];

  const dialogs =
    open === "move" ? (
      <MoveDialog
        task={task}
        projects={projects}
        busy={busy}
        onClose={() => setOpen(null)}
        onMove={(projectId) =>
          run(async () => {
            const t = await api<Task>(`work/tasks/${task.id}/project`, { method: "POST", body: { projectId, expectedVersion: task.version } });
            onChange(t);
            const p = projects.find((x) => x.id === projectId);
            toast({ message: p ? tx("taskActions.moved", { project: p.name }) : tx("taskActions.movedPersonal") });
            router.refresh();
          })
        }
      />
    ) : open === "duplicate" ? (
      <DuplicateDialog
        task={task}
        hasSubtasks={subtaskCount > 0}
        busy={busy}
        onClose={() => setOpen(null)}
        onDuplicate={(title, withSubtasks) =>
          run(async () => {
            const t = await api<Task>(`work/tasks/${task.id}/duplicate`, { method: "POST", body: { title, withSubtasks } });
            toast({ message: tx("taskActions.duplicated", { code: t.code }) });
            router.push(taskHref(t));
          })
        }
      />
    ) : open === "template" ? (
      <TemplateDialog
        task={task}
        project={projects.find((p) => p.id === task.projectId) ?? null}
        busy={busy}
        onClose={() => setOpen(null)}
        onSave={(name, forProject) =>
          run(async () => {
            await api("work/task-templates", { method: "POST", body: { name, taskId: task.id, projectId: forProject ? task.projectId : null } });
            toast({ message: tx("taskActions.templateSaved", { name }) });
          })
        }
      />
    ) : open === "subtask" ? (
      <SubtaskDialog
        task={task}
        busy={busy}
        onClose={() => setOpen(null)}
        onPick={(parentId) =>
          run(async () => {
            const t = await api<Task>(`work/tasks/${task.id}/parent`, { method: "POST", body: { parentId, expectedVersion: task.version } });
            onChange(t);
            toast({ message: tx("taskActions.madeSubtask") });
            router.refresh();
          })
        }
      />
    ) : null;

  return { items, dialogs };
}
