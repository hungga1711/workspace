"use client";

import { uploadWorkFile } from "@/lib/work-files";
import { withAttachmentLinks } from "@/components/comments/CommentBody";
import { PersonChip } from "@/components/chat/PersonTrigger";
import { ProjectBadge } from "@/components/ui/ProjectBadge";
import { useToast } from "@/components/ui/Toast";
import { useConfirm } from "@/components/ui/Confirm";
import { TaskDependencies } from "./TaskDependencies";
import { INTL_TAG } from "@/lib/i18n/config";
import { useLocale } from "@/lib/i18n/client";
import type { T } from "@/lib/i18n/core";
import { useT, useFormat } from "@/lib/i18n/client";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { descriptionTemplate, withTemplate } from "@/lib/task-write";
import { useTaskWrite } from "./TaskWrite";
import { api } from "@/lib/client";
import { useLastTaskSeen } from "@/lib/last-task-seen";
import { useAiEnabled } from "@/lib/ai-context";
import { useFeature, useFeatures } from "@/lib/features-context";
import { Avatar, useDirectory } from "@/lib/people";
import { btn, btnPrimary, btnSm, cx, input } from "@/lib/ui";
import { Menu } from "@/components/ui/Menu";
import { ScreenCrumb } from "@/components/shell/ScreenTitle";
import { IconTile, type Tone } from "@/components/ui/Bento";
import {
  ArrowRightIcon,
  ArrowUpIcon,
  CalendarIcon,
  ChatIcon,
  CheckIcon,
  ClockIcon,
  FileIcon,
  FlagIcon,
  FolderIcon,
  GripIcon,
  HashIcon,
  LinkIcon,
  ListIcon,
  LockIcon,
  MeIcon,
  MoreIcon,
  PaperclipIcon,
  PencilIcon,
  PlusIcon,
  RefreshIcon,
  SparkleIcon,
  TrashIcon,
  WorkflowIcon,
} from "@/components/app/icons";
import { TaskAskCard } from "@/components/workflows/TaskAskCard";
import type { TaskDetail } from "@/app/app/work/tasks/[id]/page";
import { kb, type Attachment } from "@/components/chat/attachments";
import { TaskDescription } from "./TaskDescription";
import { DateField } from "@/components/ui/DateField";
import { CustomFieldInputs, LabelsInput, Picker, PriorityMark } from "./TaskFields";
import { STATUS_KEYS, dateTimeMedium } from "@/lib/format";
import { statusTone, TaskStatusPill } from "./TaskStatusPill";
import { PropertyList, PropertyRow, propertyValue } from "@/components/ui/PropertyRow";
import type { FieldDef, Project, Task } from "./types";
import { at, fromZonedInput, parts, zonedInput } from "./calTime";
import { projectHref, taskHref, whiteboardHref } from "@/lib/links";
import { splitDue } from "./taskChatText";
import { useTaskActions } from "./TaskActions";
import { REPEAT } from "./recurrence";

// Hỏi AI loads when someone opens it, never with the task screen.
// Below the fold: comments/history (with the chat composer) and the agent card load in their own chunks so the task
// opens on its title, description and fields first.
const TaskActivity = dynamic(() => import("./TaskActivity").then((m) => m.TaskActivity));
const AgentCard = dynamic(() => import("@/components/workflows/AgentCard").then((m) => m.AgentCard));
// Linked work (the integrations hub): read after the task is on screen, and nothing at all where no tool is connected.
const LinkedWork = dynamic(() => import("@/components/integrations/LinkedWork").then((m) => m.LinkedWork), { ssr: false });
const TaskAskSheet = dynamic(() => import("./TaskAskSheet"), { ssr: false });

const FIELD = (tx: T): Record<string, string> => ({
  title: tx("work.taskdetailview.tieu_de_2"),
  assignee_id: tx("work.taskdetailview.nguoi_lam_2"),
  priority: tx("work.taskdetailview.do_uu_tien"),
  due_at: tx("work.taskdetailview.han_chot_2"),
  status: tx("work.taskdetailview.trang_thai_2"),
  blocked_reason: tx("work.taskdetailview.ly_do_bi_chan"),
});

/** The due date as the date field shows it: in the workspace's zone, like every other time on screen. */
const localInput = (iso: string | null) => (iso ? zonedInput(iso) : "");

/**
 * Task page: the work on the left (title and its actions, description, a subtask table, files, activity), and on the
 * right the status button, a progress card and the fields in "Details" and "Dates" cards; optimistic with version checks.
 */
const section = "mt-7 min-w-0";
const sectionHead = "mb-2 flex min-h-8 items-center gap-2";
const sectionTitle = "text-ink m-0 text-sm font-semibold";
/** The quiet buttons under the title (attach, add subtask, copy link): ghost, muted, a fill on hover only. */
const actionBtn =
  "text-ink-2 hover:bg-hover hover:text-ink inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors [&_svg]:size-3.5";

