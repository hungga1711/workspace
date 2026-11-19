"use client";

import dynamic from "next/dynamic";
import { FormField } from "./FormField";
import { useT, useFormat } from "@/lib/i18n/client";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  closestCorners,
  defaultDropAnimationSideEffects,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type DropAnimation,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, horizontalListSortingStrategy, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import Link from "next/link";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "@/lib/client";
import { Avatar, useDirectory } from "@/lib/people";
import { btn, btnDanger, btnGhost, btnPrimary, cx, input } from "@/lib/ui";
import { Modal } from "@/components/ui/Modal";
import { Field, Label, PriorityTag, BlockedTag } from "@/components/ui/bits";
import { Menu, type MenuItem } from "@/components/ui/Menu";
import { CalendarIcon, ChatIcon, ChecklistIcon, FilterIcon, GripIcon, LockIcon, MoreIcon, PlusIcon, SettingsIcon } from "@/components/app/icons";
import { PersonTrigger } from "@/components/chat/PersonTrigger";
import { Picker } from "@/components/ui/Picker";
import { Checkbox } from "@/components/ui/Checkbox";
import { PopoverRow, SearchToggle, ToolbarPopover } from "./ToolbarPopover";
import type { Project } from "./types";
import { taskHref } from "@/lib/links";
import { useRouter } from "next/navigation";
import { TaskStatusPill } from "./TaskStatusPill";

// The new-task form loads when it opens (date grid, pickers): not part of the board's first paint.
const NewTaskDrawer = dynamic(() => import("./NewTaskDrawer").then((m) => m.NewTaskDrawer), { ssr: false });

interface Card {
  id: string;
  code: string;
  title: string;
  status: string;
  priority: string;
  version: number;
  assigneeId: string | null;
  dueAt: string | null;
  labels: string[];
  blockedReason?: string | null;
  progress?: number | null;
  atRisk?: boolean;
  /** Subtasks done of total (absent: no subtasks), and the comment count: from the board endpoint only. */
  subtasks?: { done: number; total: number } | null;
  comments?: number;
}
/** A board column stands for one status: a card moved into it takes that status, and a status change moves the card. */
interface Column {
  id: string;
  name: string;
  status: ColumnStatus;
  wipLimit: number | null;
  /** Cards matching the current filters (server-side); `total` is the column's real size. */
  count: number;
  total?: number;
  tasks: Card[];
}
export interface BoardData {
  project: { id: string; code: string; name: string; canEdit?: boolean };
  columns: Column[];
}

type ColumnStatus = "todo" | "in_progress" | "review" | "done";
const COLUMN_STATUSES: ColumnStatus[] = ["todo", "in_progress", "review", "done"];

type Filters = { assignee?: string | undefined; label?: string | undefined; priority?: string | undefined; due?: string | undefined; blocked?: string | undefined };

// A click right after a drag must not open the task.
let lastDragEnd = 0;
const PRIO_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
const colId = (c: Column) => `col:${c.id}`;
/** A column dragged by its header (reorder) has its own ids, apart from the `col:` drop targets that take cards. */
const COL_DRAG = "drag-col:";
const isColDrag = (id: string | number) => String(id).startsWith("drag-col");

/**
 * A column being reordered lands on the nearest column. A card: pointer inside a column wins (empty columns
 * included), otherwise the nearest card corner; never a column's reorder target.
 */
const collision: CollisionDetection = (args) => {
  if (isColDrag(args.active.id)) return closestCenter({ ...args, droppableContainers: args.droppableContainers.filter((d) => isColDrag(d.id)) });
  const cards = { ...args, droppableContainers: args.droppableContainers.filter((d) => !isColDrag(d.id)) };
  const inside = pointerWithin(cards);
  return inside.length ? inside : closestCorners(cards);
};
/** Cancels the drag in progress: dnd-kit's sensors stop on Escape (pointer and keyboard alike). Sent from <body> (it bubbles to the sensors' document listeners), as other keydown handlers expect an element target. */
const cancelDrag = () => setTimeout(() => document.body.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape", key: "Escape", bubbles: true })), 30);
const dropAnimation: DropAnimation = { duration: 180, easing: "cubic-bezier(.2,.7,.2,1)", sideEffects: defaultDropAnimationSideEffects({ styles: { active: { opacity: "0" } } }) };

/** The card's face, shared by the list item and the floating drag preview. */
/** Memoised: a drag re-renders only the cards whose data or position changed, not the whole board. */
const CardBody = memo(function CardBody({ t, lifted = false, compact = false }: { t: Card; lifted?: boolean; compact?: boolean }) {
  const { dueLabel, dayLabel, time } = useFormat();
  const tx = useT();
  const due = dueLabel(t.dueAt);
  const done = t.status === "done";
  // Beside the calendar icon "due" goes without saying: "Today 17:00", not "due 17:00".
  const dueChip = due && t.dueAt && !due.overdue && dayLabel(t.dueAt) === tx("format.today") ? `${tx("format.today")} ${time(t.dueAt)}` : due?.text;
  // The whole card opens the task (a stretched link under the card's other controls); a click that ends a drag does not.
  const open = (
    <Link
      href={taskHref(t)}
      onClick={(e) => {
        if (lifted || Date.now() - lastDragEnd < 300) e.preventDefault();
      }}
      draggable={false}
      aria-label={tx("work.board.openCard", { title: t.title })}
      className="absolute inset-0 rounded-[inherit] outline-none"
    />
  );
  // The assignee opens their profile card; it sits above the stretched link and never starts a drag.
  const assignee = t.assigneeId ? (
    <PersonTrigger userId={t.assigneeId} className="relative z-10 -m-2.5 shrink-0 p-2.5 transition-transform duration-75 hover:scale-105 md:-m-1 md:p-1">
      <Avatar id={t.assigneeId} size="xs" />
    </PersonTrigger>
  ) : null;
  if (compact && !lifted)
    // One line per card: dense boards with hundreds of cards (code, title, due, assignee).
    return (
      <div className="bg-surface shadow-card group-hover:shadow-lift relative flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 transition-shadow duration-200 max-md:min-h-11">
        {open}
        <span className="text-ink-2 shrink-0 font-mono text-xs tabular-nums">{t.code}</span>
        <span className={cx("min-w-0 flex-1 truncate text-xs font-medium max-md:text-[13px]", done ? "text-ink-2" : "text-ink")}>{t.title}</span>
        {t.blockedReason ? <span className="bg-block size-1.5 shrink-0 rounded-full" aria-label={t.blockedReason} /> : null}
        {/* Subtasks done, not a typed-in percentage that nothing keeps current. */}
        {t.subtasks && !done ? (
          <span className={cx("shrink-0 text-xs tabular-nums", t.subtasks.done === t.subtasks.total ? "text-ok" : "text-ink-2")}>
            {t.subtasks.done}/{t.subtasks.total}
          </span>
        ) : null}
        {due && !done ? (
          <span className="text-ink-soft inline-flex shrink-0 items-center gap-1.5 text-xs tabular-nums">
            {due.overdue ? <span className="bg-block size-1.5 rounded-full" aria-hidden="true" /> : null}
            {due.text}
          </span>
        ) : null}
        {assignee}
      </div>
    );
  const urgent = t.priority === "urgent" || t.priority === "high";
  const meta = !done && (due || t.subtasks || (t.comments ?? 0) > 0);
  return (
    <div
      className={cx(
        // Home's card: a hairline ring at rest, the darker ring and long soft shadow on hover. No hover
        // translate: dnd-kit owns the card's transform.
        "bg-surface ease-out-soft relative flex cursor-pointer flex-col gap-2 rounded-xl p-3 transition-shadow duration-200",
        // Lifted: the card rises off the board (a touch larger, tilted, a real shadow) while it is carried.
        lifted ? "lift" : "shadow-card group-hover:shadow-lift",
      )}
    >
      {open}
      <div className="flex items-center gap-2">
        <span className="text-ink-2 font-mono text-xs tabular-nums">{t.code}</span>
        {urgent && !done ? (
          <span className="ml-auto">
            <PriorityTag priority={t.priority} />
          </span>
        ) : null}
      </div>
      <p className={cx("m-0 line-clamp-2 text-sm font-medium leading-snug", done ? "text-ink-2" : "text-ink")}>{t.title}</p>
      {t.labels.length ? (
        <div className="flex flex-wrap gap-1">
          {t.labels.slice(0, 3).map((l) => (
            <Label key={l}>{l}</Label>
          ))}
        </div>
      ) : null}
      {t.blockedReason || t.atRisk ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <BlockedTag reason={t.blockedReason} />
          {t.atRisk ? (
            <span className="text-ink-soft inline-flex items-center gap-1.5 whitespace-nowrap text-xs">
              <span className="bg-warn size-1.5 rounded-full" aria-hidden="true" />
              {tx("checkin.atRiskShort")}
            </span>
          ) : null}
        </div>
      ) : null}
      {meta || assignee ? (
        <div className="flex min-h-6 items-center gap-1.5">
          {/* A finished task has no due date to worry about ("trễ 21 ngày" on a done card reads as a problem). */}
          {due && !done ? (
            // Late is a red dot and quiet words (the project list and Tiến độ say it the same way), not red text:
            // a board with twenty late cards was red from top to bottom and nothing stood out.
            <span className={cx("inline-flex h-6 items-center gap-1 whitespace-nowrap text-xs tabular-nums", due.overdue ? "text-ink-soft" : "text-ink-2")}>
              {due.overdue ? <span className="bg-block mx-0.5 size-1.5 rounded-full" aria-hidden="true" /> : <CalendarIcon className="size-3.5" aria-hidden="true" />}
              {dueChip}
            </span>
          ) : null}
          {t.subtasks && !done ? (
            <span
              className={cx("inline-flex h-6 items-center gap-1 px-1 text-xs tabular-nums", t.subtasks.done === t.subtasks.total ? "text-ok" : "text-ink-2")}
              title={tx("work.board.subtasksDone", { done: t.subtasks.done, total: t.subtasks.total })}
            >
              <ChecklistIcon className="size-3.5" aria-hidden="true" />
              {t.subtasks.done}/{t.subtasks.total}
            </span>
          ) : null}
          {(t.comments ?? 0) > 0 && !done ? (
            <span className="text-ink-2 inline-flex h-6 items-center gap-1 px-1 text-xs tabular-nums" title={tx("work.board.comments", { count: t.comments ?? 0 })}>
              <ChatIcon className="size-3.5" aria-hidden="true" />
              {t.comments}
            </span>
          ) : null}
          <span className="ml-auto flex items-center">{assignee}</span>
        </div>
      ) : null}
    </div>
  );
});

