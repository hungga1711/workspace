"use client";

import { TaskStatusPill } from "./TaskStatusPill";
import { useAiEnabled } from "@/lib/ai-context";
import dynamic from "next/dynamic";
import type { T } from "@/lib/i18n/core";
import { useT, useFormat } from "@/lib/i18n/client";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { STATUS_KEYS } from "@/lib/format";
import { api } from "@/lib/client";
import { Avatar, useDirectory } from "@/lib/people";
import { btn, btnGhost, btnPrimary, btnSm, cx, smallText } from "@/lib/ui";
import { Picker } from "@/components/ui/Picker";
import { StatusMark } from "@/components/ui/StatusMark";
import { Checkbox } from "@/components/ui/Checkbox";
import { DateField } from "@/components/ui/DateField";
import { PopoverRow, SearchToggle, ToolbarPopover } from "./ToolbarPopover";
import { BlockedTag, Label } from "@/components/ui/bits";
import { SlimEmpty } from "./progressUi";
import { PriorityMark } from "./TaskFields";
import { CheckIcon, FilterIcon, FolderIcon, HashIcon, MeIcon, PlusIcon, SettingsIcon, TrashIcon } from "@/components/app/icons";
import type { FieldDef, Project, Task } from "./types";
import { at } from "./calTime";
import { useToast } from "@/components/ui/Toast";
import { taskHref } from "@/lib/links";

// The new-task form loads when it opens (date grid, pickers): not part of the board's first paint.
const NewTaskDrawer = dynamic(() => import("./NewTaskDrawer").then((m) => m.NewTaskDrawer), { ssr: false });

const GROUPS = (tx: T) =>
  [
    { key: "overdue", label: tx("work.tasklist.qua_han") },
    { key: "today", label: tx("work.tasklist.hom_nay") },
    { key: "week", label: tx("work.tasklist.n7_ngay_toi") },
    { key: "later", label: tx("work.tasklist.sau_do") },
    { key: "none", label: tx("work.tasklist.chua_co_han") },
    { key: "done", label: tx("work.tasklist.da_xong") },
  ] as const;

/** Each group's dot, in Home's tones: late red, today blue, this week orange, the rest quiet. */
const GROUP_DOT: Record<ReturnType<typeof GROUPS>[number]["key"], string> = {
  overdue: "bg-block",
  today: "bg-sky",
  week: "bg-tangerine",
  later: "bg-violet",
  none: "bg-edge",
  done: "bg-ok-fill",
};

function groupOf(t: Task): ReturnType<typeof GROUPS>[number]["key"] {
  if (t.status === "done" || t.status === "cancelled") return "done";
  if (!t.dueAt) return "none";
  const d = new Date(t.dueAt).getTime();
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  if (d < Date.now()) return "overdue";
  if (d <= end.getTime()) return "today";
  if (d <= end.getTime() + 7 * 86400e3) return "week";
  return "later";
}

const VIEW_KEY = "wx.taskList.view";
const GROUP_BYS = ["due", "status", "assignee", "project", "priority", "label", "none"] as const;
const SORT_BYS = ["due", "priority", "updated", "created", "title"] as const;
type GroupBy = (typeof GROUP_BYS)[number];
type SortBy = (typeof SORT_BYS)[number];
interface ListView {
  groupBy: GroupBy;
  sortBy: SortBy;
}
const DEFAULT_VIEW: ListView = { groupBy: "due", sortBy: "due" };
/** What a task added from a group's "+" starts with. */
interface GroupDefaults {
  status?: string;
  assigneeId?: string | null;
  projectId?: string | null;
}
const PRIORITY_ORDER = ["urgent", "high", "medium", "low"];
const STATUS_DOT: Record<string, string> = { todo: "bg-edge", in_progress: "bg-sky", review: "bg-tangerine", done: "bg-ok-fill", cancelled: "bg-edge" };

