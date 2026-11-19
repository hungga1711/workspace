"use client";

import { dateFormat } from "@/lib/intl";
import dynamic from "next/dynamic";
import Link from "next/link";
import { Picker } from "@/components/ui/Picker";
import { Segmented } from "@/components/ui/Segmented";
import { Checkbox } from "@/components/ui/Checkbox";
import { FilterIcon, PlusIcon, SettingsIcon } from "@/components/app/icons";
import { PopoverRow, ToolbarPopover } from "./ToolbarPopover";
import type { Project } from "./types";
import { useRouter } from "next/navigation";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/client";
import { useLocale, useT } from "@/lib/i18n/client";
import { INTL_TAG } from "@/lib/i18n/config";
import { Avatar, useDirectory } from "@/lib/people";
import { btn, btnPrimary, btnSm, cx } from "@/lib/ui";
import { ChevronDownIcon, ChevronRightIcon } from "@/components/app/icons";
import { at, parts as dayKey } from "./calTime";
import { taskHref } from "@/lib/links";

// The new-task form loads when it opens (date grid, pickers): not part of the board's first paint.
const NewTaskDrawer = dynamic(() => import("./NewTaskDrawer").then((m) => m.NewTaskDrawer), { ssr: false });

/**
 * Gantt for one project: bars from start to due, drag to move or
 * resize, finish-to-start links drawn as arrows (drag from a bar's end dot to another bar), broken
 * links counted with a one-click fix, today line, weekends and company holidays shaded, zoom, grouping,
 * and the critical path. All date maths is in days of the workspace's time zone so server and browser render the same.
 */

export interface GanttTask {
  id: string;
  code: string;
  title: string;
  status: string;
  columnId: string | null;
  assigneeId: string | null;
  startAt: string | null;
  dueAt: string | null;
  progress: number | null;
  parentId: string | null;
  createdAt?: string;
  priority: string;
  atRisk?: boolean;
  blockedReason?: string | null;
  version: number;
}
export interface GanttDep {
  id: string;
  from: string;
  to: string;
}
export interface GanttData {
  project: { id: string; code: string; name: string; dueAt: string | null };
  columns: GanttColumn[];
  tasks: GanttTask[];
  dependencies: GanttDep[];
  /** The server stops at 2,000 rows; the chart says so instead of silently drawing a part. */
  truncated?: boolean;
}
export interface GanttColumn {
  id: string;
  name: string;
  status: string;
}

const DAY = 86_400_000;
/** Day number in the workspace's time zone (days since 1970-01-01 there). */
const zoneDay = (iso: string | number) => Date.parse(`${dayKey(new Date(iso)).key}T00:00:00Z`) / DAY;
/** A day number back to an instant: 09:00 for a start, 17:00 for a due date (end of the working day). */
const startIso = (d: number) => at(isoDay(d), 9 * 60).toISOString();
const dueIso = (d: number) => at(isoDay(d), 17 * 60).toISOString();
/** Calendar parts of a day number (UTC maths on the day epoch). */
const parts = (d: number) => {
  const x = new Date(d * DAY);
  return { y: x.getUTCFullYear(), m: x.getUTCMonth(), day: x.getUTCDate(), wd: x.getUTCDay() };
};
const isoDay = (d: number) => new Date(d * DAY).toISOString().slice(0, 10);

const ROW = 36;
/** A bar is never narrower than a 24px touch target, even for a one-day task zoomed out. */
const MIN_BAR = 24;
const HEAD = 52;
const ZOOM = { day: 36, week: 16, month: 5 } as const;
type Zoom = keyof typeof ZOOM;
type Group = "none" | "column" | "assignee";

type Row = { kind: "group"; key: string; label: string; count: number } | { kind: "task"; t: GanttTask; depth: number; childCount: number };

type Span = { s: number; e: number; diamond: boolean; implied?: boolean };

function span(t: GanttTask): Span | null {
  if (t.startAt && t.dueAt) {
    const s = zoneDay(t.startAt);
    const e = Math.max(s, zoneDay(t.dueAt));
    return { s, e, diamond: false };
  }
  if (t.dueAt) {
    const e = zoneDay(t.dueAt);
    // Most tasks only have a due date. Drawn as a light bar from when the task was created (two weeks at most)
    // rather than a lone diamond, so the chart still reads as work over time; a real start date replaces it.
    const c = t.createdAt ? zoneDay(t.createdAt) : null;
    if (c !== null && c < e) return { s: Math.max(c, e - 13), e, diamond: false, implied: true };
    return { s: e, e, diamond: true };
  }
  if (t.startAt) {
    const s = zoneDay(t.startAt);
    return { s, e: s, diamond: false };
  }
  return null;
}