const SortableCard = memo(function SortableCard({ t, locked, compact }: { t: Card; locked: boolean; compact: boolean }) {
  const router = useRouter();
  // The card holds links (the task, its assignee), so it is a focusable list item, not a button: Space picks it up
  // (the KeyboardSensor starts on Space only), Enter opens the task.
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: t.id, disabled: locked, attributes: { role: "listitem" } });
  const { role: _role, "aria-roledescription": _desc, ...keyAttrs } = attributes;
  return (
    <li
      ref={setNodeRef}
      data-card
      {...keyAttrs}
      {...listeners}
      onKeyDown={(e) => {
        if (e.key === "Enter" && e.target === e.currentTarget && !isDragging) {
          e.preventDefault();
          router.push(taskHref(t));
          return;
        }
        listeners?.onKeyDown?.(e);
      }}
      style={{ transform: transform ? `translate3d(${Math.round(transform.x)}px, ${Math.round(transform.y)}px, 0)` : undefined, transition }}
      className={cx(
        "focus-visible:ring-brand-text group relative min-w-0 rounded-xl outline-none focus-visible:ring-2",
        locked ? "cursor-default" : "cursor-grab touch-manipulation",
      )}
    >
      {/* While dragging, the original slot stays as an outline so the column shows where the card will land. */}
      <div className={cx(isDragging && "invisible")}>
        <CardBody t={t} compact={compact} />
      </div>
      {isDragging ? <div className="border-ink-2/30 bg-hover/60 absolute inset-0 rounded-xl border border-dashed" aria-hidden="true" /> : null}
    </li>
  );
});