function sortRows(rows: Task[], by: SortBy): Task[] {
  const time = (x: string | null | undefined, empty: number) => (x ? new Date(x).getTime() : empty);
  const cmp: Record<SortBy, (a: Task, b: Task) => number> = {
    // Undated last; the same due date by priority.
    due: (a, b) => time(a.dueAt, Infinity) - time(b.dueAt, Infinity) || PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority),
    priority: (a, b) => PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority) || time(a.dueAt, Infinity) - time(b.dueAt, Infinity),
    updated: (a, b) => time(b.updatedAt, 0) - time(a.updatedAt, 0),
    created: (a, b) => time(b.createdAt, 0) - time(a.createdAt, 0),
    title: (a, b) => a.title.localeCompare(b.title),
  };
  return [...rows].sort((a, b) => cmp[by](a, b) || a.code.localeCompare(b.code));
}

interface Group {
  key: string;
  label: string;
  dot?: string;
  rows: Task[];
  defaults?: GroupDefaults;
}

/** The list's sections for the chosen grouping, each sorted; empty groups are dropped by the caller. */
function groupRows(
  rows: Task[],
  view: ListView,
  f: { tx: T; statusLabel: (k: string) => string | undefined; prioLabel: (k: string) => string | undefined; name: (id: string) => string; projectName: Record<string, string> },
): Group[] {
  const sorted = sortRows(rows, view.sortBy);
  const by = <K extends string>(keyOf: (t: Task) => K, order: K[], meta: (k: K) => Omit<Group, "key" | "rows">): Group[] => {
    const seen = [...new Set([...order, ...sorted.map(keyOf)])];
    return seen.map((k) => ({ key: k, ...meta(k), rows: sorted.filter((t) => keyOf(t) === k) }));
  };
  switch (view.groupBy) {
    case "status":
      return by(
        (t) => t.status,
        [...STATUS_KEYS],
        (k) => ({ label: f.statusLabel(k) ?? k, dot: STATUS_DOT[k], ...(k !== "cancelled" ? { defaults: { status: k } } : {}) }),
      );
    case "assignee":
      return by(
        (t) => t.assigneeId ?? "",
        [],
        (k) => ({ label: k ? f.name(k) : f.tx("work.tasklist.chua_giao"), defaults: { assigneeId: k || null } }),
      ).sort((a, b) => (a.key === "" ? 1 : b.key === "" ? -1 : a.label.localeCompare(b.label)));
    case "project":
      return by(
        (t) => t.projectId ?? "",
        [],
        (k) => ({ label: k ? (f.projectName[k] ?? f.tx("work.tasklist.du_an")) : f.tx("work.tasklist.viec_ca_nhan"), defaults: { projectId: k || null } }),
      ).sort((a, b) => (a.key === "" ? 1 : b.key === "" ? -1 : a.label.localeCompare(b.label)));
    case "priority":
      return by(
        (t) => t.priority,
        [...PRIORITY_ORDER],
        (k) => ({ label: f.prioLabel(k) ?? k }),
      );
    case "label": {
      // A task with two labels shows under both; unlabelled ones last.
      const labels = [...new Set(sorted.flatMap((t) => t.labels))].sort((a, b) => a.localeCompare(b));
      return [
        ...labels.map((l) => ({ key: `l:${l}`, label: `#${l}`, rows: sorted.filter((t) => t.labels.includes(l)) })),
        { key: "l:", label: f.tx("taskActions.noLabel"), rows: sorted.filter((t) => !t.labels.length) },
      ];
    }
    case "none":
      return [{ key: "all", label: f.tx("taskActions.allTasks"), rows: sorted }];
    default:
      return GROUPS(f.tx).map((g) => ({ key: g.key, label: g.label, dot: GROUP_DOT[g.key], rows: sorted.filter((t) => groupOf(t) === g.key) }));
  }
}