export function TaskDetailView({
  detail,
  projects,
  fields,
  aiEnabled = false,
  peek = false,
}: {
  detail: TaskDetail;
  projects: Project[];
  fields: FieldDef[];
  aiEnabled?: boolean;
  /** Shown over a list or board: closing returns to it, nothing navigates away. */
  peek?: boolean;
}) {
  const intlTag = INTL_TAG[useLocale()];
  const { ago, status, priority, dayLabel, time } = useFormat();
  const tx = useT();
  const router = useRouter();
  const dir = useDirectory();
  const [task, setTask] = useState(detail.task);
  const [title, setTitle] = useState(task.title);
  const aiOn = useAiEnabled();
  const hasAi = useFeature("ai");
  const [asking, setAsking] = useState(false);
  const [comments, setComments] = useState(detail.comments);
  const toast = useToast();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [subtasks, setSubtasks] = useState(detail.subtasks);
  const [newSub, setNewSub] = useState("");
  const [files, setFiles] = useState(detail.files);
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "err" } | null>(null);
  const [upload, setUpload] = useState<string | null>(null);
  const [blocking, setBlocking] = useState<string | null>(null);
  const project = projects.find((p) => p.id === task.projectId);
  // Synced from Asana, ClickUp, Linear or Jira (Admin › Integrations › Task sync): read-only here, edited at the source.
  const synced = (task.source as { type?: string } | null)?.type === "sync";
  useLastTaskSeen(task.id);
  // The newest version, for an undo that runs after other saves.
  const latest = useRef(task);
  latest.current = task;
  const [prefill, setPrefill] = useState<{ text: string; key: number } | null>(null);

  /** Resolves true when saved; on failure the message says why (conflict, permission). */
  const save = async (patch: Record<string, unknown>): Promise<boolean> => {
    setMsg(null);
    try {
      const t = await api<Task>(`work/tasks/${task.id}`, { method: "PATCH", body: { expectedVersion: task.version, ...patch } });
      setTask(t);
      // Over a board or list: the page behind shows the change at once (status column, assignee).
      if (peek) router.refresh();
      if (patch.status === "done" && task.status !== "done" && !t.recurrence) {
        // Finishing gets a toast with a way back; the status pill turning green is the only visual (no pop-in circle).
        const before = task.status;
        toast({
          message: tx("work.board.doneToast", { title: t.title }),
          undo: async () => setTask(await api<Task>(`work/tasks/${t.id}`, { method: "PATCH", body: { expectedVersion: t.version, status: before } })),
        });
      } else setMsg({ text: patch.status === "done" && t.recurrence ? tx("work.taskdetailview.da_xong_viec_ky") : tx("work.taskdetailview.da_luu"), tone: "ok" });
      return true;
    } catch (e) {
      const s = (e as { status?: number }).status;
      setMsg({
        text: s === 409 ? tx("work.taskdetailview.viec_vua_duoc_cap") : s === 403 ? tx("work.taskdetailview.ban_khong_co_quyen") : tx("work.taskdetailview.luu_that_bai"),
        tone: "err",
      });
      return false;
    }
  };

  /**
   * An AI proposal the person chose to use: the normal update (so history and notifications see an edit by them),
   * then a toast whose undo puts the previous text back.
   */
  const applyWrite = async (patch: { title?: string; description?: string }): Promise<boolean> => {
    const before = {
      ...(patch.title !== undefined ? { title: task.title } : {}),
      ...(patch.description !== undefined ? { description: task.description } : {}),
    };
    const ok = await save(patch);
    if (!ok) return false;
    if (patch.title !== undefined) setTitle(patch.title);
    setMsg(null);
    toast({
      message: tx("work.taskwrite.applied"),
      undo: async () => {
        try {
          const t = await api<Task>(`work/tasks/${task.id}`, { method: "PATCH", body: { expectedVersion: latest.current.version, ...before } });
          setTask(t);
          setTitle(t.title);
          if (peek) router.refresh();
        } catch {
          toast({ message: tx("common.actionFailed") });
        }
      },
    });
    return true;
  };
  const write = useTaskWrite({
    ai: aiEnabled,
    title,
    description: task.description,
    taskRef: task.id,
    projectId: task.projectId,
    labels: task.labels,
    onApply: applyWrite,
    onTemplate: () => setPrefill((p) => ({ text: withTemplate(task.description, descriptionTemplate(tx)), key: (p?.key ?? 0) + 1 })),
  });

  /** Stored with the task, and listed under Attachments at once. */
  const storeFile = async (file: File): Promise<Attachment> => {
    const a = await uploadWorkFile(file, { type: "task", id: task.id });
    setFiles((f) => [...f, { id: a.fileId, name: file.name, contentType: file.type, size: file.size }]);
    return a;
  };
  /** A picture pasted into the description: stored with the task, written as Markdown that points at /app/files/<id>. */
  const uploadImage = (file: File) =>
    storeFile(file)
      .then((a) => `/app/files/${a.fileId}`)
      .catch(() => {
        toast({ message: tx("work.taskdetailview.tai_len_that_bai") });
        return null;
      });
  const uploadFile = async (file: File) => {
    setUpload(tx("work.taskdetailview.dang_tai_len", { p0: file.name }));
    try {
      await storeFile(file);
      setUpload(null);
    } catch (e) {
      const b = (e as { body?: { error?: string; message?: string } }).body;
      setUpload(
        b?.message?.includes("size")
          ? tx("work.taskdetailview.tep_qua_lon")
          : b?.message?.includes("type")
            ? tx("work.taskdetailview.loai_tep_khong_duoc")
            : tx("work.taskdetailview.tai_len_that_bai"),
      );
    }
  };
  const download = async (id: string) => {
    const r = await api<{ url: string }>(`work/files/${id}/download`).catch(() => null);
    if (r) window.location.href = r.url;
    else toast({ message: tx("common.actionFailed") });
  };
  const [linkCopied, setLinkCopied] = useState(false);
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(new URL(taskHref(task), window.location.origin).href);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 1500);
    } catch {
      toast({ message: tx("common.actionFailed") });
    }
  };
  const removeFile = async (id: string) => {
    await api(`work/files/${id}`, { method: "DELETE" });
    setFiles((f) => f.filter((x) => x.id !== id));
  };

  const addComment = async (text: string, attachments: Attachment[] = []) => {
    // Files sent with a comment are stored with the task and linked from the comment: pictures show inline.
    const body = withAttachmentLinks(text, attachments);
    if (!body) return;
    const c = await api<{ id: string; createdAt?: string }>(`work/tasks/${task.id}/comments`, { method: "POST", body: { body } });
    setComments((l) => [...l, { id: c.id, authorId: dir.me, body, createdAt: c.createdAt ?? new Date().toISOString() }]);
  };
  // Edits and deletions show at once and roll back if the server refuses.
  const editComment = async (id: string, body: string) => {
    const before = comments;
    setComments((l) => l.map((c) => (c.id === id ? { ...c, body, editedAt: new Date().toISOString() } : c)));
    try {
      const u = await api<{ body: string; editedAt: string | null }>(`work/tasks/${task.id}/comments/${id}`, { method: "PATCH", body: { body } });
      setComments((l) => l.map((c) => (c.id === id ? { ...c, body: u.body, editedAt: u.editedAt } : c)));
    } catch {
      setComments(before);
      toast({ message: tx("work.taskdetailview.comment_editFailed") });
    }
  };
  const deleteComment = async (id: string) => {
    if (!window.confirm(tx("work.taskdetailview.comment_deleteConfirm"))) return;
    const before = comments;
    setComments((l) => l.filter((c) => c.id !== id));
    try {
      await api(`work/tasks/${task.id}/comments/${id}`, { method: "DELETE" });
    } catch {
      setComments(before);
      toast({ message: tx("work.taskdetailview.comment_deleteFailed") });
    }
  };
  // Typing "a⏎b⏎" fast must give two subtasks: the field clears before the request, and creates run one after another
  // in the order typed (each waits for the previous), so neither the text nor the order can mix.
  const subQueue = useRef<Promise<unknown>>(Promise.resolve());
  const addSubtask = () => {
    const title = newSub.trim();
    if (!title) return;
    setNewSub("");
    subQueue.current = subQueue.current.then(async () => {
      try {
        const t = await api<Task>("work/tasks", { method: "POST", body: { title, parentId: task.id, projectId: task.projectId, assigneeId: task.assigneeId } });
        setSubtasks((s) => [...s, t]);
      } catch {
        toast({ message: tx("work.newtask.subFailed", { title }) });
      }
    });
  };
  /** Saves the subtasks' order (drag or Alt+↑/↓ on a row's handle); shown at once, put back if the server refuses. */
  const reorderSubs = async (next: Task[]) => {
    const before = subtasks;
    setSubtasks(next);
    try {
      await api(`work/tasks/${task.id}/subtask-order`, { method: "PUT", body: { ids: next.map((x) => x.id) } });
    } catch {
      setSubtasks(before);
      toast({ message: tx("common.actionFailed") });
    }
  };
  const moveSub = (from: number, to: number) => {
    if (to < 0 || to >= subtasks.length || from === to) return;
    const next = [...subtasks];
    const [x] = next.splice(from, 1);
    next.splice(to, 0, x!);
    void reorderSubs(next);
  };
  const [dragSub, setDragSub] = useState<number | null>(null);
  /** A subtask that grew into its own piece of work: it leaves this list and keeps everything else. */
  const promoteSub = async (s: Task) => {
    try {
      await api<Task>(`work/tasks/${s.id}/parent`, { method: "POST", body: { parentId: null, expectedVersion: s.version } });
      setSubtasks((l) => l.filter((x) => x.id !== s.id));
      toast({ message: tx("taskActions.madeTaskCode", { code: s.code }) });
    } catch {
      toast({ message: tx("common.actionFailed") });
    }
  };
  const toggleSub = async (s: Task) => {
    const status = s.status === "done" ? "todo" : "done";
    const t = await api<Task>(`work/tasks/${s.id}`, { method: "PATCH", body: { expectedVersion: s.version, status } });
    setSubtasks((l) => l.map((x) => (x.id === s.id ? t : x)));
  };
  /** Subtasks from an AI answer's steps (confirmed in the chat), assigned like the task. */
  const addSubtasks = async (titles: string[], asked = "") => {
    for (const step of titles) {
      // "Gửi báo giá (hạn 16/11/2026)": the deadline goes to the due date, not the title.
      const { title, dueAt } = splitDue(step, new Date(), undefined, asked);
      const t = await api<Task>("work/tasks", { method: "POST", body: { title, dueAt, parentId: task.id, projectId: task.projectId, assigneeId: task.assigneeId } });
      setSubtasks((s) => [...s, t]);
    }
  };
  const remove = async () => {
    const n = subtasks.length;
    const ok = await confirm({
      title: tx("work.taskdetailview.deleteTitle", { p0: task.code }),
      body: n ? tx("work.taskdetailview.deleteWithSubtasks", { count: n }) : tx("work.taskdetailview.xoa_viec_khong_hoan", { p0: task.code }),
      confirmLabel: n ? tx("work.taskdetailview.deleteWithSubtasksBtn", { count: n }) : tx("work.taskdetailview.xoa_viec"),
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`work/tasks/${task.id}`, { method: "DELETE" });
    } catch (e) {
      toast({ message: (e as { status?: number }).status === 403 ? tx("work.taskdetailview.deleteForbidden") : tx("common.actionFailed") });
      return;
    }
    if (peek) {
      router.back();
      router.refresh();
    } else router.push("/app/work");
  };

  const describe = (a: TaskDetail["activity"][number]) => {
    if (a.action === "created") return tx("work.taskdetailview.da_tao_viec_nay");
    if (a.action === "commented") return tx("work.taskdetailview.da_binh_luan");
    if (a.action === "comment_deleted") {
      // `changes` here is { commentId, authorId }: whose comment it was.
      const author = String((a.changes as unknown as { authorId?: string } | null)?.authorId ?? "");
      return author && author !== actorId(a.actor) ? tx("work.taskdetailview.comment_deletedOf", { name: dir.name(author) }) : tx("work.taskdetailview.comment_deletedOwn");
    }
    if (a.action === "checked_in") return tx("work.taskdetailview.cap_nhat_tien_do", { p0: String(a.changes?.progress ?? 0) });
    if (a.action === "recurred") return tx("work.taskdetailview.da_lap_lai");
    if (a.action === "duplicated") return tx("taskActions.histDuplicated", { code: String((a.changes as unknown as { copyCode?: string })?.copyCode ?? "") });
    if (a.action === "made_subtask") return tx("taskActions.histMadeSubtask");
    if (a.action === "made_task") return tx("taskActions.histMadeTask");
    if (a.action === "project_moved") {
      const to = (a.changes as unknown as { to?: string | null })?.to;
      const p = to ? projects.find((x) => x.id === to) : null;
      return to ? tx("taskActions.histMoved", { project: p?.name ?? "" }) : tx("taskActions.histMovedPersonal");
    }
    // A workflow that started by itself says what started it (workflows/starts.ts).
    if (a.action === "agent_run_started" && (a.changes as unknown as { trigger?: string } | null)?.trigger) {
      const c = a.changes as unknown as { trigger: string; workflow?: string };
      const kind = ["task", "schedule", "hook", "linked"].includes(c.trigger) ? (c.trigger as "task" | "schedule" | "hook" | "linked") : "task";
      return tx(`workflows.start.history.${kind}`, { workflow: c.workflow ?? "" });
    }
    // The task's agent asked, and someone answered (or let it decide): workflows/agent-questions.
    if (a.action === "agent_run_asked") return tx("workflows.ask.activityAsked", { count: Number((a.changes as unknown as { count?: number })?.count ?? 1) });
    if (a.action === "agent_run_rework") return tx("workflows.ask.activityRework");
    if (a.action === "agent_run_answered")
      return (a.changes as unknown as { skipped?: boolean })?.skipped ? tx("workflows.ask.activitySkipped") : tx("workflows.ask.activityAnswered");
    // `changes` for these is not the usual { field: { from, to } } shape: the codes sit at the top level.
    const raw = (a.changes ?? {}) as unknown as Record<string, unknown>;
    if (a.action === "dependency_added") return tx("work.taskdetailview.dependencyAdded", { code: String(raw.predecessor ?? "") });
    if (a.action === "dependency_removed") return tx("work.taskdetailview.dependencyRemoved");
    if (a.action === "rescheduled") return tx("work.taskdetailview.rescheduled", { code: String(raw.by ?? "") });
    if (a.action === "comment_edited") return tx("work.taskdetailview.commentEdited");
    // A move between columns that changed the status reads as a status change; one between two columns of the same
    // status ({ column }) names the columns.
    if (a.action === "moved")
      return tx(raw.column ? "work.taskdetailview.chuyen_tu_sang" : "work.taskdetailview.statusMoved", {
        p0: status(String(a.changes.from)) ?? String(a.changes.from),
        p1: status(String(a.changes.to)) ?? String(a.changes.to),
      });
    if (a.action === "updated") {
      const parts = Object.entries(a.changes ?? {}).map(([k, v]) => {
        const val = (x: unknown) =>
          k === "status"
            ? (status(String(x)) ?? String(x))
            : k === "priority"
              ? (priority(String(x)) ?? String(x))
              : k === "assignee_id"
                ? x
                  ? dir.name(String(x))
                  : tx("work.taskdetailview.chua_giao")
                : k === "due_at"
                  ? x
                    ? new Date(String(x)).toLocaleString(intlTag, dateTimeMedium)
                    : tx("work.taskdetailview.khong")
                  : String(x);
        // "đổi trạng thái từ A → B" when the old value is known (the history tab reads as a change log).
        const from = v.from === null || v.from === undefined || v.from === "" ? null : val(v.from);
        return from
          ? tx("work.taskdetailview.doi_tu_thanh", { p0: FIELD(tx)[k] ?? k, p1: String(from), p2: String(val(v.to)) })
          : tx("work.taskdetailview.doi_thanh", { p0: FIELD(tx)[k] ?? k, p1: val(v.to) });
      });
      if (a.changes?.blocked_reason) {
        const b = a.changes.blocked_reason as { to: unknown };
        return b.to ? tx("work.taskdetailview.danh_dau_bi_chan", { p0: String(b.to) }) : tx("work.taskdetailview.da_go_chan");
      }
      return parts.length ? parts.join(", ") : tx("work.taskdetailview.da_cap_nhat");
    }
    // An action this screen does not know yet (a newer server): say something true, never the raw code.
    return tx("work.taskdetailview.da_cap_nhat");
  };
  const actorId = (actor: string) => actor.replace(/^(user|agent|service):/, "");
  const doneCount = subtasks.filter((s) => s.status === "done").length;

  const overdue = !!task.dueAt && new Date(task.dueAt).getTime() < Date.now() && !["done", "cancelled"].includes(task.status);
  // "Today, 17:00" / "Friday, 30/10, 17:00": the due date as people say it, in the workspace's zone.
  const dueText = task.dueAt ? `${dayLabel(task.dueAt)}, ${time(task.dueAt)}` : undefined;

  /** The status as a tinted pill that opens the status menu: in the Details card, and under the title on narrow screens. */
  const statusPicker = (shape: string) => (
    <Picker
      align={shape.includes("rounded-full") ? "left" : "right"}
      label={tx("work.taskdetailview.trang_thai")}
      value={task.status}
      disabled={synced}
      options={STATUS_KEYS.map((k) => ({ value: k, label: status(k) ?? k }))}
      onChange={(v) => v !== task.status && void save({ status: v })}
      heading={tx("work.taskdetailview.statusChange")}
      numbered
      menuClassName="w-56"
      renderOption={(o) => <TaskStatusPill status={o.value} label={o.label} className="h-6 px-2 text-[13px]" />}
      triggerClassName={cx(
        statusTone(task.status),
        shape,
        "inline-flex max-w-full items-center gap-1 pr-1.5 text-[13px] font-medium transition-shadow",
        "hover:ring-1 hover:ring-inset hover:ring-current/25 aria-expanded:ring-1 aria-expanded:ring-inset aria-expanded:ring-current/35",
        // The chevron only on hover, focus or an open menu (always on touch): the pill reads as a value first.
        "[&>svg:last-child]:opacity-0 hover:[&>svg:last-child]:opacity-70 focus-visible:[&>svg:last-child]:opacity-70 aria-expanded:[&>svg:last-child]:opacity-70 [@media(hover:none)]:[&>svg:last-child]:opacity-70",
      )}
    />
  );

  const actions = useTaskActions({
    task,
    subtaskCount: subtasks.length,
    projects,
    watching: !!detail.watching,
    onChange: (t) => setTask(t),
  });
  const moreItems = [
    ...actions.items,
    ...(task.blockedReason || ["done", "cancelled"].includes(task.status)
      ? []
      : [{ label: tx("work.taskdetailview.danh_dau_dang_bi"), icon: <LockIcon />, onSelect: () => setBlocking("") }]),
    // Offered only when the server would allow it (creator or `task.delete`): no dead end that fails on click.
    ...(detail.canDelete ? [{ label: tx("work.taskdetailview.xoa_viec"), danger: true, icon: <TrashIcon />, onSelect: () => void remove() }] : []),
  ];

  const head = (
    <div className="min-w-0">
      {/* The top bar shows "Việc / <code>" (one title per screen); the dialog's header already names code and project. */}
      {!peek ? <ScreenCrumb label={task.code} /> : null}
      {!peek ? (
        <p className="text-ink-2 m-0 mb-2.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px]">
          {project ? (
            <>
              <Link href={projectHref(project)} className="text-ink-2 hover:text-ink inline-flex min-w-0 items-center gap-1.5 no-underline">
                <ProjectBadge id={project.id} name={project.name} size="xs" />
                <span className="truncate">{project.name}</span>
              </Link>
              <span aria-hidden="true">›</span>
            </>
          ) : null}
          <span className="font-mono text-[12px]">{task.code}</span>
          {/* Copy-link, spelled out as in the popup's header; it copies the popup address (over the task list). */}
          <button
            type="button"
            onClick={() => void copyLink()}
            aria-live="polite"
            className={cx(
              "hover:bg-hover hover:text-ink -my-1 ml-auto inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[13px] font-medium transition-colors [&_svg]:size-3.5",
              linkCopied ? "text-ok" : "text-ink-soft",
            )}
          >
            {linkCopied ? <CheckIcon /> : <LinkIcon />}
            {linkCopied ? tx("peek.copied") : tx("peek.copy")}
          </button>
        </p>
      ) : null}
      {/* The page's heading for screen readers and outlines: the visible title is an editable field. */}
      <h1 className="sr-only">{task.title}</h1>
      <div className="flex items-start gap-2">
        <textarea
          aria-label={tx("work.taskdetailview.tieu_de")}
          value={title}
          readOnly={synced}
          rows={1}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => title.trim() && title !== task.title && void save({ title })}
          className="hover:bg-ink/5 focus:bg-ink/5 font-display -mx-2 min-w-0 flex-1 resize-none text-balance rounded-lg bg-transparent px-2 py-0.5 text-[28px]/[1.2] font-semibold tracking-[-0.035em] outline-none transition-colors [field-sizing:content] max-sm:text-2xl/8"
        />
        {/* Hỏi AI by the title, not a tab beside the comments: it is the person's own chat, not the task's record. */}
        {aiOn ? (
          <button
            type="button"
            onClick={() => setAsking(true)}
            aria-expanded={asking}
            className="bg-violet-wash text-violet-text hover:bg-violet-wash/70 mt-1 inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-semibold transition-colors [&_svg]:size-4"
          >
            <SparkleIcon />
            <span className="max-sm:sr-only">{tx("taskChat.tabAsk")}</span>
          </button>
        ) : null}
        {moreItems.length ? (
          <Menu
            label={tx("work.taskdetailview.thao_tac_khac")}
            items={moreItems}
            trigger={
              <span className="text-ink-2 hover:bg-hover mt-0.5 grid size-9 place-items-center rounded-md">
                <MoreIcon />
              </span>
            }
          />
        ) : null}
      </div>
      <div className="-ml-2 mt-2 flex flex-wrap gap-0.5">
        <label className={actionBtn} title={tx("work.taskdetailview.tai_thang_len_kho")}>
          <PaperclipIcon />
          {tx("work.taskdetailview.attach")}
          <input type="file" className="sr-only" onChange={(e) => e.target.files?.[0] && void uploadFile(e.target.files[0])} />
        </label>
        <button type="button" className={actionBtn} onClick={() => document.getElementById("new-sub")?.focus()}>
          <PlusIcon />
          {tx("work.taskdetailview.them_viec_con")}
        </button>
      </div>
      {/* Below the wide layout the side column comes last: the facts people look for first sit under the title. */}
      <div className="@4xl:hidden mt-3 flex flex-wrap items-center gap-1.5 text-[13px]">
        {/* The status on a phone's first screen (the Details card stacks far below): the same pill and menu. */}
        {statusPicker("h-7 rounded-full px-2.5")}
        {task.assigneeId ? <PersonChip userId={task.assigneeId} dense className="bg-surface shadow-card h-7 rounded-full pl-1 pr-2.5" /> : null}
        {dueText ? (
          <span
            className={cx(
              "inline-flex h-7 items-center gap-1.5 rounded-full px-2.5",
              overdue ? "bg-block-wash text-block ring-block/15 ring-1 ring-inset" : "bg-surface shadow-card",
            )}
          >
            <CalendarIcon className="size-3.5" />
            {dueText}
          </span>
        ) : null}
      </div>
      {task.source ? <SourceLine source={task.source as unknown as Record<string, string>} /> : null}
      {/* What the task's agent is asking right now, answered in place (page and peek). */}
      {detail.agentAsks?.length ? <TaskAskCard asks={detail.agentAsks} /> : null}
      {msg ? (
        <p className={cx("mt-2 text-sm", msg.tone === "ok" ? "text-ok" : "text-block")} role="status">
          {msg.text}
        </p>
      ) : null}
      {task.blockedReason ? (
        <div className="bg-block-wash ring-block/15 mt-3 flex flex-wrap items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm ring-1 ring-inset" role="note">
          <LockIcon className="text-block size-4 shrink-0" />
          <span className="min-w-0 flex-1">
            <b className="text-block">{tx("work.taskdetailview.dang_bi_chan")}</b> {task.blockedReason}
          </span>
          <button type="button" className={cx(btn, btnSm)} onClick={() => void save({ blockedReason: null })}>
            {tx("work.taskdetailview.go_chan")}
          </button>
        </div>
      ) : null}
      {blocking !== null ? (
        <form
          className="bg-surface shadow-card mt-3 flex flex-wrap items-center gap-2 rounded-xl p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (blocking.trim()) {
              void save({ blockedReason: blocking });
              setBlocking(null);
            }
          }}
        >
          <label htmlFor="block-reason" className="text-sm font-medium">
            {tx("work.taskdetailview.bi_chan_vi")}
          </label>
          <input
            id="block-reason"
            autoFocus
            className={cx(input, "min-w-0 flex-1")}
            value={blocking}
            maxLength={500}
            onChange={(e) => setBlocking(e.target.value)}
            placeholder={tx("work.taskdetailview.cho_api_key_tu")}
          />
          <button type="submit" className={cx(btnPrimary, btnSm)} disabled={!blocking.trim()}>
            {tx("work.taskdetailview.luu")}
          </button>
          <button type="button" className={cx(btn, btnSm)} onClick={() => setBlocking(null)}>
            {tx("work.taskdetailview.huy")}
          </button>
          <p className="text-ink-2 w-full text-xs">{tx("work.taskdetailview.nguoi_giao_viec_se")}</p>
        </form>
      ) : null}
    </div>
  );

  const body = (
    <div className="min-w-0">
      <section className="mt-6 min-w-0" aria-labelledby="desc-h">
        <div className="mb-1 flex min-h-8 items-center gap-2">
          <h2 id="desc-h" className={cx(sectionTitle, "min-w-0 flex-1")}>
            {tx("work.taskdetailview.mo_ta")}
          </h2>
          {write.menu}
        </div>
        {write.panel}
        <TaskDescription bare value={task.description} onSave={(description) => save({ description })} onUploadImage={uploadImage} prefill={prefill} />
      </section>

      <section className={section} aria-labelledby="sub-h">
        <header className={sectionHead}>
          <h2 id="sub-h" className={sectionTitle}>
            {tx("work.taskdetailview.viec_con_title")}
          </h2>
          {subtasks.length ? (
            <>
              <span className="text-ink-2 text-xs tabular-nums">{tx("work.taskdetailview.n_xong", { p0: doneCount, p1: subtasks.length })}</span>
              <span className="bg-progress-track ml-auto h-1.5 w-24 overflow-hidden rounded-full" aria-hidden="true">
                <span className="bg-progress block h-full rounded-full" style={{ width: `${Math.round((doneCount / subtasks.length) * 100)}%` }} />
              </span>
            </>
          ) : null}
        </header>
        {/* A table in a frame: code, title, priority, who and status on one line, so a long list scans like a board. */}
        <ul className="bg-surface shadow-card m-0 list-none overflow-hidden rounded-xl p-0">
          {subtasks.map((s, i) => (
            <li
              key={s.id}
              draggable={subtasks.length > 1}
              onDragStart={(e) => {
                setDragSub(i);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(e) => {
                if (dragSub === null) return;
                e.preventDefault();
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragSub !== null) moveSub(dragSub, i);
                setDragSub(null);
              }}
              onDragEnd={() => setDragSub(null)}
              className={cx("border-divider hover:bg-hover/60 group/sub flex min-h-11 items-center gap-3 border-b px-3.5 transition-colors", dragSub === i && "opacity-50")}
            >
              {subtasks.length > 1 ? (
                <button
                  type="button"
                  aria-label={tx("taskActions.reorder", { title: s.title })}
                  title={tx("taskActions.reorderHint")}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                      e.preventDefault();
                      moveSub(i, e.key === "ArrowUp" ? i - 1 : i + 1);
                      // Keep the handle focused on its row after the move.
                      const id = s.id;
                      requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-sub-grip="${id}"]`)?.focus());
                    }
                  }}
                  data-sub-grip={s.id}
                  className="text-ink-2/60 hover:text-ink -ml-2 grid size-5 shrink-0 cursor-grab place-items-center rounded opacity-0 transition-opacity focus-visible:opacity-100 group-hover/sub:opacity-100 max-sm:hidden [@media(hover:none)]:opacity-100"
                >
                  <GripIcon className="size-3.5" />
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => void toggleSub(s)}
                aria-label={s.status === "done" ? tx("work.taskdetailview.mo_lai") : tx("work.taskdetailview.hoan_thanh")}
                // A square check like the shared checkbox: no circles before names anywhere in a task.
                className={cx(
                  "grid size-4 shrink-0 place-items-center rounded-[4px] border transition-colors",
                  s.status === "done" ? "border-ok bg-ok text-white" : "border-ink-2/60 hover:border-ink",
                )}
              >
                {s.status === "done" ? <CheckIcon className="size-3" /> : null}
              </button>
              <span className={cx("text-ink-2 shrink-0 font-mono text-xs max-sm:hidden", s.status === "done" && "line-through")}>{s.code}</span>
              <Link href={taskHref(s)} className={cx("min-w-0 flex-1 truncate text-sm no-underline hover:underline", s.status === "done" ? "text-ink-2" : "text-ink")}>
                {s.title}
              </Link>
              {s.dueAt && s.status !== "done" ? <span className="text-ink-2 shrink-0 text-xs tabular-nums">{dayLabel(s.dueAt)}</span> : null}
              <PriorityMark priority={s.priority} className="max-sm:hidden" />
              {s.assigneeId ? <Avatar id={s.assigneeId} size="xs" /> : null}
              <TaskStatusPill status={s.status} label={status(s.status) ?? s.status} className="max-sm:hidden" />
              <button
                type="button"
                onClick={() => void promoteSub(s)}
                aria-label={tx("taskActions.makeTaskOf", { title: s.title })}
                title={tx("taskActions.makeTask")}
                className="text-ink-2 hover:bg-hover hover:text-ink -mr-1.5 grid size-7 shrink-0 place-items-center rounded-md opacity-0 transition-opacity focus-visible:opacity-100 group-hover/sub:opacity-100 [@media(hover:none)]:opacity-100"
              >
                <ArrowUpIcon className="size-3.5" />
              </button>
            </li>
          ))}
          <li className="text-ink-2 focus-within:bg-hover/60 hover:bg-hover/60 flex min-h-11 items-center gap-3 px-3.5 transition-colors">
            <PlusIcon className="size-[18px] shrink-0" />
            <input
              id="new-sub"
              value={newSub}
              onChange={(e) => setNewSub(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  addSubtask();
                }
              }}
              placeholder={tx("work.taskdetailview.them_viec_con_roi")}
              aria-label={tx("work.taskdetailview.them_viec_con")}
              className="placeholder:text-ink-2 text-ink h-9 min-w-0 flex-1 bg-transparent text-sm outline-none"
            />
          </li>
        </ul>
      </section>

      {/* Attachments take room only once there are some (the row under the title holds the "attach" action). */}
      {files.length || upload ? (
        <section className={section} aria-labelledby="files-h">
          <header className={sectionHead}>
            <h2 id="files-h" className={sectionTitle}>
              {tx("work.taskdetailview.tep_dinh_kem")}
            </h2>
            {files.length ? <span className="text-ink-2 text-xs tabular-nums">{files.length}</span> : null}
          </header>
          {upload ? (
            <p className="text-ink-2 m-0 mb-2 text-sm" role="status">
              {upload}
            </p>
          ) : null}
          {files.length ? (
            <ul className="@xl:grid-cols-2 m-0 grid list-none gap-2 p-0">
              {files.map((f) => (
                <li
                  key={f.id}
                  className="bg-surface shadow-card hover:shadow-lift ease-out-soft group flex items-center gap-3 rounded-xl px-3 py-2.5 transition-shadow duration-300"
                >
                  <IconTile tone="sky">
                    <FileIcon />
                  </IconTile>
                  <button type="button" onClick={() => void download(f.id)} className="min-w-0 flex-1 text-left">
                    <span className="text-ink block truncate text-sm font-medium hover:underline">{f.name}</span>
                    <span className="text-ink-2 block text-xs tabular-nums">{kb(f.size)}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void removeFile(f.id)}
                    aria-label={tx("work.taskdetailview.xoa", { p0: f.name })}
                    className="text-ink-2 hover:bg-hover hover:text-block grid size-8 place-items-center rounded-md opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
                  >
                    <TrashIcon className="size-4" />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      {/* Pull and merge requests, issues and designs that belong to this task, as live cards. */}
      <LinkedWork taskId={task.id} className={section} headClass={sectionHead} titleClass={sectionTitle} />

      {/* Comments and history: one card with its tabs in the header, the thread oldest first and the
          composer docked under it (TaskActivity). */}
      <TaskActivity
        taskId={task.id}
        code={task.code}
        comments={comments}
        activity={detail.activity}
        describe={describe}
        onAdd={addComment}
        onEdit={editComment}
        onDelete={deleteComment}
        onUpload={storeFile}
        ai={aiOn}
        onAiComment={(id, body) => {
          // Posted by the server on the asker's behalf, under the AI's name (like a workflow's result).
          setComments((l) => (l.some((c) => c.id === id) ? l : [...l, { id, authorId: dir.me, body, createdAt: new Date().toISOString(), agent: "AI" }]));
          // The AI may have changed this very task on the way (status, priority, due date): show it as it is now.
          void api<{ task: typeof task }>(`work/tasks/${task.id}`)
            .then((r) => setTask(r.task))
            .catch(() => undefined);
        }}
      />
      {actions.dialogs}
      {confirmDialog}
      {asking ? (
        <TaskAskSheet
          taskId={task.id}
          code={task.code}
          onClose={() => setAsking(false)}
          onAddSubtasks={addSubtasks}
          onAppendDescription={(text) => save({ description: task.description.trim() ? `${task.description.trimEnd()}\n\n${text}` : text })}
          onComment={(text) => addComment(text)}
        />
      ) : null}
    </div>
  );

  const panelBody = (
    // One column that never grows past the side panel (a long workflow name would push every card out).
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3">
      {/* Status is the first property, a compact tinted pill in the same row grid as the rest: not a
          lone bar floating above the cards. The menu keeps its heading, pills, ✓ and 1–5 keys. */}
      <Card id="props-h" tone="sky" icon={<ListIcon />} title={tx("work.taskdetailview.sec_details")}>
        <PropertyList label={tx("work.taskdetailview.thuoc_tinh")}>
          {/* Narrower than two columns the status already sits in the chips under the title: shown once. */}
          <PropertyRow icon={<CheckIcon />} label={tx("work.taskdetailview.trang_thai")} className="@max-4xl:hidden">
            {statusPicker("h-7 w-full justify-between rounded-md pl-2")}
          </PropertyRow>
          <PropertyRow icon={<MeIcon />} label={tx("work.taskdetailview.nguoi_lam")}>
            <Picker
              align="right"
              label={tx("work.taskdetailview.nguoi_lam")}
              value={task.assigneeId ?? ""}
              disabled={synced}
              options={[
                // Unassigned: a muted person glyph in the avatar's slot, not a dashed ring.
                {
                  value: "",
                  label: tx("work.taskfields.chua_giao"),
                  icon: (
                    <span className="text-ink-2/70 grid size-5 place-items-center">
                      <MeIcon />
                    </span>
                  ),
                },
                ...dir.people
                  .filter((x) => x.status !== "disabled" || x.userId === task.assigneeId)
                  .map((x) => ({
                    value: x.userId,
                    label: x.displayName + (x.userId === dir.me ? tx("work.taskfields.toi") : ""),
                    icon: <Avatar id={x.userId} size="xs" />,
                  })),
              ]}
              onChange={(v) => void save({ assigneeId: v || null })}
            />
          </PropertyRow>
          <PropertyRow icon={<PencilIcon />} label={tx("work.taskdetailview.nguoi_tao")}>
            <PersonChip userId={task.ownerId} className="text-ink min-h-8 text-sm" />
          </PropertyRow>
          <PropertyRow icon={<FlagIcon />} label={tx("work.taskdetailview.uu_tien")}>
            <Picker
              align="right"
              label={tx("work.taskdetailview.uu_tien")}
              value={task.priority}
              disabled={synced}
              options={["urgent", "high", "medium", "low"].map((k) => ({ value: k, label: priority(k) ?? k, icon: <PriorityMark priority={k} /> }))}
              onChange={(v) => void save({ priority: v })}
            />
          </PropertyRow>
          <PropertyRow icon={<HashIcon />} label={tx("work.taskdetailview.nhan")}>
            <LabelsInput ghost value={task.labels} onChange={(labels) => void save({ labels })} />
          </PropertyRow>
          <PropertyRow icon={<FolderIcon />} label={tx("work.taskdetailview.du_an")}>
            <span className="block min-w-0 text-sm">
              {project ? (
                <Link href={projectHref(project)} className={cx(propertyValue, "gap-2 no-underline")}>
                  <ProjectBadge id={project.id} name={project.name} size="sm" />
                  <span className="truncate">{project.name}</span>
                </Link>
              ) : (
                <span className="text-ink-2">{tx("work.taskdetailview.viec_ca_nhan")}</span>
              )}
            </span>
          </PropertyRow>
        </PropertyList>
        {fields.length ? (
          <div className="mt-1 grid gap-0.5">
            <CustomFieldInputs ghost defs={fields} value={task.customFields} onChange={(customFields) => void save({ customFields })} />
          </div>
        ) : null}
      </Card>
      {/* The agent this task is handed to (AI › Workflow): pick, run, follow its steps. */}
      {hasAi ? (
        <Card id="agent-h" tone="violet" icon={<WorkflowIcon />} title={tx("workflows.agent.title")}>
          <div className="py-1.5">
            <AgentCard taskId={task.id} workflowId={task.workflowId ?? null} assigneeId={task.assigneeId} canEdit onFinished={() => router.refresh()} />
          </div>
        </Card>
      ) : null}
      <Card id="dates-h" tone="tangerine" icon={<CalendarIcon />} title={tx("work.taskdetailview.sec_dates")}>
        <PropertyList label={tx("work.taskdetailview.sec_dates")}>
          <PropertyRow icon={<CalendarIcon />} label={tx("work.taskdetailview.han_chot")}>
            <DateField
              variant="property"
              withTime
              id="f-due"
              label={tx("work.taskdetailview.han_chot")}
              placeholder="—"
              value={localInput(task.dueAt)}
              display={dueText}
              className={overdue ? "[&>button]:text-block [&>button]:font-medium" : undefined}
              onChange={(v) => void save({ dueAt: v ? fromZonedInput(v).toISOString() : null })}
            />
          </PropertyRow>
          {/* Repeat: finishing the task creates the next one on the next date (it needs a due date to count from). */}
          <PropertyRow icon={<RefreshIcon />} label={tx("work.newtaskdrawer.lap_lai")}>
            <Picker
              align="right"
              label={tx("work.newtaskdrawer.lap_lai")}
              value={task.recurrence ?? ""}
              disabled={synced || (!task.dueAt && !task.recurrence)}
              title={!task.dueAt && !task.recurrence ? tx("taskActions.repeatNeedsDue") : undefined}
              options={[{ value: "", label: tx("work.newtaskdrawer.khong_lap_lai") }, ...Object.entries(REPEAT(tx)).map(([k, v]) => ({ value: k, label: v }))]}
              onChange={(v) => void save({ recurrence: v || null })}
            />
          </PropertyRow>
          <PropertyRow icon={<ArrowRightIcon />} label={tx("work.deps.start")}>
            <DateField
              variant="property"
              id="f-start"
              label={tx("work.deps.start")}
              placeholder="—"
              value={task.startAt ? parts(task.startAt).key : ""}
              display={task.startAt ? dayLabel(task.startAt) : undefined}
              onChange={(v) => void save({ startAt: v ? at(v, 9 * 60).toISOString() : null })}
            />
          </PropertyRow>
          <PropertyRow icon={<ClockIcon />} label={tx("work.taskdetailview.created")}>
            <span className="text-ink-soft text-sm">{`${dayLabel(task.createdAt)}, ${time(task.createdAt)}`}</span>
          </PropertyRow>
        </PropertyList>
      </Card>
      {task.projectId && !task.parentId ? (
        <Card id="deps-h" tone="rose" icon={<LinkIcon />} title={tx("work.deps.title")}>
          <TaskDependencies taskId={task.id} projectId={task.projectId} initial={detail.dependencies ?? { waitingOn: [], blocking: [] }} />
        </Card>
      ) : null}
      <p className="text-ink-2 m-0 px-1 text-xs" suppressHydrationWarning>
        {tx("work.taskdetailview.tao_cap_nhat", { p0: ago(task.createdAt), p1: ago(task.updatedAt) })} · {tx("work.taskdetailview.phien_ban", { p0: task.version })}
      </p>
    </div>
  );

  if (peek)
    // Over a list or board: the body and the side column scroll on their own.
    // Narrower than the two columns: one scroll, the side column last (the key facts are chips under the title).
    return (
      <div className="@4xl:grid-cols-[minmax(0,1fr)_360px] @4xl:overflow-hidden grid h-full overflow-y-auto overscroll-contain">
        <div className="@4xl:overflow-y-auto @4xl:overscroll-contain min-w-0 px-5 py-6 md:px-9 md:py-7">
          {head}
          {body}
        </div>
        {/* The side column on the canvas grey: its white cards stand off it, the work on the left stays white. */}
        <aside className="border-hairline bg-ground @4xl:overflow-y-auto @4xl:border-l @max-4xl:border-t px-5 py-6 md:px-6" aria-label={tx("work.taskdetailview.thuoc_tinh")}>
          {panelBody}
        </aside>
      </div>
    );
  return (
    // Full page: the app column (left-aligned like every page header), the side column sticky at the right.
    <div className="@container">
      <div className="@4xl:grid-cols-[minmax(0,1fr)_340px] grid max-w-[1180px] gap-x-10 gap-y-6">
        <div className="min-w-0">
          {head}
          {body}
        </div>
        <aside className="@4xl:sticky @4xl:top-20 self-start" aria-label={tx("work.taskdetailview.thuoc_tinh")}>
          {panelBody}
        </aside>
      </div>
    </div>
  );
}

const SOURCE_TOOL: Record<string, string> = { asana: "Asana", clickup: "ClickUp", linear: "Linear", jira: "Jira", trello: "Trello", notion: "Notion", csv: "CSV" };

/** Where the task came from: a chat thread, a meeting, a document, the previous recurrence, or another tool. */
function SourceLine({ source }: { source: Record<string, string> }) {
  const tx = useT();
  const has = useFeatures();
  if (source.type === "sync" || source.type === "import") {
    const tool = SOURCE_TOOL[source.system ?? ""] ?? source.system ?? "";
    return (
      <p className="text-ink-2 mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm">
        <RefreshIcon className="size-4" />
        {source.type === "sync" ? tx("taskSync.task.synced", { tool }) : tx("taskSync.task.imported", { tool })}
        {source.key ? <span className="font-mono text-xs">{source.key}</span> : null}
        {source.type === "sync" && source.url ? (
          <a href={source.url} target="_blank" rel="noreferrer noopener" className="font-medium">
            {tx("taskSync.task.open", { tool })} ↗
          </a>
        ) : null}
      </p>
    );
  }
  const [to, label] =
    source.type === "meeting"
      ? [`/app/work/meetings/${source.eventId}`, tx("work.taskdetailview.mot_cuoc_hop")]
      : source.type === "document"
        ? [`/app/work/docs/${source.documentId}`, tx("work.taskdetailview.mot_tai_lieu")]
        : source.type === "whiteboard"
          ? [
              whiteboardHref({ id: source.whiteboardId ?? "", code: source.code }),
              source.code ? tx("work.taskdetailview.bang_trang_ma", { p0: source.code }) : tx("work.taskdetailview.mot_bang_trang"),
            ]
          : source.type === "recurring"
            ? [`/app/work/tasks/${source.fromTaskId}`, tx("work.taskdetailview.ky_truoc", { p0: source.fromCode })]
            : source.type === "duplicate"
              ? [`/app/work/tasks/${source.fromTaskId}`, tx("taskActions.copyOf", { code: source.fromCode ?? "" })]
              : source.type === "template"
                ? [null, tx("taskActions.fromTemplate", { name: source.templateName ?? "" })]
                : [`/app/chat/${source.channelId}?m=${source.messageId}`, tx("work.taskdetailview.mot_thao_luan_trong")];
  // Where it came from is still said, without a link, when that feature is not part of this installation.
  const gone = (source.type === "meeting" && !has("calendar")) || (source.type === "document" && !has("docs")) || (source.type === "whiteboard" && !has("whiteboards"));
  const href = gone ? null : to;
  return (
    <p className="text-ink-2 mt-1 flex items-center gap-1.5 text-sm">
      <ChatIcon className="size-4" />
      {tx("work.taskdetailview.tao_tu")} {href ? <Link href={href}>{label}</Link> : <span className="text-ink">{label}</span>}
    </p>
  );
}

/** A titled frame in the side column ("Details", "Dates"): the header carries a muted icon, the rows sit below. */
function Card({ id, icon, tone, title, children }: { id: string; icon: React.ReactNode; tone: Tone; title: string; children: React.ReactNode }) {
  // Home's tile header: a tinted icon tile leads, no rule under it; a white card on the canvas by its ring.
  return (
    <section aria-labelledby={id} className="bg-surface shadow-card min-w-0 rounded-xl px-4 pb-3 pt-4">
      <h2 id={id} className="text-ink m-0 flex min-h-8 items-center gap-3 text-sm font-semibold tracking-[-0.01em]">
        <IconTile tone={tone}>{icon}</IconTile>
        {title}
      </h2>
      <div className="pt-2">{children}</div>
    </section>
  );
}