function ColumnView({
  col,
  cards,
  locked,
  dragging,
  target,
  onAdd,
  onWip,
  compact = false,
  collapsed = false,
  onCollapse,
  more = 0,
  onMore,
  lane,
  menu,
  phone = false,
  renaming = false,
  onRename,
  onRenameEnd,
  onStartRename,
}: {
  col: Column;
  cards: Card[];
  locked: boolean;
  dragging: boolean;
  target: boolean;
  onAdd: () => void;
  onWip?: () => void;
  compact?: boolean;
  collapsed?: boolean;
  onCollapse?: () => void;
  /** Cards matching the filters that are not loaded yet. */
  more?: number;
  onMore?: () => void;
  /** Inside a swimlane (its key): as tall as its cards, no own scroll, not a drop target. */
  lane?: string;
  /** The column's actions (rename, WIP, order, remove); swimlanes show only WIP and collapse. */
  menu?: MenuItem[];
  /** Below md one column shows at a time (picked in the column switcher): is it this one? */
  phone?: boolean;
  /** The name is an input (inline rename); `onRename` saves, `onRenameEnd` leaves without saving. */
  renaming?: boolean;
  onRename?: (name: string) => void;
  onRenameEnd?: () => void;
  /** Double-clicking the name renames the column (or says why it can't be renamed). */
  onStartRename?: () => void;
}) {
  const tx = useT();
  const { setNodeRef } = useDroppable({ id: lane !== undefined ? `${colId(col)}:lane:${lane}` : colId(col), disabled: lane !== undefined });
  // Reorder by dragging the header (or its grip). Swimlanes repeat every column, so they never reorder.
  const sort = useSortable({
    id: lane !== undefined ? `drag-col-lane:${lane}:${col.id}` : `${COL_DRAG}${col.id}`,
    disabled: lane !== undefined ? true : { draggable: renaming, droppable: false },
    data: { type: "column" },
  });
  // Phones show one column at a time: order changes there go through the menu (move left/right).
  const handle = (keys: boolean) =>
    lane !== undefined || !sort.listeners
      ? {}
      : Object.fromEntries(
          Object.entries(sort.listeners)
            .filter(([k]) => keys || k !== "onKeyDown")
            .map(([k, fn]) => [
              k,
              (e: React.SyntheticEvent) => {
                if (window.matchMedia("(min-width: 768px)").matches) (fn as (e: React.SyntheticEvent) => void)(e);
              },
            ]),
        );
  const moving = sort.transform ? { transform: `translate3d(${Math.round(sort.transform.x)}px, 0, 0)`, transition: sort.transition } : { transition: sort.transition };
  // At the WIP limit is fine (a quiet amber count); only going past it turns the count red. Never the whole column.
  const size = col.total ?? col.count;
  const atLimit = col.wipLimit !== null && size >= col.wipLimit;
  const over = col.wipLimit !== null && size > col.wipLimit;
  const items = menu ?? [
    ...(onWip ? [{ label: tx("work.board.gioi_han_wip_2"), onSelect: onWip }] : []),
    ...(onCollapse ? [{ label: tx("work.board.collapse"), onSelect: onCollapse }] : []),
  ];
  // A collapsed column is a slim strip on wide screens; on a phone the picked column always opens in full.
  // It is the column's drag node while collapsed (pointer only: Enter on it still expands the column).
  const strip = collapsed ? (
    <button
      type="button"
      ref={lane === undefined ? sort.setNodeRef : undefined}
      style={lane === undefined ? moving : undefined}
      {...handle(false)}
      onClick={onCollapse}
      aria-label={tx("work.board.expand", { name: col.name })}
      className={cx(
        "hover:bg-hover border-hairline flex w-10 shrink-0 flex-col items-center gap-2 rounded-lg border py-3 text-xs font-medium max-md:hidden",
        sort.isDragging && "border-ink-2/30 bg-hover/60 border-dashed *:invisible",
      )}
    >
      <span className="text-ink-2 text-xs tabular-nums">{col.count}</span>
      <span className="[writing-mode:vertical-rl]">{col.name}</span>
    </button>
  ) : null;
  if (collapsed && !phone) return strip;
  return (
    <>
      {strip}
      <section
        ref={(n) => {
          setNodeRef(n);
          if (!collapsed && lane === undefined) sort.setNodeRef(n);
        }}
        style={!collapsed && lane === undefined ? moving : undefined}
        aria-label={col.name}
        className={cx(
          // Each column is a visible lane (a tinted 12px surface on the white panel, 288px wide; the board
          // scrolls sideways) so the board reads as a board. `bg-lane` is that tone.
          "group/col flex shrink-0 flex-col rounded-[12px] p-2 transition-colors duration-150 max-md:w-full md:w-[288px]",
          phone ? (collapsed ? "md:hidden" : "") : "max-md:hidden",
          // Full-height lanes (not shrink-wrapped to their cards): an empty column is still an obvious drop target and the
          // board reads as a grid; cards scroll inside the lane.
          // The row measures where it starts (--lane-top, set by ScrollFade) because what sits above the board differs per
          // page; a column then ends 28px above the viewport edge, the page's side gutter, and the page does not scroll.
          lane !== undefined ? "min-h-24" : "max-md:min-h-[420px] md:h-[calc(100dvh-var(--lane-top,262px)-28px)] md:min-h-[420px]",
          target ? "bg-selected" : "bg-lane",
          // While dragging, the column's slot stays as an outline where it will land (the header floats as a preview).
          !collapsed && sort.isDragging && "outline-ink-2/30 bg-hover/60 outline-dashed outline-1 *:invisible",
        )}
      >
        {/* Its own layer above the cards: the actions' pop animation keeps a transform, which would otherwise trap the
          column menu under the (also transformed) sortable cards. Above z-10: a card's done check and assignee use it. */}
        <header className="relative z-20 flex h-9 select-none items-center gap-2 pl-1.5 pr-0.5 max-md:min-h-11" {...(collapsed ? {} : handle(true))}>
          {lane === undefined && !renaming ? (
            // The keyboard way to reorder (Space/Enter picks the column up, arrows move it); shows on hover or focus.
            <button
              type="button"
              ref={sort.setActivatorNodeRef}
              {...sort.attributes}
              aria-label={tx("work.board.dragColumn", { name: col.name })}
              className="text-ink-2 hover:text-ink focus-visible:ring-brand-text absolute -left-2 top-1/2 grid h-6 w-3.5 -translate-y-1/2 cursor-grab place-items-center rounded opacity-0 outline-none focus-visible:opacity-100 focus-visible:ring-2 group-hover/col:opacity-100 max-md:hidden"
            >
              <GripIcon className="size-3.5" />
            </button>
          ) : null}
          {renaming && onRename && onRenameEnd ? (
            <ColumnNameInput
              initial={col.name}
              label={tx("work.board.renameColumn")}
              onSave={onRename}
              onCancel={onRenameEnd}
              className="h-8 min-w-0 flex-1 text-[13px] font-medium"
            />
          ) : (
            // Phones: the column switcher above already names the column and its count.
            <h2
              className={cx("m-0 truncate text-[13px] font-semibold tracking-[-0.01em] max-md:sr-only", lane === undefined && "md:cursor-grab")}
              onDoubleClick={onStartRename}
              title={onStartRename ? tx("work.board.renameColumn") : undefined}
            >
              {col.name}
            </h2>
          )}
          <span
            className={cx(
              "bg-surface/80 ring-hairline inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-medium tabular-nums ring-1 ring-inset max-md:hidden",
              over ? "text-block" : atLimit ? "text-warn" : "text-ink-2",
            )}
            title={
              over
                ? tx("work.board.da_dat_gioi_han")
                : col.total !== undefined && col.total !== col.count
                  ? tx("work.board.countOf", { shown: col.count, total: col.total })
                  : col.wipLimit
                    ? tx("work.board.wipHint", { n: col.wipLimit })
                    : undefined
            }
          >
            {col.count}
            {col.total !== undefined && col.total !== col.count ? `/${col.total}` : ""}
            {/* The limit shows once it matters (reached or passed); at rest the header is just the count. */}
            {col.wipLimit && atLimit ? ` / ${col.wipLimit}` : ""}
          </span>
          {/* Column actions always show (muted): hidden until hover, nobody finds that columns can be renamed or
            removed. */}
          <span className={cx("ml-auto flex", renaming && "!hidden")}>
            <button
              type="button"
              onClick={onAdd}
              aria-label={tx("work.board.them_viec_vao", { p0: col.name })}
              className="text-ink-2 hover:bg-surface hover:text-ink grid size-7 place-items-center rounded-md max-md:size-11"
            >
              <PlusIcon className="size-4" />
            </button>
            {items.length ? (
              <Menu
                label={tx("work.board.tuy_chon_cot", { p0: col.name })}
                items={items}
                trigger={
                  <span className="text-ink-2 hover:bg-surface hover:text-ink grid size-7 place-items-center rounded-md max-md:size-11">
                    <MoreIcon className="size-4" />
                  </span>
                }
              />
            ) : null}
          </span>
        </header>
        <SortableContext items={cards.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          <ul className={cx("m-0 grid min-h-0 flex-1 list-none content-start overflow-y-auto p-0.5", compact ? "gap-1" : "gap-2")}>
            {cards.map((t) => (
              <SortableCard key={t.id} t={t} locked={locked} compact={compact} />
            ))}
            {more > 0 && onMore ? (
              <li>
                <button
                  type="button"
                  onClick={onMore}
                  className="text-ink-2 hover:bg-surface hover:text-ink w-full rounded-md px-2 py-1.5 text-xs font-medium max-md:min-h-11 max-md:text-[13px]"
                >
                  {tx("work.board.more", { count: more })}
                </button>
              </li>
            ) : null}
            {cards.length === 0 ? (
              <li className={cx("grid h-20 place-items-center rounded-xl border border-dashed text-xs", dragging ? "border-ink-2/40 text-ink" : "border-edge text-ink-2")}>
                {dragging ? tx("work.board.tha_vao_day") : tx("work.board.chua_co_viec")}
              </li>
            ) : null}
            {/* Right under the last card (not at the foot of a tall empty column). */}
            {!dragging ? (
              <li>
                <button
                  type="button"
                  onClick={onAdd}
                  className="text-ink-2 hover:bg-surface hover:text-ink flex min-h-8 w-full items-center gap-1.5 rounded-lg px-2 text-left text-[13px] max-md:min-h-11"
                >
                  <PlusIcon className="size-3.5" />
                  {tx("work.board.them_viec")}
                </button>
              </li>
            ) : null}
          </ul>
        </SortableContext>
      </section>
    </>
  );
}

/**
 * Kanban: drag/drop (lazy-loaded), WIP limits, filters, sorting, assignees and labels.
 * Dragging moves the card between columns live (the target column makes room) with a floating
 * preview; the drop is optimistic and the server decides: a refusal (WIP, conflict) snaps back.
 */
export default function Board({ initial, projects, lead, views }: { initial: BoardData; projects: Project[]; lead?: React.ReactNode; views?: React.ReactNode }) {
  const tx = useT();
  const dir = useDirectory();
  const [cols, setCols] = useState(initial.columns);
  // The server says whether column changes would be allowed (lead or project.edit); older answers lack it. The
  // column actions show to everyone (people learn they exist); for others they say who may use them.
  const canEditColumns = initial.project.canEdit ?? true;
  const forbid = (key: "columnAddForbidden" | "columnRenameForbidden" | "columnDeleteForbidden" | "columnEditForbidden") => setMsg(tx(`work.board.${key}`));
  const [msg, setMsg] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [f, setF] = useState<Filters>({});
  const [doneDays, setDoneDays] = useState(14);
  const [sort, setSort] = useState<"rank" | "priority" | "due">("rank");
  /** The new-task drawer: open (false = closed), and the column it was opened from (true = toolbar). */
  const [adding, setAdding] = useState<string | boolean>(false);
  // Column changes: the column being renamed inline, the inline "new column" field (where it shows), the delete dialog.
  const [renaming, setRenaming] = useState<string | null>(null);
  const [addingCol, setAddingCol] = useState<"phone" | "wide" | null>(null);
  const [deleting, setDeleting] = useState<Column | null>(null);
  const [wip, setWip] = useState<Column | null>(null);
  const [statusOf, setStatusOf] = useState<Column | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  // The column under the pointer (over a card or its empty space), highlighted while dragging.
  const [overStatus, setOverStatus] = useState<string | null>(null);
  const atStart = useRef<Column[] | null>(null);
  // A column drag that may not happen (no permission, filtered view): cancelled right after it starts.
  const blockedDrag = useRef(false);
  // The drag preview is `position: fixed`; the page's arrival animation leaves a transform on <main>, which would
  // make <main> its containing block and shift the preview by the sidebar's width. So it renders under <body>.
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  useEffect(() => setPortal(document.body), []);
  // Mouse drags after 6px; a finger drags after a short press, so swiping over cards still scrolls the column.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 6 } }),
    // Space picks a card or column up and drops it; Enter is left to open the focused card.
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates, keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space", "Enter"] } }),
  );
  // How the board looks is remembered per project: compact cards, collapsed columns, swimlanes.
  const pref = `wos_board_${initial.project.id}`;
  const [look, setLookRaw] = useState<{ compact: boolean; collapsed: string[]; group: "none" | "assignee" | "priority" }>({ compact: false, collapsed: [], group: "none" });
  useEffect(() => {
    try {
      const v = localStorage.getItem(pref);
      if (v) setLookRaw((l) => ({ ...l, ...JSON.parse(v) }));
    } catch {
      /* ignore */
    }
  }, [pref]);
  const setLook = (patch: Partial<typeof look>) =>
    setLookRaw((l) => {
      const n = { ...l, ...patch };
      try {
        localStorage.setItem(pref, JSON.stringify(n));
      } catch {
        /* ignore */
      }
      return n;
    });
  // The column a phone shows (below md); the first one until the person picks another.
  const [phoneColRaw, setPhoneColRaw] = useState<string | null>(null);
  const phoneCol = cols.some((c) => c.id === phoneColRaw) ? phoneColRaw : (cols[0]?.id ?? null);
  const toggleCollapse = (key: string) => setLook({ collapsed: look.collapsed.includes(key) ? look.collapsed.filter((x) => x !== key) : [...look.collapsed, key] });
  const labels = useMemo(() => [...new Set([...(f.label ? [f.label] : []), ...cols.flatMap((c) => c.tasks.flatMap((t) => t.labels))])].sort(), [cols, f.label]);
  const people = useMemo(() => [...new Set(cols.flatMap((c) => c.tasks.map((t) => t.assigneeId).filter(Boolean)))] as string[], [cols]);
  const query = (extra: Record<string, string | number> = {}) => {
    const qs = new URLSearchParams();
    if (q.trim()) qs.set("q", q.trim());
    for (const [k, v] of Object.entries({ ...f, doneDays, ...extra })) if (v !== undefined && v !== "") qs.set(k, String(v));
    return `work/projects/${initial.project.id}/board?${qs}`;
  };
  // Filters run on the server (thousands of cards): reload when they change, search after a pause.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    // A slower answer for an older filter must not overwrite a newer one.
    let live = true;
    const t = setTimeout(() => {
      api<BoardData>(query())
        .then((b) => live && setCols(b.columns))
        .catch(() => live && setMsg(tx("work.board.loadFailed")));
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, f, doneDays]);
  // A task edited in the peek dialog over this board calls router.refresh(): the server sends a new `initial`,
  // and the cards must follow it (status → column, priority, assignee) instead of keeping the first render.
  // With filters or a search on, `initial` is the unfiltered board, so ask again for the view on screen.
  const seen = useRef(initial);
  useEffect(() => {
    if (seen.current === initial) return;
    seen.current = initial;
    const filtered = !!q.trim() || Object.values(f).some((v) => v !== undefined && v !== "") || doneDays !== 14;
    if (!filtered) {
      setCols(initial.columns);
      return;
    }
    let live = true;
    api<BoardData>(query())
      .then((b) => live && setCols(b.columns))
      .catch(() => live && setMsg(tx("work.board.loadFailed")));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);
  const loadMore = async (c: Column) => {
    const b = await api<BoardData>(query({ column: c.id, offset: c.tasks.length }));
    const more = b.columns[0]?.tasks ?? [];
    setCols((cur) => cur.map((x) => (x.id === c.id ? { ...x, tasks: [...x.tasks, ...more.filter((m) => !x.tasks.some((t) => t.id === m.id))] } : x)));
  };
  // A filtered, re-sorted or grouped view is not the real order: dragging there would drop cards in surprising places.
  const filtering = Boolean(q || Object.values(f).some(Boolean)) || sort !== "rank" || look.group !== "none";
  const chip = (on: boolean) =>
    cx("h-7 rounded-md border px-2.5 text-xs font-medium", on ? "border-ink bg-ink text-surface" : "border-hairline bg-surface text-ink-2 hover:bg-hover hover:text-ink");
  const toggle = (k: keyof Filters, v: string) => setF((cur) => ({ ...cur, [k]: cur[k] === v ? undefined : v }));

  const view = (c: Column) => {
    const list = c.tasks;
    if (sort === "priority") return [...list].sort((a, b) => (PRIO_RANK[a.priority] ?? 9) - (PRIO_RANK[b.priority] ?? 9));
    if (sort === "due") return [...list].sort((a, b) => (a.dueAt ? Date.parse(a.dueAt) : Infinity) - (b.dueAt ? Date.parse(b.dueAt) : Infinity));
    return list;
  };
  // Swimlanes: one row of columns per assignee or priority.
  const lanes: { key: string; label: string }[] =
    look.group === "assignee"
      ? [...new Set(cols.flatMap((c) => c.tasks.map((t) => t.assigneeId ?? "")))]
          .sort((a, b) => (a ? dir.name(a) : "~").localeCompare(b ? dir.name(b) : "~"))
          .map((k) => ({ key: k, label: k ? dir.name(k) : tx("work.board.chua_giao") }))
      : look.group === "priority"
        ? (["urgent", "high", "medium", "low"] as const).map((k) => ({ key: k, label: tx(`work.board.prio_${k}`) }))
        : [];
  const inLane = (t: Card, key: string) => (look.group === "assignee" ? (t.assigneeId ?? "") === key : t.priority === key);
  const columnOf = (list: Column[], id: string) =>
    id.startsWith("col:") ? list.find((c) => id === colId(c) || id.startsWith(`${colId(c)}:lane:`)) : list.find((c) => c.tasks.some((t) => t.id === id));
  const activeCard = activeId && !isColDrag(activeId) ? (cols.flatMap((c) => c.tasks).find((t) => t.id === activeId) ?? null) : null;
  const colOfDrag = (id: string | number) => cols.find((c) => `${COL_DRAG}${c.id}` === String(id));
  const activeCol = activeId && isColDrag(activeId) && !blockedDrag.current ? (colOfDrag(activeId) ?? null) : null;
  const cardDragging = activeId !== null && !isColDrag(activeId);

  // Column actions: rename, the status it stands for, WIP, order, collapse, remove. A new column's status is what its
  // name says (the server decides; it can be changed from the column menu).
  const addColumn = async (name: string) => {
    setAddingCol(null);
    try {
      const c = await api<{ id: string; name: string; status: ColumnStatus; position: number; wipLimit: number | null }>(`work/projects/${initial.project.id}/columns`, {
        method: "POST",
        body: { name },
      });
      setCols((cur) => [...cur, { ...c, count: 0, total: 0, tasks: [] }]);
      setPhoneColRaw(c.id);
    } catch (e) {
      setMsg((e as { status?: number }).status === 403 ? tx("work.board.columnAddForbidden") : tx("work.board.chua_luu_duoc"));
    }
  };
  const renameColumn = async (c: Column, name: string) => {
    setRenaming(null);
    if (name === c.name) return;
    setCols((cur) => cur.map((x) => (x.id === c.id ? { ...x, name } : x)));
    try {
      await api(`work/projects/${initial.project.id}/columns/${c.id}`, { method: "PUT", body: { name } });
    } catch (e) {
      setCols((cur) => cur.map((x) => (x.id === c.id ? { ...x, name: c.name } : x)));
      setMsg((e as { status?: number }).status === 403 ? tx("work.board.columnRenameForbidden") : tx("work.board.chua_luu_duoc"));
    }
  };
  const move = async (c: Column, by: -1 | 1) => {
    const i = cols.findIndex((x) => x.id === c.id);
    const j = i + by;
    if (j < 0 || j >= cols.length) return;
    const next = [...cols];
    [next[i], next[j]] = [next[j]!, next[i]!];
    const before = cols;
    setCols(next);
    try {
      await api(`work/projects/${initial.project.id}/columns`, { method: "PUT", body: { ids: next.map((x) => x.id) } });
    } catch (e) {
      setCols(before);
      setMsg((e as { status?: number }).status === 403 ? tx("work.board.columnEditForbidden") : tx("work.board.chua_luu_duoc"));
    }
  };
  const columnMenu = (c: Column): MenuItem[] => {
    const i = cols.findIndex((x) => x.id === c.id);
    // Without project.edit only folding the column away is the viewer's own business; the rest stays listed (with a
    // lock) and says who may use it, so people know the board can be changed.
    const locked = !canEditColumns;
    const lock = locked ? { muted: true, icon: <LockIcon className="size-3.5" /> } : {};
    return [
      { label: tx("work.board.renameColumn"), ...lock, onSelect: () => (locked ? forbid("columnRenameForbidden") : setRenaming(c.id)) },
      { label: tx("work.board.columnStatus"), ...lock, onSelect: () => (locked ? forbid("columnEditForbidden") : setStatusOf(c)) },
      { label: tx("work.board.gioi_han_wip_2"), ...lock, onSelect: () => (locked ? forbid("columnEditForbidden") : setWip(c)) },
      ...(i > 0 ? [{ label: tx("work.board.moveLeft"), ...lock, onSelect: () => (locked ? forbid("columnEditForbidden") : void move(c, -1)) }] : []),
      ...(i < cols.length - 1 ? [{ label: tx("work.board.moveRight"), ...lock, onSelect: () => (locked ? forbid("columnEditForbidden") : void move(c, 1)) }] : []),
      { label: tx("work.board.collapse"), onSelect: () => toggleCollapse(c.id) },
      ...(cols.length > 1
        ? [
            locked
              ? { label: tx("work.board.deleteColumn"), ...lock, onSelect: () => forbid("columnDeleteForbidden") }
              : { label: tx("work.board.deleteColumn"), danger: true, onSelect: () => setDeleting(c) },
          ]
        : []),
    ];
  };

  // Column order: dragged by the header, saved as the full list; a refusal puts the columns back.
  const reorderColumns = async (fromId: string, toId: string) => {
    const from = cols.findIndex((c) => c.id === fromId);
    const to = cols.findIndex((c) => c.id === toId);
    if (from < 0 || to < 0 || from === to) return;
    const before = cols;
    const next = arrayMove(cols, from, to);
    setCols(next);
    try {
      await api(`work/projects/${initial.project.id}/columns`, { method: "PUT", body: { ids: next.map((x) => x.id) } });
    } catch (e) {
      setCols(before);
      setMsg((e as { status?: number }).status === 403 ? tx("work.board.columnEditForbidden") : tx("work.board.chua_luu_duoc"));
    }
  };
  const nameOf = (id: string | number) => {
    if (isColDrag(id)) return colOfDrag(id)?.name ?? "";
    return cols.flatMap((c) => c.tasks).find((t) => t.id === String(id))?.title ?? "";
  };
  const posOf = (id: string | number) => cols.findIndex((c) => `${COL_DRAG}${c.id}` === String(id)) + 1;
  const overName = (id: string | number) => columnOf(cols, String(id))?.name ?? "";
  // Screen reader announcements in the board's language (dnd-kit's defaults are English).
  const announcements: Announcements = {
    onDragStart: ({ active }) => (isColDrag(active.id) ? tx("work.board.dragColPick", { name: nameOf(active.id) }) : tx("work.board.dragCardPick", { title: nameOf(active.id) })),
    onDragOver: ({ active, over }) => {
      if (!over) return undefined;
      return isColDrag(active.id)
        ? tx("work.board.dragColOver", { name: nameOf(active.id), pos: posOf(over.id), total: cols.length })
        : tx("work.board.dragCardOver", { title: nameOf(active.id), column: overName(over.id) });
    },
    onDragEnd: ({ active, over }) => {
      if (isColDrag(active.id))
        return over
          ? tx("work.board.dragColDrop", { name: nameOf(active.id), pos: posOf(over.id), total: cols.length })
          : tx("work.board.dragColCancel", { name: nameOf(active.id) });
      return over ? tx("work.board.dragCardDrop", { title: nameOf(active.id), column: overName(over.id) }) : tx("work.board.dragCardCancel", { title: nameOf(active.id) });
    },
    onDragCancel: ({ active }) =>
      isColDrag(active.id) ? tx("work.board.dragColCancel", { name: nameOf(active.id) }) : tx("work.board.dragCardCancel", { title: nameOf(active.id) }),
  };

  const onDragStart = (e: DragStartEvent) => {
    atStart.current = cols;
    setMsg(null);
    if (isColDrag(e.active.id)) {
      // Reordering is shown to everyone; when it can't happen, say why and drop the column where it was.
      const why = !canEditColumns ? tx("work.board.columnEditForbidden") : filtering ? tx("work.board.columnMoveFiltered") : null;
      blockedDrag.current = why !== null;
      if (why) {
        setMsg(why);
        cancelDrag();
      }
    }
    setActiveId(String(e.active.id));
  };

  // Cross-column moves happen while dragging, so the target column opens a gap under the pointer.
  const onDragOver = ({ active, over }: DragOverEvent) => {
    if (isColDrag(active.id)) return;
    if (!over) {
      setOverStatus(null);
      return;
    }
    const id = String(active.id),
      overId = String(over.id);
    setOverStatus(columnOf(cols, overId)?.id ?? null);
    setCols((cur) => {
      const from = columnOf(cur, id),
        to = columnOf(cur, overId);
      if (!from || !to || from.id === to.id) return cur;
      const card = from.tasks.find((t) => t.id === id)!;
      const at = overId.startsWith("col:")
        ? to.tasks.length
        : Math.max(
            0,
            to.tasks.findIndex((t) => t.id === overId),
          );
      return cur.map((c) =>
        c.id === from.id
          ? { ...c, tasks: c.tasks.filter((t) => t.id !== id), count: c.count - 1, ...(c.total !== undefined ? { total: c.total - 1 } : {}) }
          : c.id === to.id
            ? {
                ...c,
                tasks: [...c.tasks.slice(0, at), card, ...c.tasks.slice(at)],
                count: c.count + 1,
                ...(c.total !== undefined ? { total: c.total + 1 } : {}),
              }
            : c,
      );
    });
  };

  const onDragEnd = async ({ active, over }: DragEndEvent) => {
    lastDragEnd = Date.now();
    setActiveId(null);
    setOverStatus(null);
    const start = atStart.current;
    atStart.current = null;
    if (isColDrag(active.id)) {
      const blocked = blockedDrag.current;
      blockedDrag.current = false;
      const from = colOfDrag(active.id);
      const to = over && isColDrag(over.id) ? colOfDrag(over.id) : undefined;
      if (!blocked && from && to) await reorderColumns(from.id, to.id);
      return;
    }
    if (!start) return;
    if (!over) {
      setCols(start);
      return;
    }
    const id = String(active.id),
      overId = String(over.id);
    const col = columnOf(cols, id);
    if (!col) {
      setCols(start);
      return;
    }
    // Same-column reorder (cross-column moves already happened in onDragOver).
    let tasks = col.tasks;
    if (!overId.startsWith("col:") && overId !== id && col.tasks.some((t) => t.id === overId)) {
      tasks = arrayMove(
        col.tasks,
        col.tasks.findIndex((t) => t.id === id),
        col.tasks.findIndex((t) => t.id === overId),
      );
    }
    const next = cols.map((c) => (c.id === col.id ? { ...c, tasks } : c));
    const origin = columnOf(start, id)!;
    const i = tasks.findIndex((t) => t.id === id);
    if (origin.id === col.id && origin.tasks.findIndex((t) => t.id === id) === i) {
      setCols(start);
      return;
    }
    // The card takes its new column's status right away (the server answers with the same).
    setCols(next.map((c) => (c.id === col.id ? { ...c, tasks: c.tasks.map((t) => (t.id === id && t.status !== "cancelled" ? { ...t, status: col.status } : t)) } : c)));
    const beforeId = tasks[i + 1]?.id ?? null;
    const afterId = tasks[i - 1]?.id ?? null;
    const task = origin.tasks.find((t) => t.id === id)!;
    try {
      const saved = await api<Card>(`work/tasks/${id}/move`, {
        method: "POST",
        body: { columnId: col.id, beforeId, afterId: beforeId ? null : afterId, expectedVersion: task.version },
      });
      setCols((cur) => cur.map((c) => ({ ...c, tasks: c.tasks.map((t) => (t.id === saved.id ? { ...t, ...saved } : t)) })));
    } catch (err) {
      setCols(start);
      const body = (err as { body?: { error?: string; message?: string } }).body;
      setMsg(
        body?.error === "wip_limit"
          ? (body.message ?? tx("work.board.cot_da_dat_gioi"))
          : body?.error === "conflict"
            ? tx("work.board.the_vua_duoc_nguoi")
            : tx("work.board.khong_di_chuyen_duoc"),
      );
    }
  };

  return (
    <>
      <div role="toolbar" aria-label={tx("work.board.toolbar")} className="mb-3 flex flex-wrap items-center gap-2">
        {lead ? <div className="flex min-w-0 items-center gap-2 max-sm:w-full">{lead}</div> : null}
        {filtering ? (
          <button
            type="button"
            className={cx(btnGhost, "text-ink-2 h-9 min-h-0 px-2.5")}
            onClick={() => {
              setQ("");
              setF({});
              setSort("rank");
              setLook({ group: "none" });
            }}
          >
            {tx("work.board.bo_loc")}
          </button>
        ) : null}
        <span className="ml-auto flex min-w-0 items-center gap-2">
          <SearchToggle value={q} onChange={setQ} label={tx("work.board.loc_the")} />
          <ToolbarPopover
            icon={<FilterIcon className="size-4" />}
            label={tx("work.board.filters")}
            count={[f.assignee, f.due, f.blocked, f.label, f.priority].filter(Boolean).length}
          >
            <div className="flex flex-wrap gap-1.5" role="group" aria-label={tx("work.board.quick")}>
              <button type="button" aria-pressed={f.assignee === "me"} className={chip(f.assignee === "me")} onClick={() => toggle("assignee", "me")}>
                {tx("work.board.cua_toi")}
              </button>
              <button type="button" aria-pressed={f.due === "overdue"} className={chip(f.due === "overdue")} onClick={() => toggle("due", "overdue")}>
                {tx("work.board.overdue")}
              </button>
              <button type="button" aria-pressed={f.due === "risk"} className={chip(f.due === "risk")} onClick={() => toggle("due", "risk")}>
                {tx("checkin.atRiskShort")}
              </button>
              <button type="button" aria-pressed={f.due === "week"} className={chip(f.due === "week")} onClick={() => toggle("due", "week")}>
                {tx("work.board.dueWeek")}
              </button>
              <button type="button" aria-pressed={f.blocked === "1"} className={chip(f.blocked === "1")} onClick={() => toggle("blocked", "1")}>
                {tx("work.board.blocked")}
              </button>
              <button type="button" aria-pressed={f.assignee === "none"} className={chip(f.assignee === "none")} onClick={() => toggle("assignee", "none")}>
                {tx("work.board.chua_giao")}
              </button>
            </div>
            <div className="border-hairline grid gap-1 border-t pt-2">
              <PopoverRow label={tx("work.board.nguoi_lam")}>
                <Picker
                  variant="button"
                  align="right"
                  label={tx("work.board.nguoi_lam")}
                  value={f.assignee && f.assignee !== "me" && f.assignee !== "none" ? f.assignee : ""}
                  onChange={(v) => setF((cur) => ({ ...cur, assignee: v || undefined }))}
                  options={[
                    { value: "", label: tx("work.board.moi_nguoi") },
                    ...people.filter((p) => p !== dir.me).map((p) => ({ value: p, label: dir.name(p), icon: <Avatar id={p} size="xs" /> })),
                  ]}
                />
              </PopoverRow>
              {labels.length ? (
                <PopoverRow label={tx("work.board.nhan")}>
                  <Picker
                    variant="button"
                    align="right"
                    label={tx("work.board.nhan")}
                    value={f.label ?? ""}
                    onChange={(v) => setF((cur) => ({ ...cur, label: v || undefined }))}
                    options={[{ value: "", label: tx("work.board.moi_nhan") }, ...labels.map((l) => ({ value: l, label: l }))]}
                  />
                </PopoverRow>
              ) : null}
              <PopoverRow label={tx("work.board.priority")}>
                <Picker
                  variant="button"
                  align="right"
                  label={tx("work.board.priority")}
                  value={f.priority ?? ""}
                  onChange={(v) => setF((cur) => ({ ...cur, priority: v || undefined }))}
                  options={[
                    { value: "", label: tx("work.board.anyPriority") },
                    ...(["urgent", "high", "medium", "low"] as const).map((k) => ({ value: k, label: tx(`work.board.prio_${k}`) })),
                  ]}
                />
              </PopoverRow>
            </div>
          </ToolbarPopover>
          <ToolbarPopover icon={<SettingsIcon className="size-4" />} label={tx("work.board.display")}>
            <div className="grid gap-1">
              <PopoverRow label={tx("work.board.groupBy")}>
                <Picker
                  variant="button"
                  align="right"
                  label={tx("work.board.groupBy")}
                  value={look.group}
                  onChange={(v) => setLook({ group: v as typeof look.group })}
                  options={[
                    { value: "none", label: tx("work.board.group_none") },
                    { value: "assignee", label: tx("work.board.nguoi_lam") },
                    { value: "priority", label: tx("work.board.priority") },
                  ]}
                />
              </PopoverRow>
              <PopoverRow label={tx("work.board.sap_xep")}>
                <Picker
                  variant="button"
                  align="right"
                  label={tx("work.board.sap_xep")}
                  value={sort}
                  onChange={(v) => setSort(v as typeof sort)}
                  options={[
                    { value: "rank", label: tx("work.board.thu_tu_thu_cong") },
                    { value: "priority", label: tx("work.board.uu_tien_cao_truoc") },
                    { value: "due", label: tx("work.board.han_gan_truoc") },
                  ]}
                />
              </PopoverRow>
              <PopoverRow label={tx("work.board.doneShow")}>
                <Picker
                  variant="button"
                  align="right"
                  label={tx("work.board.doneShow")}
                  value={String(doneDays)}
                  onChange={(v) => setDoneDays(Number(v))}
                  options={[
                    { value: "14", label: tx("work.board.done14") },
                    { value: "30", label: tx("work.board.done30") },
                    { value: "0", label: tx("work.board.doneAll") },
                  ]}
                />
              </PopoverRow>
            </div>
            <div className="border-hairline border-t pt-3">
              <Checkbox label={tx("work.board.compact")} checked={look.compact} onChange={(e) => setLook({ compact: e.target.checked })} />
            </div>
          </ToolbarPopover>
          {views}
          {/* Always shown: the "+" lane after the last column is often off screen, and a missing button read as "columns
            can't be changed" (user, 2026-11-05). When adding isn't possible right now, a click says why. */}
          <button
            type="button"
            className={cx(btn, "max-sm:w-9 max-sm:px-0", (!canEditColumns || filtering) && "opacity-60")}
            aria-disabled={!canEditColumns || filtering || undefined}
            aria-label={tx("work.board.addColumn")}
            title={!canEditColumns ? tx("work.board.columnAddForbidden") : filtering ? tx("work.board.addColumnFiltered") : tx("work.board.addColumn")}
            onClick={() => {
              if (!canEditColumns) return setMsg(tx("work.board.columnAddForbidden"));
              if (filtering) return setMsg(tx("work.board.addColumnFiltered"));
              const wide = window.matchMedia("(min-width: 768px)").matches;
              setAddingCol(wide ? "wide" : "phone");
              if (wide) requestAnimationFrame(() => document.getElementById("board-add-column")?.scrollIntoView({ behavior: "smooth", inline: "end", block: "nearest" }));
            }}
          >
            <PlusIcon className="size-4" />
            <span className="max-sm:hidden">{tx("work.board.addColumn")}</span>
          </button>
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
        <p className="bg-block-wash text-block mb-3 rounded-md px-3 py-2 text-sm" role="alert">
          {msg}
        </p>
      ) : null}
      {/* Phones: one full-width column at a time, picked here, instead of a board wider than the screen. */}
      <div role="group" aria-label={tx("work.board.columns")} className="mb-2 flex flex-wrap gap-1.5 md:hidden">
        {cols.map((c) => {
          const on = c.id === phoneCol;
          return (
            <button
              key={c.id}
              type="button"
              aria-pressed={on}
              onClick={() => setPhoneColRaw(c.id)}
              className={cx(
                "inline-flex min-h-11 items-center gap-1.5 rounded-md border px-3.5 text-sm",
                on ? "bg-brand text-on-brand border-transparent font-medium" : "border-edge bg-surface text-ink-2",
              )}
            >
              {c.name}
              <span className={cx("tabular-nums", on ? "text-on-brand/80" : "text-ink-2")}>{c.total ?? c.count}</span>
            </button>
          );
        })}
        {!filtering ? (
          addingCol === "phone" ? (
            <ColumnNameInput
              label={tx("work.board.addColumn")}
              placeholder={tx("work.board.columnNameHint")}
              onSave={(n) => void addColumn(n)}
              onCancel={() => setAddingCol(null)}
              className="min-h-11 w-full text-sm"
            />
          ) : (
            <button
              type="button"
              onClick={() => (canEditColumns ? setAddingCol("phone") : forbid("columnAddForbidden"))}
              aria-label={tx("work.board.addColumn")}
              aria-disabled={!canEditColumns || undefined}
              title={canEditColumns ? undefined : tx("work.board.columnAddForbidden")}
              className={cx("text-ink-2 border-edge grid size-11 place-items-center rounded-full border border-dashed", !canEditColumns && "opacity-60")}
            >
              <PlusIcon className="size-4" />
            </button>
          )
        ) : null}
      </div>
      <DndContext
        // A fixed id keeps the drag-and-drop accessibility ids the same on the server and in the browser.
        id={`board-${initial.project.id}`}
        sensors={sensors}
        collisionDetection={collision}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={(e) => void onDragEnd(e)}
        accessibility={{ announcements, screenReaderInstructions: { draggable: tx("work.board.dragHint") } }}
        onDragCancel={() => {
          blockedDrag.current = false;
          setActiveId(null);
          setOverStatus(null);
          if (atStart.current) setCols(atStart.current);
          atStart.current = null;
        }}
      >
        {lanes.length ? (
          <div className="grid gap-4 overflow-x-auto pb-2">
            {lanes.map((l) => {
              const n = cols.reduce((sum, c) => sum + c.tasks.filter((t) => inLane(t, l.key)).length, 0);
              if (!n) return null;
              return (
                <section key={l.key || "none"} aria-label={l.label} className="grid gap-2">
                  <h3 className="m-0 flex items-center gap-2 text-sm font-semibold">
                    {look.group === "assignee" && l.key ? <Avatar id={l.key} size="xs" /> : null}
                    {l.label}
                    <span className="text-ink-2 text-xs font-normal tabular-nums">{n}</span>
                  </h3>
                  <div className="flex items-start gap-3">
                    {cols.map((c) => (
                      <ColumnView
                        key={c.id}
                        lane={l.key}
                        col={c}
                        cards={view(c).filter((t) => inLane(t, l.key))}
                        locked
                        compact={look.compact}
                        dragging={false}
                        target={false}
                        onAdd={() => setAdding(c.id)}
                        onWip={() => (canEditColumns ? setWip(c) : forbid("columnEditForbidden"))}
                        phone={c.id === phoneCol}
                      />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        ) : (
          <ScrollFade className="flex items-stretch gap-3 overflow-x-auto pb-2 md:-mb-5">
            <SortableContext items={cols.map((c) => `${COL_DRAG}${c.id}`)} strategy={horizontalListSortingStrategy}>
              {cols.map((c) => (
                <ColumnView
                  key={c.id}
                  col={c}
                  cards={view(c)}
                  locked={filtering}
                  compact={look.compact}
                  collapsed={look.collapsed.includes(c.id)}
                  onCollapse={() => toggleCollapse(c.id)}
                  more={c.count - c.tasks.length}
                  onMore={() => void loadMore(c)}
                  dragging={cardDragging}
                  target={cardDragging && overStatus === c.id}
                  onAdd={() => setAdding(c.id)}
                  menu={columnMenu(c)}
                  phone={c.id === phoneCol}
                  renaming={renaming === c.id}
                  onRename={(n) => void renameColumn(c, n)}
                  onRenameEnd={() => setRenaming(null)}
                  onStartRename={() => (canEditColumns ? setRenaming(c.id) : forbid("columnRenameForbidden"))}
                />
              ))}
            </SortableContext>
            {!filtering ? (
              addingCol === "wide" ? (
                // The new column's name, typed where the column will appear.
                <div id="board-add-column" className="bg-lane w-[288px] shrink-0 self-start rounded-[12px] p-2 max-md:hidden">
                  <ColumnNameInput
                    label={tx("work.board.addColumn")}
                    placeholder={tx("work.board.columnNameHint")}
                    onSave={(n) => void addColumn(n)}
                    onCancel={() => setAddingCol(null)}
                    className="h-8 w-full text-[13px]"
                  />
                </div>
              ) : (
                // A slim "+" lane instead of a wide ghost column: four columns fit a laptop screen without a clipped edge.
                <button
                  type="button"
                  onClick={() => (canEditColumns ? setAddingCol("wide") : forbid("columnAddForbidden"))}
                  aria-label={tx("work.board.addColumn")}
                  aria-disabled={!canEditColumns || undefined}
                  title={canEditColumns ? tx("work.board.addColumn") : tx("work.board.columnAddForbidden")}
                  className={cx("text-ink-2 hover:bg-hover hover:text-ink grid h-10 w-10 shrink-0 place-items-center rounded-lg max-md:hidden", !canEditColumns && "opacity-60")}
                >
                  <PlusIcon className="size-4" />
                </button>
              )
            ) : null}
          </ScrollFade>
        )}
        {/* Rendered outside the scrolling board, so the card is never clipped or hidden behind a column. */}
        {portal
          ? createPortal(
              <DragOverlay dropAnimation={dropAnimation}>{activeCard ? <CardBody t={activeCard} lifted /> : activeCol ? <ColumnGhost col={activeCol} /> : null}</DragOverlay>,
              portal,
            )
          : null}
      </DndContext>
      {adding ? (
        <NewTaskDrawer projects={projects} defaultProject={initial.project.id} defaultColumn={typeof adding === "string" ? adding : null} onClose={() => setAdding(false)} />
      ) : null}
      {deleting ? (
        <DeleteColumn
          projectId={initial.project.id}
          cols={cols}
          col={deleting}
          onClose={() => setDeleting(null)}
          onDone={(next) => {
            setCols(next);
            setDeleting(null);
          }}
          onError={(m) => {
            setMsg(m);
            setDeleting(null);
          }}
        />
      ) : null}
      {statusOf ? (
        <ColumnStatusModal
          projectId={initial.project.id}
          col={statusOf}
          onClose={() => setStatusOf(null)}
          onSaved={(status) => {
            setCols((cs) => cs.map((c) => (c.id === statusOf.id ? { ...c, status, tasks: c.tasks.map((t) => (t.status === "cancelled" ? t : { ...t, status })) } : c)));
            setStatusOf(null);
          }}
        />
      ) : null}
      {wip ? (
        <WipModal
          projectId={initial.project.id}
          col={wip}
          onClose={() => setWip(null)}
          onSaved={(limit) => {
            setCols((cs) => cs.map((c) => (c.id === wip.id ? { ...c, wipLimit: limit } : c)));
            setWip(null);
          }}
        />
      ) : null}
    </>
  );
}

/** The floating preview of a column being reordered: its header on a lifted lane. */
function ColumnGhost({ col }: { col: Column }) {
  return (
    <div className="bg-lane lift w-[288px] cursor-grabbing rounded-[12px] p-2">
      <div className="flex h-9 items-center gap-2 pl-1.5 pr-0.5">
        <GripIcon className="text-ink-2 size-3.5 shrink-0" />
        <span className="truncate text-[13px] font-semibold tracking-[-0.01em]">{col.name}</span>
        <span className="bg-surface/80 ring-hairline text-ink-2 inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-medium tabular-nums ring-1 ring-inset">
          {col.total ?? col.count}
        </span>
      </div>
    </div>
  );
}

/** What a column stands for: the status its cards take. Changing it re-statuses the cards already in it. */
function ColumnStatusModal({ projectId, col, onClose, onSaved }: { projectId: string; col: Column; onClose: () => void; onSaved: (s: ColumnStatus) => void }) {
  const tx = useT();
  const { status: statusLabel } = useFormat();
  const [v, setV] = useState<ColumnStatus>(col.status);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    if (v === col.status) return onClose();
    try {
      await api(`work/projects/${projectId}/columns/${col.id}`, { method: "PUT", body: { status: v } });
      onSaved(v);
    } catch (e) {
      setError((e as { status?: number }).status === 403 ? tx("work.board.chi_nguoi_quan_ly") : tx("work.board.chua_luu_duoc"));
    }
  };
  return (
    <Modal
      title={tx("work.board.columnStatusTitle", { name: col.name })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btn} onClick={onClose}>
            {tx("work.board.huy")}
          </button>
          <button type="button" className={btnPrimary} onClick={() => void save()}>
            {tx("work.board.luu")}
          </button>
        </>
      }
    >
      <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
        <legend className="text-ink-2 mb-2 p-0 text-[13px]">{tx("work.board.columnStatusHint")}</legend>
        {COLUMN_STATUSES.map((s) => (
          <label key={s} className={cx("hover:bg-hover flex min-h-10 cursor-pointer items-center gap-3 rounded-lg px-2", v === s && "bg-hover")}>
            <input type="radio" name="column-status" value={s} checked={v === s} onChange={() => setV(s)} className="accent-[var(--color-ink)]" />
            <TaskStatusPill status={s} label={statusLabel(s) ?? s} />
          </label>
        ))}
        {v !== col.status && (col.total ?? col.count) > 0 ? (
          <p className="text-ink-2 m-0 mt-2 text-[13px]">{tx("work.board.columnStatusCards", { count: col.total ?? col.count, status: statusLabel(v) ?? v })}</p>
        ) : null}
        {error ? <p className="text-block m-0 mt-2 text-[13px]">{error}</p> : null}
      </fieldset>
    </Modal>
  );
}

function WipModal({ projectId, col, onClose, onSaved }: { projectId: string; col: Column; onClose: () => void; onSaved: (n: number | null) => void }) {
  const tx = useT();
  const [v, setV] = useState(col.wipLimit ? String(col.wipLimit) : "");
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    const limit = v.trim() ? Number(v) : null;
    if (limit !== null && (!Number.isInteger(limit) || limit < 1)) {
      setError(tx("work.board.nhap_so_nguyen_duong"));
      return;
    }
    try {
      await api(`work/projects/${projectId}/columns/${col.id}`, { method: "PUT", body: { wipLimit: limit } });
      onSaved(limit);
    } catch (e) {
      setError((e as { status?: number }).status === 403 ? tx("work.board.chi_nguoi_quan_ly") : tx("work.board.chua_luu_duoc"));
    }
  };
  return (
    <Modal
      title={tx("work.board.gioi_han_wip", { p0: col.name })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btn} onClick={onClose}>
            {tx("work.board.huy")}
          </button>
          <button type="button" className={btnPrimary} onClick={() => void save()}>
            {tx("work.board.luu")}
          </button>
        </>
      }
    >
      <Field label={tx("work.board.so_viec_toi_da")} hint={tx("work.board.gioi_han_so_viec")} error={error}>
        <input
          className={input}
          inputMode="numeric"
          value={v}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void save();
            }
          }}
          autoFocus
        />
      </Field>
    </Modal>
  );
}