/** My work grouped by urgency; one click completes, filters stay client-side. */
export function TaskList({
  tasks,
  projects,
  openNew,
  fields,
  projectId,
  toolbar,
  lead,
  views,
  exportHref,
}: {
  tasks: Task[];
  projects: Project[];
  openNew: boolean;
  fields: FieldDef[];
  /** Showing one project's tasks: no project filter, and new tasks go into it. */
  projectId?: string;
  /** The Work bar, shown at the start of the filter row so the page has one toolbar. */
  toolbar?: React.ReactNode;
  /** The page's scope title (left) and view switch (right), drawn in this one toolbar row. */
  lead?: React.ReactNode;
  views?: React.ReactNode;
  /** `/app/work/export?projectId=…` or `?scope=…`: the CSV route; the active filters are appended on click. */
  exportHref?: string;
}) {
  const { dueLabel, priority: prioLabel, status: statusLabel } = useFormat();
  const tx = useT();
  const aiOn = useAiEnabled();
  const [list, setList] = useState(tasks);
  const [justDone, setJustDone] = useState<string | null>(null);
  const toast = useToast();
  useEffect(() => setList(tasks), [tasks]); // fresh server data after router.refresh
  const [q, setQ] = useState("");
  const [project, setProject] = useState("");
  const [priority, setPriority] = useState("");
  const [showDone, setShowDone] = useState(false);
  const [creating, setCreating] = useState<boolean | GroupDefaults>(openNew);
  const projectName = useMemo(() => Object.fromEntries(projects.map((p) => [p.id, p.name])), [projects]);

  // Group by and sort (Display menu), remembered per list (my work, each project) in this browser.
  const viewKey = `${VIEW_KEY}:${projectId ?? "mine"}`;
  const [view, setViewRaw] = useState<ListView>(DEFAULT_VIEW);
  useEffect(() => {
    try {
      const v = JSON.parse(localStorage.getItem(viewKey) ?? "null") as Partial<ListView> | null;
      if (v) setViewRaw({ ...DEFAULT_VIEW, ...v });
    } catch {
      /* nothing remembered */
    }
  }, [viewKey]);
  const setView = (patch: Partial<ListView>) =>
    setViewRaw((v) => {
      const n = { ...v, ...patch };
      try {
        localStorage.setItem(viewKey, JSON.stringify(n));
      } catch {
        /* the choice lasts for this visit only */
      }
      return n;
    });
  // Rows being deleted wait out their undo before the request: hidden meanwhile.
  const [pendingDelete, setPendingDelete] = useState<Set<string>>(new Set());

  const filtered = list.filter(
    (t) =>
      !pendingDelete.has(t.id) &&
      (!q || t.title.toLowerCase().includes(q.toLowerCase()) || t.code.toLowerCase().includes(q.toLowerCase())) &&
      (!project || (project === "none" ? !t.projectId : t.projectId === project)) &&
      (!priority || t.priority === priority) &&
      (showDone || groupOf(t) !== "done"),
  );

  // Bulk actions: select rows, then complete / re-prioritise / reassign / move the due date together.
  const dir = useDirectory();
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [bulkMsg, setBulkMsg] = useState<{ text: string; tone: "ok" | "err" } | null>(null);
  const [busy, setBusy] = useState(false);
  // The row a Shift-click extends from (the last one toggled), in the order rows are shown.
  const anchor = useRef<string | null>(null);
  const toggleSel = (id: string, range = false) => {
    const order = shownOrder.current;
    setSel((s) => {
      const n = new Set(s);
      const from = anchor.current ? order.indexOf(anchor.current) : -1;
      const to = order.indexOf(id);
      if (range && from >= 0 && to >= 0) {
        for (const x of order.slice(Math.min(from, to), Math.max(from, to) + 1)) n.add(x);
      } else if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
    anchor.current = id;
  };
  const shownOrder = useRef<string[]>([]);
  /** One request for the whole selection (work/tasks/bulk): each task is saved or refused on its own. */
  const bulk = async (patch: Record<string, unknown>, label: string) => {
    setBusy(true);
    setBulkMsg(null);
    const ids = [...sel];
    try {
      const r = await api<{ ok: string[]; failed: { id: string }[]; tasks: Task[] }>("work/tasks/bulk", { method: "POST", body: { ids, ...patch } });
      const saved = new Map(r.tasks.map((t) => [t.id, t]));
      // Moved out of the project this list shows: the row leaves it.
      setList((l) => l.map((x) => saved.get(x.id) ?? x).filter((x) => !projectId || x.projectId === projectId));
      setSel(new Set());
      setBulkMsg(
        r.failed.length
          ? { text: tx("work.tasklist.viec_xong_viec_khong", { p0: label, p1: r.ok.length, p2: r.failed.length }), tone: "err" }
          : { text: tx("work.tasklist.da_cap_nhat_viec", { p0: label, p1: r.ok.length }), tone: "ok" },
      );
    } catch {
      setBulkMsg({ text: tx("common.actionFailed"), tone: "err" });
    } finally {
      setBusy(false);
    }
  };
  /** Delete waits 8 s behind an undo toast (rows hidden meanwhile), then goes out as one request. */
  const bulkDelete = () => {
    const ids = [...sel];
    setSel(new Set());
    setPendingDelete((p) => new Set([...p, ...ids]));
    let undone = false;
    const timer = setTimeout(() => {
      if (undone) return;
      void api<{ ok: string[]; failed: { id: string }[] }>("work/tasks/bulk", { method: "POST", body: { ids, delete: true } })
        .then((r) => {
          const gone = new Set(r.ok);
          setList((l) => l.filter((x) => !gone.has(x.id)));
          if (r.failed.length) setBulkMsg({ text: tx("taskActions.deleteSome", { ok: r.ok.length, failed: r.failed.length }), tone: "err" });
        })
        .catch(() => setBulkMsg({ text: tx("common.actionFailed"), tone: "err" }))
        .finally(() => setPendingDelete((p) => new Set([...p].filter((x) => !ids.includes(x)))));
    }, 8000);
    toast({
      message: tx("taskActions.deleted", { count: ids.length }),
      duration: 8000,
      undo: () => {
        undone = true;
        clearTimeout(timer);
        setPendingDelete((p) => new Set([...p].filter((x) => !ids.includes(x))));
      },
    });
  };
  const canDelete = [...sel].every((id) => list.find((x) => x.id === id)?.ownerId === dir.me);
  // Labels in this list, for the bulk "add label" picker.
  const allLabels = useMemo(() => [...new Set(list.flatMap((t) => t.labels))].sort(), [list]);
  const [labelDraft, setLabelDraft] = useState("");

  const prioOptions = (any?: string) => [
    ...(any ? [{ value: "", label: any }] : []),
    { value: "urgent", label: tx("work.tasklist.khan") },
    { value: "high", label: prioLabel("high") ?? "high" },
    { value: "medium", label: tx("work.tasklist.trung_binh") },
    { value: "low", label: tx("work.tasklist.thap") },
  ];

  const toggleDone = async (t: Task) => {
    const status = t.status === "done" ? "todo" : "done";
    setList((l) => l.map((x) => (x.id === t.id ? { ...x, status } : x)));
    if (status === "done") setJustDone(t.id);
    try {
      const saved = await api<Task>(`work/tasks/${t.id}`, { method: "PATCH", body: { expectedVersion: t.version, status } });
      setList((l) => l.map((x) => (x.id === t.id ? saved : x)));
      if (status === "done")
        toast({
          message: tx("work.board.doneToast", { title: t.title }),
          undo: async () => {
            const back = await api<Task>(`work/tasks/${t.id}`, { method: "PATCH", body: { expectedVersion: saved.version, status: t.status } });
            setList((l) => l.map((x) => (x.id === t.id ? back : x)));
          },
        });
    } catch {
      setList((l) => l.map((x) => (x.id === t.id ? t : x)));
    }
  };

  return (
    <>
      <div role="toolbar" aria-label={tx("work.board.toolbar")} className="mb-4 flex flex-wrap items-center gap-2">
        {lead ? <div className="flex min-w-0 items-center gap-2 max-sm:w-full">{lead}</div> : null}
        {toolbar}
        {q || project || priority ? (
          <button
            type="button"
            className={cx(btnGhost, "text-ink-2 h-9 min-h-0 px-2.5")}
            onClick={() => {
              setQ("");
              setProject("");
              setPriority("");
            }}
          >
            {tx("work.board.bo_loc")}
          </button>
        ) : null}
        <span className="ml-auto flex min-w-0 items-center gap-2">
          <SearchToggle value={q} onChange={setQ} label={tx("work.tasklist.loc_viec")} />
          <ToolbarPopover icon={<FilterIcon className="size-4" />} label={tx("work.board.filters")} count={(project ? 1 : 0) + (priority ? 1 : 0)}>
            <div className="grid gap-1">
              {projectId || toolbar ? null : (
                <PopoverRow label={tx("work.tasklist.du_an")}>
                  <Picker
                    variant="button"
                    align="right"
                    label={tx("work.tasklist.du_an")}
                    value={project}
                    onChange={setProject}
                    options={[
                      { value: "", label: tx("work.tasklist.moi_du_an") },
                      { value: "none", label: tx("work.tasklist.viec_ca_nhan") },
                      ...projects.map((p) => ({ value: p.id, label: p.name })),
                    ]}
                  />
                </PopoverRow>
              )}
              <PopoverRow label={tx("work.tasklist.uu_tien")}>
                <Picker
                  variant="button"
                  align="right"
                  label={tx("work.tasklist.uu_tien")}
                  value={priority}
                  onChange={setPriority}
                  options={prioOptions(tx("work.tasklist.moi_muc_uu_tien"))}
                />
              </PopoverRow>
            </div>
          </ToolbarPopover>
          <ToolbarPopover icon={<SettingsIcon className="size-4" />} label={tx("work.board.display")}>
            <div className="grid gap-1">
              <PopoverRow label={tx("taskActions.groupBy")}>
                <Picker
                  variant="button"
                  align="right"
                  label={tx("taskActions.groupBy")}
                  value={view.groupBy}
                  onChange={(v) => setView({ groupBy: v as GroupBy })}
                  options={GROUP_BYS.filter((k) => !(projectId && k === "project")).map((k) => ({ value: k, label: tx(`taskActions.group_${k}`) }))}
                />
              </PopoverRow>
              <PopoverRow label={tx("taskActions.sortBy")}>
                <Picker
                  variant="button"
                  align="right"
                  label={tx("taskActions.sortBy")}
                  value={view.sortBy}
                  onChange={(v) => setView({ sortBy: v as SortBy })}
                  options={SORT_BYS.map((k) => ({ value: k, label: tx(`taskActions.sort_${k}`) }))}
                />
              </PopoverRow>
            </div>
            <Checkbox label={tx("work.tasklist.hien_viec_da_xong")} checked={showDone} onChange={(e) => setShowDone(e.target.checked)} />
            {exportHref ? (
              <a
                className={cx(btn, btnSm, "w-full justify-center no-underline")}
                download
                href={`${exportHref}${q ? `&q=${encodeURIComponent(q)}` : ""}${project ? `&project=${encodeURIComponent(project)}` : ""}${priority ? `&priority=${priority}` : ""}${showDone ? "&done=1" : ""}`}
              >
                {tx("work.tasklist.export")}
              </a>
            ) : null}
          </ToolbarPopover>
          {views}
          <button
            type="button"
            className={cx(btnPrimary, "max-sm:w-9 max-sm:px-0")}
            onClick={() => setCreating(true)}
            aria-label={tx("work.tasklist.viec_moi")}
            title={tx("work.tasklist.viec_moi")}
          >
            <PlusIcon className="size-4" />
            <span className="max-sm:hidden">{tx("work.tasklist.viec_moi")}</span>
          </button>
        </span>
      </div>

      {filtered.length === 0 ? (
        <SlimEmpty
          icon={list.length ? <FilterIcon /> : undefined}
          tone={list.length ? "violet" : "green"}
          title={list.length ? tx("work.tasklist.khong_co_viec_khop") : tx("work.tasklist.ban_chua_co_viec")}
          action={
            <button type="button" className={btn} onClick={() => setCreating(true)}>
              {tx("work.tasklist.tao_viec")}
            </button>
          }
        >
          {list.length ? tx("work.tasklist.thu_bo_bot_bo") : tx(aiOn ? "work.tasklist.viec_duoc_giao_cho" : "work.tasklist.viec_duoc_giao_cho_noAi")}
        </SlimEmpty>
      ) : (
        (() => {
          const groups = groupRows(filtered, view, { tx, statusLabel, prioLabel, name: dir.name, projectName });
          shownOrder.current = groups.flatMap((g) => g.rows.map((t) => t.id));
          return groups;
        })().map((g) => {
          const rows = g.rows;
          if (!rows.length) return null;
          return (
            <section key={g.key} className="mb-6" aria-labelledby={`g-${g.key}`}>
              <h2 id={`g-${g.key}`} className="text-ink group/gh mb-2 flex items-center gap-2 text-sm font-semibold tracking-[-0.01em]">
                {g.dot ? <span aria-hidden="true" className={cx("size-2 shrink-0 rounded-full", g.dot)} /> : null}
                {g.label} <span className={cx("font-normal tabular-nums", g.key === "overdue" ? "text-block" : "text-ink-2")}>{rows.length}</span>
                {/* "+" on a group starts a task already in it (its status, person or project). */}
                {g.defaults ? (
                  <button
                    type="button"
                    onClick={() => setCreating(g.defaults!)}
                    aria-label={tx("taskActions.addIn", { group: g.label })}
                    title={tx("taskActions.addIn", { group: g.label })}
                    className="text-ink-2 hover:bg-hover hover:text-ink grid size-6 place-items-center rounded-md opacity-0 transition-opacity focus-visible:opacity-100 group-hover/gh:opacity-100 [@media(hover:none)]:opacity-100"
                  >
                    <PlusIcon className="size-3.5" />
                  </button>
                ) : null}
              </h2>
              <ul className="divide-divider-soft bg-surface shadow-card m-0 list-none divide-y overflow-hidden rounded-xl p-0">
                {rows.map((t) => {
                  const due = dueLabel(t.dueAt);
                  const done = t.status === "done";
                  return (
                    <li
                      key={t.id}
                      // "x" on a focused row selects it (as in mail apps); Shift+x extends from the last one.
                      onKeyDown={(e) => {
                        if ((e.key === "x" || e.key === "X") && !e.metaKey && !e.ctrlKey && !e.altKey && (e.target as HTMLElement).tagName !== "INPUT") {
                          e.preventDefault();
                          toggleSel(t.id, e.shiftKey);
                        }
                      }}
                      className={cx("group flex items-center gap-3 px-4 py-2.5 transition-colors", sel.has(t.id) ? "bg-selected" : "hover:bg-hover/60")}
                    >
                      {/* The checkbox's own input is the 24px (phone: 44px) target around the 16px box. */}
                      <label
                        className={cx("-m-1 grid size-6 shrink-0 cursor-pointer place-items-center", !sel.size && "max-sm:hidden")}
                        onClickCapture={(e) => {
                          // Shift-click selects every row between the last one toggled and this one.
                          if (e.shiftKey) {
                            e.preventDefault();
                            toggleSel(t.id, true);
                          }
                        }}
                      >
                        <Checkbox
                          checked={sel.has(t.id)}
                          onChange={() => toggleSel(t.id)}
                          aria-label={tx("work.tasklist.chon", { p0: t.title })}
                          boxClassName={cx(sel.size ? "" : "sm:opacity-0 sm:focus-within:opacity-100 sm:group-hover:opacity-100")}
                        />
                      </label>
                      <Link
                        href={taskHref(t)}
                        onClick={(e) => {
                          // While selecting, ⌘/Ctrl-click and Shift-click on a row select instead of opening it.
                          if (sel.size && (e.metaKey || e.ctrlKey || e.shiftKey)) {
                            e.preventDefault();
                            toggleSel(t.id, e.shiftKey);
                          }
                        }}
                        className="text-ink min-w-0 flex-1 no-underline max-md:-my-1 max-md:py-1"
                      >
                        <span className={cx("block truncate font-medium hover:underline", done && "text-ink-2 line-through")}>{t.title}</span>
                        <span className={cx("text-ink-2 flex items-center gap-2", smallText)}>
                          <span className="shrink-0 whitespace-nowrap tabular-nums">{t.code}</span>
                          {t.projectId && !projectId ? <span className="truncate">· {projectName[t.projectId] ?? tx("work.tasklist.du_an")}</span> : null}
                          {t.labels.slice(0, 3).map((l) => (
                            <Label key={l}>{l}</Label>
                          ))}
                        </span>
                      </Link>
                      <BlockedTag reason={t.blockedReason} />
                      {t.atRisk && !done ? (
                        <span className={cx("text-warn inline-flex shrink-0 items-center gap-1 font-medium", smallText)}>
                          <StatusMark kind="risk" />
                          {tx("checkin.atRiskShort")}
                        </span>
                      ) : null}
                      <span className="hidden w-5 shrink-0 justify-center sm:flex" title={prioLabel(t.priority) ?? t.priority}>
                        {t.priority === "urgent" || t.priority === "high" ? <PriorityMark priority={t.priority} /> : null}
                        <span className="sr-only">{prioLabel(t.priority)}</span>
                      </span>
                      <span className="hidden w-24 shrink-0 md:block">
                        <TaskStatusPill status={t.status} label={statusLabel(t.status) ?? t.status} className="max-w-full" />
                      </span>
                      {due ? (
                        <span
                          className={cx(
                            "inline-flex w-20 shrink-0 items-center justify-end gap-1 text-right tabular-nums",
                            smallText,
                            due.overdue && !done ? "text-ink-soft" : "text-ink-2",
                          )}
                        >
                          {due.overdue && !done ? <StatusMark kind="late" /> : null}
                          {done ? "" : due.text}
                        </span>
                      ) : (
                        <span className="w-20 shrink-0" />
                      )}
                      {t.assigneeId ? (
                        <Avatar id={t.assigneeId} size="sm" />
                      ) : (
                        <span className="text-ink-2/60 grid size-6 shrink-0 place-items-center" title={tx("work.tasklist.chua_giao")} aria-label={tx("work.tasklist.chua_giao")}>
                          <MeIcon className="size-4" />
                        </span>
                      )}
                      {/* Done is a row action at the end, not a circle before the title: a check that shows on
                          hover or focus (always on touch), green once the task is done. */}
                      <button
                        type="button"
                        onClick={() => void toggleDone(t)}
                        aria-label={done ? tx("work.tasklist.mo_lai", { p0: t.title }) : tx("work.tasklist.hoan_thanh", { p0: t.title })}
                        title={done ? tx("work.tasklist.mo_lai", { p0: t.title }) : tx("work.tasklist.hoan_thanh", { p0: t.title })}
                        className={cx(
                          "-my-1 grid size-7 shrink-0 place-items-center rounded-md transition-colors",
                          done
                            ? cx("text-ok hover:bg-ok-wash", justDone === t.id && "animate-pop")
                            : "text-ink-2 hover:bg-ok-wash hover:text-ok sm:opacity-0 sm:focus-visible:opacity-100 sm:group-hover:opacity-100",
                        )}
                      >
                        <CheckIcon className="size-4" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })
      )}
      {bulkMsg ? (
        <p role="status" className={cx("mb-4 rounded-md px-3 py-2 text-sm", bulkMsg.tone === "ok" ? "bg-ok-wash text-ok" : "bg-block-wash text-block")}>
          {bulkMsg.text}
        </p>
      ) : null}
      {sel.size ? (
        <div
          role="toolbar"
          aria-label={tx("work.tasklist.thao_tac_hang_loat")}
          className="bg-surface shadow-lift sticky bottom-20 z-20 mx-auto flex w-fit max-w-full flex-wrap items-center gap-2 rounded-xl px-3 py-2 md:bottom-4"
        >
          <span className="px-1 text-sm font-semibold">{tx("work.tasklist.viec_da_chon", { p0: sel.size })}</span>
          <button type="button" className={cx(btn, btnSm)} disabled={busy} onClick={() => void bulk({ status: "done" }, tx("work.tasklist.hoan_thanh_2"))}>
            <CheckIcon className="size-3.5" />
            {tx("work.tasklist.hoan_thanh_2")}
          </button>
          <Picker
            variant="button"
            label={tx("taskActions.bulkStatus")}
            disabled={busy}
            value=""
            placeholder={tx("taskActions.bulkStatus")}
            className="[&>button]:h-8"
            onChange={(v) => v && void bulk({ status: v }, tx("taskActions.bulkStatus"))}
            options={STATUS_KEYS.map((k) => ({ value: k, label: statusLabel(k) ?? k }))}
            renderOption={(o) => <TaskStatusPill status={o.value} label={o.label} className="h-6 px-2 text-[13px]" />}
          />
          <Picker
            variant="button"
            label={tx("work.tasklist.doi_uu_tien")}
            disabled={busy}
            value=""
            placeholder={tx("work.tasklist.uu_tien_2")}
            className="[&>button]:h-8"
            onChange={(v) => v && void bulk({ priority: v }, tx("work.tasklist.doi_uu_tien"))}
            options={prioOptions()}
          />
          <Picker
            variant="button"
            label={tx("work.tasklist.giao_viec")}
            disabled={busy}
            value=""
            placeholder={tx("work.tasklist.giao_cho")}
            className="[&>button]:h-8"
            onChange={(v) => v && void bulk({ assigneeId: v }, tx("work.tasklist.giao_viec"))}
            options={dir.people
              .filter((p) => p.status !== "disabled")
              .map((p) => ({ value: p.userId, label: p.displayName + (p.userId === dir.me ? tx("work.tasklist.toi") : ""), keywords: p.email }))}
          />
          <DateField
            variant="button"
            label={tx("work.tasklist.han_chot_moi")}
            placeholder={tx("work.tasklist.doi_han_label")}
            disabled={busy}
            value=""
            clearable={false}
            onChange={(v) => v && void bulk({ dueAt: at(v.slice(0, 10), 17 * 60).toISOString() }, tx("work.tasklist.doi_han"))}
          />
          <Picker
            variant="button"
            label={tx("taskActions.bulkLabel")}
            disabled={busy}
            value=""
            placeholder={tx("taskActions.bulkLabel")}
            className="[&>button]:h-8"
            onOpen={() => setLabelDraft("")}
            onChange={(v) => {
              if (!v) return;
              const [op, label] = [v.slice(0, 1), v.slice(2)];
              void bulk(op === "+" ? { addLabels: [label] } : { removeLabels: [label] }, tx("taskActions.bulkLabel"));
            }}
            options={[
              ...allLabels.map((l) => ({ value: `+:${l}`, label: tx("taskActions.addLabel", { label: l }), icon: <HashIcon className="size-3.5" /> })),
              ...allLabels
                .filter((l) => list.some((t) => sel.has(t.id) && t.labels.includes(l)))
                .map((l) => ({ value: `-:${l}`, label: tx("taskActions.removeLabel", { label: l }), keywords: l })),
            ]}
            footer={
              <form
                className="border-divider mt-1 flex gap-1.5 border-t px-1 pt-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  const l = labelDraft.trim().slice(0, 40);
                  if (l) void bulk({ addLabels: [l] }, tx("taskActions.bulkLabel"));
                }}
              >
                <input
                  className="bg-ground placeholder:text-ink-2 h-8 min-w-0 flex-1 rounded-md px-2 text-sm outline-none"
                  value={labelDraft}
                  onChange={(e) => setLabelDraft(e.target.value)}
                  placeholder={tx("taskActions.newLabel")}
                  aria-label={tx("taskActions.newLabel")}
                />
              </form>
            }
          />
          {projects.length ? (
            <Picker
              variant="button"
              label={tx("taskActions.bulkProject")}
              disabled={busy}
              value=""
              placeholder={tx("taskActions.bulkProject")}
              className="[&>button]:h-8"
              onChange={(v) => v && void bulk({ projectId: v === "none" ? null : v }, tx("taskActions.bulkProject"))}
              options={[
                { value: "none", label: tx("work.tasklist.viec_ca_nhan"), icon: <MeIcon className="size-4" /> },
                ...projects.filter((p) => p.id !== projectId).map((p) => ({ value: p.id, label: p.name, icon: <FolderIcon className="size-4" /> })),
              ]}
            />
          ) : null}
          {/* Delete only when every chosen task is the viewer's own (anyone else's needs task.delete, checked again by the server). */}
          <button type="button" className={cx(btn, btnSm, "text-block")} disabled={busy} title={canDelete ? undefined : tx("taskActions.deleteHint")} onClick={bulkDelete}>
            <TrashIcon className="size-3.5" />
            {tx("taskActions.bulkDelete")}
          </button>
          <button type="button" className={cx(btn, btnSm)} onClick={() => setSel(new Set())}>
            {tx("work.tasklist.bo_chon")}
          </button>
        </div>
      ) : null}
      {creating ? (
        <NewTaskDrawer
          projects={projects}
          fields={fields}
          defaultProject={typeof creating === "object" && creating.projectId !== undefined ? creating.projectId : (projectId ?? null)}
          defaultStatus={typeof creating === "object" ? (creating.status ?? null) : null}
          {...(typeof creating === "object" && creating.assigneeId !== undefined ? { defaultAssignee: creating.assigneeId } : {})}
          onClose={() => setCreating(false)}
        />
      ) : null}
    </>
  );
}