/** Zero-slack tasks along the dependency graph (forward/backward pass over day numbers). */
function criticalSet(tasks: GanttTask[], deps: GanttDep[]): Set<string> {
  const sp = new Map(tasks.map((t) => [t.id, span(t)]));
  const ids = tasks.filter((t) => sp.get(t.id) && !sp.get(t.id)!.diamond && !sp.get(t.id)!.implied).map((t) => t.id);
  if (!deps.length || !ids.length) return new Set();
  const preds = new Map<string, string[]>();
  const succs = new Map<string, string[]>();
  for (const d of deps) {
    if (!sp.get(d.from) || !sp.get(d.to)) continue;
    preds.set(d.to, [...(preds.get(d.to) ?? []), d.from]);
    succs.set(d.from, [...(succs.get(d.from) ?? []), d.to]);
  }
  const dur = (id: string) => sp.get(id)!.e - sp.get(id)!.s + 1;
  // Topological order (Kahn); cycles are refused by the server, so this terminates.
  const indeg = new Map(ids.map((id) => [id, (preds.get(id) ?? []).length]));
  const order: string[] = [];
  const q = ids.filter((id) => !indeg.get(id));
  while (q.length) {
    const id = q.shift()!;
    order.push(id);
    for (const s of succs.get(id) ?? []) {
      indeg.set(s, (indeg.get(s) ?? 1) - 1);
      if (!indeg.get(s)) q.push(s);
    }
  }
  const es = new Map<string, number>();
  for (const id of order) es.set(id, Math.max(sp.get(id)!.s, ...(preds.get(id) ?? []).map((p) => (es.get(p) ?? 0) + dur(p))));
  const finish = Math.max(...order.map((id) => (es.get(id) ?? 0) + dur(id)));
  const lf = new Map<string, number>();
  for (const id of [...order].reverse()) lf.set(id, Math.min(finish, ...(succs.get(id) ?? []).map((s) => (lf.get(s) ?? finish) - dur(s))));
  const linked = new Set(deps.flatMap((d) => [d.from, d.to]));
  return new Set(order.filter((id) => linked.has(id) && (lf.get(id) ?? 0) - dur(id) - (es.get(id) ?? 0) <= 0));
}

const STATUS_BAR: Record<string, string> = {
  todo: "bg-ink-2/35",
  in_progress: "bg-accent",
  review: "bg-warn",
  done: "bg-ok/70",
};