/**
 * A column name typed in place (a new column, or a rename): Enter or leaving the field saves, Escape cancels. An empty
 * name cancels instead of saving.
 */
function ColumnNameInput({
  initial = "",
  label,
  placeholder,
  onSave,
  onCancel,
  className,
}: {
  initial?: string;
  label: string;
  placeholder?: string;
  onSave: (name: string) => void;
  onCancel: () => void;
  className?: string;
}) {
  const [v, setV] = useState(initial);
  const done = useRef(false);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    const name = v.trim();
    if (save && name) onSave(name);
    else onCancel();
  };
  return (
    <input
      className={cx(input, "px-2", className)}
      aria-label={label}
      placeholder={placeholder}
      value={v}
      maxLength={60}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === "Enter") {
          e.preventDefault();
          finish(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          finish(false);
        }
      }}
    />
  );
}

/** Remove a column after a confirmation; a column with cards first asks where they go (their status stays). */
function DeleteColumn({
  projectId,
  cols,
  col,
  onClose,
  onDone,
  onError,
}: {
  projectId: string;
  cols: Column[];
  col: Column;
  onClose: () => void;
  onDone: (cols: Column[]) => void;
  onError: (msg: string) => void;
}) {
  const tx = useT();
  const others = cols.filter((c) => c.id !== col.id);
  const [moveTo, setMoveTo] = useState(others[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const size = col.total ?? col.count;
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`work/projects/${projectId}/columns/${col.id}?moveTo=${encodeURIComponent(moveTo)}`, { method: "DELETE" });
      onDone(
        others.map((c) => (c.id === moveTo ? { ...c, tasks: [...c.tasks, ...col.tasks], count: c.count + col.count, total: (c.total ?? c.count) + (col.total ?? col.count) } : c)),
      );
    } catch (e) {
      const err = e as { status?: number; body?: { error?: string } };
      if (err.body?.error === "last_column") setError(tx("work.board.lastColumn"));
      else if (err.status === 403) onError(tx("work.board.columnDeleteForbidden"));
      else setError(tx("work.board.chua_luu_duoc"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={tx("work.board.deleteColumnTitle", { name: col.name })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btn} onClick={onClose}>
            {tx("work.board.huy")}
          </button>
          <button type="button" className={btnDanger} disabled={busy} onClick={() => void remove()}>
            {tx("work.board.deleteColumn")}
          </button>
        </>
      }
    >
      {size > 0 ? (
        <div className="grid gap-3">
          <p className="text-ink-2 m-0 text-sm">{tx("work.board.deleteColumnBody", { count: size })}</p>
          <FormField label={tx("work.board.moveCardsTo")} error={error}>
            <Picker variant="field" label={tx("work.board.moveCardsTo")} value={moveTo} onChange={setMoveTo} options={others.map((c) => ({ value: c.id, label: c.name }))} />
          </FormField>
        </div>
      ) : (
        <div className="grid gap-2">
          <p className="text-ink-2 m-0 text-sm">{tx("work.board.deleteColumnEmpty")}</p>
          {error ? (
            <p className="text-block m-0 text-sm" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      )}
    </Modal>
  );
}

/** A horizontal scroller that fades its right edge while more is hidden there, so a cut-off column reads as "scroll". */
function ScrollFade({ className, children }: { className: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setMore(el.scrollWidth - el.clientWidth - el.scrollLeft > 4);
    const place = () => {
      const top = `${Math.round(el.getBoundingClientRect().top + window.scrollY)}px`;
      if (el.style.getPropertyValue("--lane-top") !== top) el.style.setProperty("--lane-top", top);
    };
    check();
    place();
    el.addEventListener("scroll", check, { passive: true });
    const ro = new ResizeObserver(check);
    ro.observe(el);
    // The toolbar above can wrap or a banner appear: re-measure whenever the page above changes size.
    const above = new ResizeObserver(place);
    above.observe(document.body);
    return () => {
      el.removeEventListener("scroll", check);
      ro.disconnect();
      above.disconnect();
    };
  }, []);
  return (
    <div ref={ref} className={cx(className, more && "[mask-image:linear-gradient(to_right,black_calc(100%-48px),transparent)]")}>
      {children}
    </div>
  );
}