export function GanttView({
  initial,
  now,
  holidays = [],
  lead,
  views,
}: {
  initial: GanttData;
  now: number;
  holidays?: { day: string; name: string }[];
  /** The page's scope title and view switch, drawn in this view's one toolbar row. */
  lead?: React.ReactNode;
  views?: React.ReactNode;
}) {
  const columns = initial.columns;
  const tx = useT();
  const locale = useLocale();
  const dir = useDirectory();
  const router = useRouter();
  const [tasks, setTasks] = useState(initial.tasks);
  const [deps, setDeps] = useState(initial.dependencies);
  const [zoom, setZoom] = useState<Zoom>("day");
  const [group, setGroup] = useState<Group>("none");
  const [critical, setCritical] = useState(false);
  const [mine, setMine] = useState(false);
  const [late, setLate] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const chip = (on: boolean) =>
    cx(
      "h-7 rounded-full px-3 text-xs font-medium ring-1 ring-inset transition-[background-color,box-shadow]",
      on ? "bg-ink text-surface ring-ink" : "bg-ground text-ink-2 ring-hairline hover:bg-hover hover:text-ink hover:ring-edge",
    );
  const px = ZOOM[zoom];
  const today = zoneDay(now);

  // Remember zoom and grouping per project.
  const pref = `wos_gantt_${initial.project.id}`;
  useEffect(() => {
    try {
      const v = JSON.parse(localStorage.getItem(pref) ?? "{}") as { zoom?: Zoom; group?: Group };
      if (v.zoom && v.zoom in ZOOM) setZoom(v.zoom);
      if (v.group) setGroup(v.group);
    } catch {
      /* ignore */
    }
  }, [pref]);
  useEffect(() => {
    try {
      localStorage.setItem(pref, JSON.stringify({ zoom, group }));
    } catch {
      /* ignore */
    }
  }, [pref, zoom, group]);

  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const visible = useMemo(
    () =>
      tasks.filter((t) => {
        if (mine && t.assigneeId !== dir.me) return false;
        if (late && !(t.dueAt && zoneDay(t.dueAt) < today && t.status !== "done")) return false;
        return true;
      }),
    [tasks, mine, late, dir.me, today],
  );

  // Rows: optional group headers, top-level tasks by start, each followed by its subtasks.
  const rows = useMemo<Row[]>(() => {
    const kids = new Map<string, GanttTask[]>();
    for (const t of visible) if (t.parentId && byId.has(t.parentId)) kids.set(t.parentId, [...(kids.get(t.parentId) ?? []), t]);
    const key = (t: GanttTask) => span(t)?.s ?? Number.MAX_SAFE_INTEGER;
    const top = visible.filter((t) => !t.parentId || !byId.has(t.parentId)).sort((a, b) => key(a) - key(b));
    const out: Row[] = [];
    const push = (list: GanttTask[]) => {
      for (const t of list) {
        const ch = (kids.get(t.id) ?? []).sort((a, b) => key(a) - key(b));
        out.push({ kind: "task", t, depth: 0, childCount: ch.length });
        if (!collapsed.has(t.id)) for (const c of ch) out.push({ kind: "task", t: c, depth: 1, childCount: 0 });
      }
    };
    if (group === "none") push(top);
    else {
      const groups: { key: string; label: string; list: GanttTask[] }[] =
        group === "column"
          ? columns.map((c) => ({ key: c.id, label: c.name, list: top.filter((t) => t.columnId === c.id) }))
          : [...new Set(top.map((t) => t.assigneeId ?? ""))]
              .sort((a, b) => (a ? dir.name(a) : "~").localeCompare(b ? dir.name(b) : "~"))
              .map((k) => ({ key: k || "none", label: k ? dir.name(k) : tx("work.gantt.unassigned"), list: top.filter((t) => (t.assigneeId ?? "") === k) }));
      for (const g of groups) {
        if (!g.list.length) continue;
        out.push({ kind: "group", key: g.key, label: g.label, count: g.list.length });
        push(g.list);
      }
    }
    return out;
  }, [visible, byId, group, columns, collapsed, dir, tx]);

  // The visible date range: all scheduled work, today and the project's due date, with margins.
  const range = useMemo(() => {
    const days = tasks.flatMap((t) => {
      const s = span(t);
      return s ? [s.s, s.e] : [];
    });
    if (initial.project.dueAt) days.push(zoneDay(initial.project.dueAt));
    days.push(today);
    const lo = Math.min(...days) - (zoom === "month" ? 21 : 7);
    const hi = Math.max(...days, today + 42) + (zoom === "month" ? 45 : 14);
    // Start on a Monday so weeks line up.
    const start = lo - ((parts(lo).wd + 6) % 7);
    return { start, end: hi };
  }, [tasks, initial.project.dueAt, today, zoom]);
  const width = (range.end - range.start + 1) * px;
  const x = (d: number) => (d - range.start) * px;

  // Vertical windowing: only rows in view (plus a margin) render.
  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 720, left: 0, width: 1200 });
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const sync = () => setView({ top: el.scrollTop, height: el.clientHeight, left: el.scrollLeft, width: el.clientWidth });
    sync();
    el.addEventListener("scroll", sync, { passive: true });
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", sync);
      ro.disconnect();
    };
  }, []);
  // Phones: a narrow task column (title only) so the timeline stays visible.
  const [LEFT, setLeft] = useState(340);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const apply = () => setLeft(mq.matches ? 150 : 340);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  const first = Math.max(0, Math.floor((view.top - HEAD) / ROW) - 6);
  const last = Math.min(rows.length, Math.ceil((view.top + view.height) / ROW) + 6);
  const rowIndex = useMemo(() => {
    const m = new Map<string, number>();
    rows.forEach((r, i) => r.kind === "task" && m.set(r.t.id, i));
    return m;
  }, [rows]);

  // Open on today (or the first bar) once.
  const centred = useRef(false);
  const scrollToDay = useCallback(
    (d: number) => {
      const el = scroller.current;
      if (el) el.scrollTo({ left: Math.max(0, x(d) - (el.clientWidth - LEFT) / 3), behavior: centred.current ? "smooth" : "auto" });
      centred.current = true;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [range.start, px],
  );
  useEffect(() => {
    const first = !centred.current;
    scrollToDay(today);
    // Rows run by start date, so at today the top of a long project is finished work whose bars sit off to the left:
    // open with the first row still running at today near the top instead of an empty-looking grid.
    const el = scroller.current;
    if (first && el) {
      const i = rows.findIndex((r) => r.kind === "task" && r.t.status !== "done" && (span(r.t)?.e ?? -Infinity) >= today);
      if (i > 2) el.scrollTop = (i - 2) * ROW;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom]);

  const holidaySet = useMemo(() => new Map(holidays.map((h) => [h.day, h.name])), [holidays]);
  const crit = useMemo(() => (critical ? criticalSet(tasks, deps) : new Set<string>()), [critical, tasks, deps]);
  const broken = useMemo(
    () =>
      deps.filter((d) => {
        const a = byId.get(d.from);
        const b = byId.get(d.to);
        const sa = a && span(a);
        const sb = b && span(b);
        return sa && sb && b!.status !== "done" && sb.s <= sa.e;
      }),
    [deps, byId],
  );

  // ---- saving ----
  const save = useCallback(
    async (t: GanttTask, s: number | null, e: number | null) => {
      const before = t;
      const next = { ...t, startAt: s === null ? null : startIso(s), dueAt: e === null ? null : dueIso(e) };
      setTasks((cur) => cur.map((x) => (x.id === t.id ? next : x)));
      try {
        const u = await api<GanttTask>(`work/tasks/${t.id}`, { method: "PATCH", body: { expectedVersion: t.version, startAt: next.startAt, dueAt: next.dueAt } });
        setTasks((cur) => cur.map((x) => (x.id === t.id ? { ...x, ...u } : x)));
        setMsg(null);
      } catch (err) {
        setTasks((cur) => cur.map((x) => (x.id === t.id ? before : x)));
        const status = (err as { status?: number }).status;
        setMsg(status === 409 ? tx("work.gantt.conflict") : status === 403 ? tx("work.gantt.noPermission") : tx("work.gantt.saveFailed"));
      }
    },
    [tx],
  );
  const reload = async () => {
    const d = await api<GanttData>(`work/projects/${initial.project.id}/timeline`);
    setTasks(d.tasks);
    setDeps(d.dependencies);
  };
  const fixBroken = async () => {
    setBusy(true);
    try {
      for (const from of [...new Set(broken.map((d) => d.from))]) await api(`work/tasks/${from}/shift-dependents`, { method: "POST" });
      await reload();
      setMsg(null);
    } catch {
      setMsg(tx("work.gantt.saveFailed"));
    } finally {
      setBusy(false);
    }
  };
  const link = async (from: string, to: string) => {
    if (from === to || deps.some((d) => d.from === from && d.to === to)) return;
    try {
      const d = await api<GanttDep>(`work/tasks/${to}/dependencies`, { method: "POST", body: { predecessorId: from } });
      setDeps((cur) => [...cur, d]);
      setMsg(null);
    } catch (err) {
      const body = (err as { body?: { error?: string } }).body;
      setMsg(body?.error === "cycle" ? tx("work.gantt.cycle") : tx("work.gantt.saveFailed"));
    }
  };
  const unlink = async (id: string) => {
    const before = deps;
    setDeps((cur) => cur.filter((d) => d.id !== id));
    setPicked(null);
    try {
      await api(`work/task-dependencies/${id}`, { method: "DELETE" });
    } catch {
      setDeps(before);
      setMsg(tx("work.gantt.saveFailed"));
    }
  };

  // ---- dragging (move, resize, link) ----
  const [drag, setDrag] = useState<{ id: string; mode: "move" | "start" | "end"; dx: number } | null>(null);
  const [linking, setLinking] = useState<{ from: string; x0: number; y0: number; x1: number; y1: number } | null>(null);
  const begin = (e: React.PointerEvent, t: GanttTask, mode: "move" | "start" | "end") => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    let moved = 0;
    const onMove = (ev: PointerEvent) => {
      moved = Math.round((ev.clientX - x0) / px);
      setDrag({ id: t.id, mode, dx: moved });
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setDrag(null);
      const sp = span(t);
      if (!moved) {
        if (mode === "move" && Math.abs(ev.clientX - x0) < 4) router.push(taskHref(t));
        return;
      }
      if (!sp) return;
      if (sp.diamond && mode !== "start") void save(t, null, sp.e + moved);
      else if (mode === "move") void save(t, sp.s + moved, sp.e + moved);
      else if (mode === "start") void save(t, Math.min(sp.s + moved, sp.e), sp.e);
      else void save(t, sp.s, Math.max(sp.e + moved, sp.s));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  const beginLink = (e: React.PointerEvent, t: GanttTask, cx0: number, cy0: number) => {
    e.preventDefault();
    e.stopPropagation();
    const box = scroller.current!.getBoundingClientRect();
    const toLocal = (ev: { clientX: number; clientY: number }) => ({
      x: ev.clientX - box.left + scroller.current!.scrollLeft - LEFT,
      y: ev.clientY - box.top + scroller.current!.scrollTop,
    });
    setLinking({ from: t.id, x0: cx0, y0: cy0, x1: cx0, y1: cy0 });
    const onMove = (ev: PointerEvent) => {
      const p = toLocal(ev);
      setLinking((l) => (l ? { ...l, x1: p.x, y1: p.y } : l));
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setLinking(null);
      const target = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest<HTMLElement>("[data-gantt-task]");
      const to = target?.dataset.ganttTask;
      if (to) void link(t.id, to);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  const keyMove = (e: React.KeyboardEvent, t: GanttTask) => {
    const sp = span(t);
    if (!sp || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    e.preventDefault();
    const d = e.key === "ArrowLeft" ? -1 : 1;
    if (sp.diamond) void save(t, null, sp.e + d);
    else if (e.shiftKey) void save(t, sp.s, Math.max(sp.s, sp.e + d));
    else void save(t, sp.s + d, sp.e + d);
  };

  // Where each task's bar is right now (including a drag in progress).
  const live = (t: GanttTask) => {
    const sp = span(t);
    if (!sp) return null;
    if (!drag || drag.id !== t.id) return sp;
    if (sp.diamond || drag.mode === "move") return { ...sp, s: sp.s + drag.dx, e: sp.e + drag.dx };
    if (drag.mode === "start") return { ...sp, s: Math.min(sp.s + drag.dx, sp.e) };
    return { ...sp, e: Math.max(sp.e + drag.dx, sp.s) };
  };

  // ---- header cells ----
  const header = useMemo(() => {
    const top: { left: number; w: number; label: string }[] = [];
    const bottom: { left: number; w: number; label: string; weekend?: boolean; today?: boolean }[] = [];
    // Month names read as people say them ("Aug 2026"); Vietnamese keeps its own "Tháng 8, 2026" form in the catalog.
    const monthName = dateFormat(INTL_TAG[locale], { month: "short", timeZone: "UTC" });
    let d = range.start;
    while (d <= range.end) {
      const p = parts(d);
      const monthEnd = d + (new Date(Date.UTC(p.y, p.m + 1, 1)).getTime() / DAY - d);
      const end = Math.min(monthEnd - 1, range.end);
      top.push({ left: x(d), w: (end - d + 1) * px, label: tx("work.gantt.month", { m: p.m + 1, y: p.y, name: monthName.format(Date.UTC(p.y, p.m, 1)) }) });
      d = end + 1;
    }
    if (zoom === "day") {
      for (let i = range.start; i <= range.end; i++) {
        const p = parts(i);
        bottom.push({ left: x(i), w: px, label: String(p.day), weekend: p.wd === 0 || p.wd === 6, today: i === today });
      }
    } else if (zoom === "week") {
      for (let i = range.start; i <= range.end; i += 7) {
        const p = parts(i);
        bottom.push({ left: x(i), w: 7 * px, label: `${p.day}/${p.m + 1}` });
      }
    }
    return { top, bottom };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.start, range.end, px, zoom, today, tx, locale]);

  // Weekend and holiday stripes (day and week zoom only).
  const stripes = useMemo(() => {
    if (zoom === "month") return [];
    const out: { left: number; w: number; title?: string }[] = [];
    for (let i = range.start; i <= range.end; i++) {
      const p = parts(i);
      const hol = holidaySet.get(isoDay(i));
      if (p.wd === 0 || p.wd === 6 || hol) out.push({ left: x(i), w: px, ...(hol ? { title: hol } : {}) });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.start, range.end, px, zoom, holidaySet]);

  const height = HEAD + rows.length * ROW;
  const projectDue = initial.project.dueAt ? zoneDay(initial.project.dueAt) : null;

  // Arrows for links whose ends are rendered (either row in the window).
  const arrows = deps.flatMap((d) => {
    const ia = rowIndex.get(d.from);
    const ib = rowIndex.get(d.to);
    if (ia === undefined || ib === undefined) return [];
    if ((ia < first || ia > last) && (ib < first || ib > last)) return [];
    const a = byId.get(d.from)!;
    const b = byId.get(d.to)!;
    const sa = live(a);
    const sb = live(b);
    if (!sa || !sb) return [];
    const x1 = sa.diamond ? x(sa.e + 1) : Math.max(x(sa.e + 1), x(sa.s) + MIN_BAR);
    const y1 = HEAD + ia * ROW + ROW / 2;
    const x2 = x(sb.s);
    const y2 = HEAD + ib * ROW + ROW / 2;
    const bad = b.status !== "done" && sb.s <= sa.e;
    const mid = Math.max(x1 + 8, Math.min(x2 - 8, x1 + 8));
    const path = x2 - 8 > x1 ? `M${x1} ${y1} H${mid} V${y2} H${x2 - 2}` : `M${x1} ${y1} h8 V${y1 + (y2 > y1 ? ROW / 2 : -ROW / 2)} H${x2 - 10} V${y2} H${x2 - 2}`;
    return [{ d, path, bad, mx: (x1 + x2) / 2, my: (y1 + y2) / 2 }];
  });

  const unscheduled = rows.filter((r) => r.kind === "task" && !span(r.t)).length;

  return (
    <div className="grid gap-3">
      {initial.truncated ? <p className="text-ink-2 m-0 text-xs">{tx("work.gantt.truncated")}</p> : null}
      {/* One toolbar row, the same as the board's: today on the left; filters, display and new task on the right. */}
      <div role="toolbar" aria-label={tx("work.board.toolbar")} className="flex flex-wrap items-center gap-2">
        {lead ? <div className="flex min-w-0 items-center gap-2 max-sm:w-full">{lead}</div> : null}
        <button type="button" className={cx(btn, "h-9 min-h-0")} onClick={() => scrollToDay(today)}>
          {tx("work.gantt.today")}
        </button>
        {broken.length ? (
          <span className="flex items-center gap-2">
            <span className="text-block inline-flex items-center gap-1.5 text-xs font-medium">
              <span aria-hidden="true" className="bg-block size-1.5 rounded-full" />
              {tx("work.gantt.broken", { count: broken.length })}
            </span>
            <button type="button" className={cx(btn, btnSm)} disabled={busy} onClick={() => void fixBroken()}>
              {tx("work.gantt.fix")}
            </button>
          </span>
        ) : null}
        <span className="ml-auto flex items-center gap-2">
          {unscheduled ? <span className="text-ink-2 text-xs max-sm:hidden">{tx("work.gantt.unscheduled", { count: unscheduled })}</span> : null}
          <ToolbarPopover icon={<FilterIcon className="size-4" />} label={tx("work.board.filters")} count={(mine ? 1 : 0) + (late ? 1 : 0)}>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label={tx("work.board.quick")}>
              <button type="button" aria-pressed={mine} className={chip(mine)} onClick={() => setMine(!mine)}>
                {tx("work.board.cua_toi")}
              </button>
              <button type="button" aria-pressed={late} className={chip(late)} onClick={() => setLate(!late)}>
                {tx("work.board.overdue")}
              </button>
            </div>
          </ToolbarPopover>
          <ToolbarPopover icon={<SettingsIcon className="size-4" />} label={tx("work.board.display")}>
            <div className="grid gap-1">
              <PopoverRow label={tx("work.gantt.zoomLabel")}>
                <Segmented
                  size="sm"
                  label={tx("work.gantt.zoom")}
                  value={zoom}
                  onChange={(z) => setZoom(z)}
                  options={(["day", "week", "month"] as const).map((z) => ({ value: z, label: tx(`work.gantt.zoom_${z}`) }))}
                />
              </PopoverRow>
              <PopoverRow label={tx("work.board.groupBy")}>
                <Picker
                  variant="button"
                  align="right"
                  label={tx("work.board.groupBy")}
                  value={group}
                  onChange={(v) => setGroup(v as Group)}
                  options={[
                    { value: "none", label: tx("work.board.group_none") },
                    { value: "column", label: tx("work.gantt.byColumn") },
                    { value: "assignee", label: tx("work.board.nguoi_lam") },
                  ]}
                />
              </PopoverRow>
            </div>
            <div className="border-hairline grid gap-2 border-t pt-3">
              <Checkbox label={tx("work.gantt.critical")} hint={tx("work.gantt.criticalHint")} checked={critical} onChange={(e) => setCritical(e.target.checked)} />
              <p className="text-ink-2 m-0 text-xs/[1.5]">{tx("work.gantt.hint")}</p>
            </div>
          </ToolbarPopover>
          {views}
          <button
            type="button"
            className={cx(btnPrimary, "max-sm:w-9 max-sm:px-0")}
            onClick={() => setAdding(true)}
            aria-label={tx("work.board.viec_moi")}
            title={tx("work.board.viec_moi")}
          >
            <PlusIcon className="size-4" />
            <span className="max-sm:hidden">{tx("work.board.viec_moi")}</span>
          </button>
        </span>
      </div>
      {msg ? (
        <p className="bg-block-wash text-block m-0 rounded-md px-3 py-2 text-sm" role="alert">
          {msg}
        </p>
      ) : null}

      <div ref={scroller} className="shadow-card bg-surface relative max-h-[calc(100dvh-258px)] overflow-auto rounded-xl" onClick={() => setPicked(null)}>
        <div className="relative" style={{ width: LEFT + width, height }}>
          {/* Header: sticky on top; its left corner also sticks left. */}
          <div className="bg-surface border-hairline sticky top-0 z-20 flex border-b" style={{ height: HEAD, width: LEFT + width }}>
            <div
              className="bg-surface border-hairline text-ink-2 sticky left-0 z-10 grid shrink-0 grid-cols-[1fr_44px_88px] items-end gap-2 border-r px-3 pb-2 text-xs font-medium max-sm:grid-cols-1 max-sm:[&>*:not(:first-child)]:hidden"
              style={{ width: LEFT }}
            >
              <span>{tx("work.gantt.task")}</span>
              <span />
              <span>{tx("work.gantt.dates")}</span>
            </div>
            <div className="relative" style={{ width }}>
              {header.top.map((h) => (
                <span
                  key={h.left}
                  className="border-hairline text-ink absolute top-0 border-l text-xs font-semibold"
                  style={{ left: h.left, width: h.w, height: zoom === "month" ? HEAD : 26 }}
                >
                  {/* The month name stays in view while its month scrolls past. */}
                  <span className="sticky inline-block whitespace-nowrap px-2 pt-1.5" style={{ left: LEFT }}>
                    {h.label}
                  </span>
                </span>
              ))}
              {/* Day zoom marks today's own date; coarser zooms have no day cell, so a "Hôm nay" chip sits on the line. */}
              {zoom !== "day" ? (
                <span
                  className="bg-accent text-on-brand absolute bottom-1 z-10 -translate-x-1/2 whitespace-nowrap rounded px-1.5 py-px text-xs font-medium"
                  style={{ left: x(today) }}
                >
                  {tx("work.gantt.todayChip")}
                </span>
              ) : null}
              {header.bottom.map((h) => (
                <span
                  key={h.left}
                  className={cx(
                    "border-hairline/60 absolute bottom-0 grid place-items-center border-l text-xs tabular-nums",
                    h.today
                      ? "after:bg-accent text-on-brand z-0 font-semibold after:absolute after:inset-x-1 after:inset-y-0.5 after:-z-10 after:rounded"
                      : h.weekend
                        ? "text-ink-2"
                        : "text-ink-2",
                  )}
                  style={{ left: h.left, width: h.w, height: 24 }}
                >
                  {h.label}
                </span>
              ))}
            </div>
          </div>

          {/* Timeline layer: stripes, today line, project due flag. */}
          <div className="pointer-events-none absolute bottom-0" style={{ left: LEFT, top: HEAD, width, height: height - HEAD }}>
            {stripes.map((s) => (
              <span key={s.left} title={s.title} className={cx("absolute inset-y-0", s.title ? "bg-warn-wash/70" : "bg-hover/60")} style={{ left: s.left, width: s.w }} />
            ))}
            <span className="bg-accent absolute inset-y-0 w-px" style={{ left: x(today) + (zoom === "day" ? px / 2 : 0) }} aria-hidden="true" />
            {projectDue !== null ? (
              <span
                className="border-block absolute inset-y-0 border-l-2 border-dashed"
                style={{ left: x(projectDue + 1) }}
                title={tx("work.gantt.projectDue")}
                aria-hidden="true"
              />
            ) : null}
          </div>

          {/* Rows (windowed). */}
          {rows.slice(first, last).map((r, k) => {
            const i = first + k;
            const top = HEAD + i * ROW;
            if (r.kind === "group")
              return (
                <div key={`g:${r.key}`} className="bg-hover/70 border-hairline absolute flex items-center border-b" style={{ top, height: ROW, width: LEFT + width }}>
                  <span className="bg-hover/70 sticky left-0 flex h-full items-center gap-2 px-3 text-xs font-semibold" style={{ width: LEFT }}>
                    {r.label}
                    <span className="text-ink-2 text-xs font-normal tabular-nums">{r.count}</span>
                  </span>
                </div>
              );
            return (
              <GanttRow
                key={r.t.id}
                r={r}
                top={top}
                left={LEFT}
                width={width}
                sp={live(r.t)}
                x={x}
                px={px}
                today={today}
                critical={crit.has(r.t.id)}
                dragging={drag?.id === r.t.id}
                collapsed={collapsed.has(r.t.id)}
                onToggle={() =>
                  setCollapsed((cur) => {
                    const n = new Set(cur);
                    if (n.has(r.t.id)) n.delete(r.t.id);
                    else n.add(r.t.id);
                    return n;
                  })
                }
                onBegin={begin}
                onLink={beginLink}
                onKey={keyMove}
                onSchedule={(day) => void save(r.t, day, day + 2)}
                tx={tx}
              />
            );
          })}

          {/* Dependency arrows over the timeline. */}
          <svg className="pointer-events-none absolute" style={{ left: LEFT, top: 0, width, height }} aria-hidden="true">
            <defs>
              <marker id="gantt-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M0 0L8 4L0 8Z" className="fill-ink-2" />
              </marker>
              <marker id="gantt-arrow-bad" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M0 0L8 4L0 8Z" className="fill-block" />
              </marker>
            </defs>
            {arrows.map((a) => (
              <g key={a.d.id}>
                <path
                  d={a.path}
                  fill="none"
                  strokeWidth={1.5}
                  className={cx(a.bad ? "stroke-block" : picked === a.d.id ? "stroke-brand-text" : "stroke-ink-2/70")}
                  markerEnd={`url(#${a.bad ? "gantt-arrow-bad" : "gantt-arrow"})`}
                />
                <path
                  d={a.path}
                  fill="none"
                  strokeWidth={10}
                  className="pointer-events-auto cursor-pointer stroke-transparent"
                  onClick={(e) => {
                    e.stopPropagation();
                    setPicked(a.d.id);
                  }}
                >
                  <title>{tx("work.gantt.linkTitle", { from: byId.get(a.d.from)?.code ?? "", to: byId.get(a.d.to)?.code ?? "" })}</title>
                </path>
              </g>
            ))}
            {linking ? (
              <path d={`M${linking.x0} ${linking.y0} L${linking.x1} ${linking.y1}`} className="stroke-brand-text" strokeWidth={1.5} strokeDasharray="4 3" fill="none" />
            ) : null}
          </svg>
          {picked
            ? (() => {
                const a = arrows.find((x) => x.d.id === picked);
                if (!a) return null;
                return (
                  <button
                    type="button"
                    className={cx(btn, btnSm, "shadow-soft absolute z-30")}
                    style={{ left: LEFT + a.mx - 40, top: a.my - 14 }}
                    onClick={(e) => {
                      e.stopPropagation();
                      void unlink(a.d.id);
                    }}
                  >
                    {tx("work.gantt.unlink")}
                  </button>
                );
              })()
            : null}
        </div>
      </div>
      {adding ? (
        <NewTaskDrawer
          projects={[{ id: initial.project.id, code: initial.project.code, name: initial.project.name } as Project]}
          defaultProject={initial.project.id}
          onClose={() => setAdding(false)}
        />
      ) : null}
    </div>
  );
}

const GanttRow = memo(function GanttRow({
  r,
  top,
  left,
  width,
  sp,
  x,
  px,
  today,
  critical,
  dragging,
  collapsed,
  onToggle,
  onBegin,
  onLink,
  onKey,
  onSchedule,
  tx,
}: {
  r: Extract<Row, { kind: "task" }>;
  top: number;
  left: number;
  width: number;
  sp: Span | null;
  x: (d: number) => number;
  px: number;
  today: number;
  critical: boolean;
  dragging: boolean;
  collapsed: boolean;
  onToggle: () => void;
  onBegin: (e: React.PointerEvent, t: GanttTask, mode: "move" | "start" | "end") => void;
  onLink: (e: React.PointerEvent, t: GanttTask, x0: number, y0: number) => void;
  onKey: (e: React.KeyboardEvent, t: GanttTask) => void;
  onSchedule: (day: number) => void;
  tx: ReturnType<typeof useT>;
}) {
  const t = r.t;
  const late = t.status !== "done" && t.dueAt !== null && zoneDay(t.dueAt) < today;
  const label = sp
    ? tx("work.gantt.barLabel", { code: t.code, title: t.title, from: fmt(sp.s), to: fmt(sp.e), progress: t.progress ?? 0 }) + (sp.implied ? ` (${tx("work.gantt.noStart")})` : "")
    : tx("work.gantt.noDates", { code: t.code, title: t.title });
  const bx = sp ? x(sp.s) : 0;
  const bw = sp ? (sp.e - sp.s + 1) * px : 0;
  return (
    <div className="border-hairline/70 group/row hover:bg-hover/40 absolute flex border-b" style={{ top, height: ROW, width: left + width }}>
      {/* Left table cell: sticky. */}
      <div
        className="bg-surface group-hover/row:bg-hover/60 border-hairline sticky left-0 z-10 grid shrink-0 grid-cols-[1fr_44px_88px] items-center gap-2 border-r px-3 max-sm:grid-cols-1 max-sm:[&>*:not(:first-child)]:hidden"
        style={{ width: left }}
      >
        <span className="flex min-w-0 items-center gap-1.5" style={{ paddingLeft: r.depth * 16 }}>
          {r.childCount ? (
            <button
              type="button"
              onClick={onToggle}
              aria-label={collapsed ? tx("work.gantt.expand") : tx("work.gantt.collapse")}
              className="text-ink-2 hover:text-ink grid size-4 shrink-0 place-items-center"
            >
              {collapsed ? <ChevronRightIcon className="size-3.5" /> : <ChevronDownIcon className="size-3.5" />}
            </button>
          ) : null}
          <span className="text-ink-2 shrink-0 text-xs tabular-nums">{t.code}</span>
          {/* A client link, so the task opens in the Peek drawer over the timeline (not a full page load). */}
          <Link href={taskHref(t)} className={cx("text-ink min-w-0 truncate py-0.5 text-sm/5 no-underline hover:underline", t.status === "done" && "text-ink-2 line-through")}>
            {t.title}
          </Link>
        </span>
        <span className="flex justify-center">{t.assigneeId ? <Avatar id={t.assigneeId} size="xs" /> : null}</span>
        <span className={cx("text-xs tabular-nums", late ? "text-block font-medium" : "text-ink-2")}>
          {sp ? (sp.diamond || sp.implied ? fmt(sp.e) : `${fmt(sp.s)}–${fmt(sp.e)}`) : "—"}
        </span>
      </div>
      {/* Timeline cell. */}
      <div
        className="relative"
        style={{ width }}
        onDoubleClick={(e) => {
          if (sp) return;
          const box = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
          onSchedule(Math.floor((e.clientX - box.left) / px) + Math.round(x(0) / -px));
        }}
      >
        {!sp ? (
          <span className="text-ink-2 pointer-events-none absolute inset-y-0 left-2 hidden items-center text-xs group-hover/row:flex" style={{ left: x(today) + 8 }}>
            {tx("work.gantt.dblClickToSchedule")}
          </span>
        ) : sp.diamond ? (
          <button
            type="button"
            data-gantt-task={t.id}
            aria-label={label}
            title={label}
            onPointerDown={(e) => onBegin(e, t, "move")}
            onKeyDown={(e) => onKey(e, t)}
            // A 24px square target; the 14px diamond is drawn inside it.
            className="group/dia absolute top-1/2 grid size-6 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-md outline-none"
            style={{ left: bx + px / 2 }}
          >
            <span
              aria-hidden="true"
              className={cx(
                "size-3.5 rotate-45 rounded-[3px] group-focus-visible/dia:ring-2",
                late ? "bg-block" : t.status === "done" ? "bg-ok" : "bg-brand",
                dragging && "ring-brand-text ring-2",
              )}
            />
          </button>
        ) : (
          <div data-gantt-task={t.id} className={cx("group/bar absolute top-1/2 -translate-y-1/2", dragging && "z-20")} style={{ left: bx, width: Math.max(bw, MIN_BAR) }}>
            <button
              type="button"
              aria-label={label}
              title={label}
              onPointerDown={(e) => onBegin(e, t, "move")}
              onKeyDown={(e) => onKey(e, t)}
              className={cx(
                "relative flex h-6 w-full cursor-grab items-center overflow-hidden rounded-md text-left outline-none focus-visible:ring-2 active:cursor-grabbing",
                sp.implied ? "border-ink-2/40 bg-hover border border-dashed" : (STATUS_BAR[t.status] ?? "bg-ink-2/35"),
                late && "ring-block ring-2",
                critical && "ring-rose ring-2",
                dragging && "shadow-soft opacity-90",
              )}
            >
              {t.progress != null && t.status !== "done" ? <span className="bg-ink/15 absolute inset-y-0 left-0" style={{ width: `${t.progress}%` }} aria-hidden="true" /> : null}
              {bw > 70 ? <span className={cx("relative truncate px-2 text-xs font-medium", t.status === "todo" || sp.implied ? "text-ink" : "text-white")}>{t.title}</span> : null}
            </button>
            {bw <= 70 ? <span className="text-ink-2 pointer-events-none absolute left-full top-1/2 ml-2 -translate-y-1/2 whitespace-nowrap text-xs">{t.title}</span> : null}
            {/* Resize handles and the link dot (end of the bar). */}
            <span onPointerDown={(e) => onBegin(e, t, "start")} className="hover:bg-ink/20 absolute inset-y-0 left-0 w-2 cursor-ew-resize rounded-l-md" aria-hidden="true" />
            <span onPointerDown={(e) => onBegin(e, t, "end")} className="hover:bg-ink/20 absolute inset-y-0 right-0 w-2 cursor-ew-resize rounded-r-md" aria-hidden="true" />
            <span
              onPointerDown={(e) => onLink(e, t, bx + Math.max(bw, MIN_BAR) + 6, top + ROW / 2)}
              title={tx("work.gantt.linkHandle")}
              className="border-brand-text bg-surface absolute -right-3 top-1/2 hidden size-3 -translate-y-1/2 cursor-crosshair rounded-full border-2 group-hover/bar:block"
              aria-hidden="true"
            />
          </div>
        )}
      </div>
    </div>
  );
});

function fmt(d: number) {
  const p = parts(d);
  return `${p.day}/${p.m + 1}`;
}
