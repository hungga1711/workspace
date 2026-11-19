"use client";

import { numberFormat } from "@/lib/intl";
import { INTL_TAG } from "@/lib/i18n/config";
import { CopyButton } from "@/components/ui/CopyButton";

import Link from "next/link";
import { useEffect, useRef, useState, type ComponentType } from "react";
import { api } from "@/lib/client";
import { useFormat, useLocale, useT } from "@/lib/i18n/client";
import { projectHref, taskHref } from "@/lib/links";
import { Avatar } from "@/lib/people";
import { topicLabel } from "@/lib/ai-labels";
import { btn, btnGhost, btnPrimary, btnSm, cx, textarea } from "@/lib/ui";
import { ProjectBadge } from "@/components/ui/ProjectBadge";
import { Segmented } from "@/components/ui/Segmented";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { compareOutcomes, MIN_COMPARE_SAMPLE } from "@/lib/metrics";
import {
  CalendarIcon,
  ChartIcon,
  ChevronRightIcon,
  CodeIcon,
  MegaphoneIcon,
  PencilIcon,
  RefreshIcon,
  SearchIcon,
  SendIcon,
  SparkleIcon,
  TranslateIcon,
  UsersIcon,
  WhiteboardIcon,
  InfoIcon,
} from "@/components/app/icons";

const KINDS = ["code", "writing", "analysis", "translation", "research", "sales", "hr", "design", "planning", "other"] as const;
type Kind = (typeof KINDS)[number];
const kindOf = (topic: string): Kind => ((KINDS as readonly string[]).includes(topic) ? (topic as Kind) : "other");

/** Per kind of work: its mark. */
const KIND: Record<Kind, { icon: ComponentType<{ className?: string }>; tone: string }> = {
  code: { icon: CodeIcon, tone: "bg-art-0-wash text-art-0-text" },
  writing: { icon: PencilIcon, tone: "bg-art-1-wash text-art-1-text" },
  analysis: { icon: ChartIcon, tone: "bg-art-6-wash text-art-6-text" },
  translation: { icon: TranslateIcon, tone: "bg-art-5-wash text-art-5-text" },
  research: { icon: SearchIcon, tone: "bg-art-2-wash text-art-2-text" },
  sales: { icon: MegaphoneIcon, tone: "bg-art-3-wash text-art-3-text" },
  hr: { icon: UsersIcon, tone: "bg-art-4-wash text-art-4-text" },
  design: { icon: WhiteboardIcon, tone: "bg-art-7-wash text-art-7-text" },
  planning: { icon: CalendarIcon, tone: "bg-sky-wash text-sky-text" },
  other: { icon: SparkleIcon, tone: "bg-selected text-ink-soft" },
};

export interface MyTask {
  id: string;
  code: string;
  title: string;
  dueAt: string | null;
  overdue: boolean;
  topic: string;
}
export interface TeamTask extends MyTask {
  assigneeId: string;
  assignee: string;
}
export interface TeamAdoption {
  people: number;
  using: number;
  regular: number;
  departments: { name: string | null; people: number; using: number }[];
  rows: { userId: string; displayName: string; department: string | null; conversations: number; aiTasks: number; level: 0 | 1 | 2 }[];
}
export interface AdoptionData {
  days: number;
  scope: "team" | "self";
  people: number;
  mine: MyTask[];
  teamTasks?: TeamTask[];
  team?: TeamAdoption;
  me: { assisted: number; week: number[]; conversations: number; tasks: number; helpful: number | null; topics: string[] };
}
interface Group {
  done: number;
  dated: number;
  onTime: number;
  cycleDays: number | null;
}
export interface ProjectTask {
  id: string;
  code: string;
  title: string;
  status: string;
  assigneeId: string | null;
  dueAt: string | null;
  completedAt: string | null;
  overdue: boolean;
  cycleDays: number | null;
  onTime: boolean | null;
  ai: { calls: number; people: number; firstAt: string } | null;
}
export interface ProjectAi {
  id: string;
  code: string;
  name: string;
  tasks: number;
  aiTasks: number;
  assisted: Group;
  other: Group;
  aiCalls: number;
  aiPeople: string[];
  list: ProjectTask[];
}
export interface ProjectsData {
  days: number;
  projects: ProjectAi[];
  total: { tasks: number; aiTasks: number; assisted: Group; other: Group };
}

const pct = (x: number) => Math.round(x * 100);
const askHref = (prompt: string, task?: string) => `/app/ai/ask?send=1&q=${encodeURIComponent(prompt)}${task ? `&task=${task}` : ""}`;

function useDays() {
  const locale = useLocale();
  const nf = numberFormat(INTL_TAG[locale], { maximumFractionDigits: 1 });
  return (n: number) => nf.format(n);
}

/**
 * AI › Áp dụng AI › Tổng quan: one hairline strip of the
 * three headline figures, then dense grouped lists (a grey group bar, 40px rows, figures right-aligned in columns) for
 * the projects (each opens into its tasks) and the tasks to do with AI, and a properties-style side column on how far
 * the team has taken AI. No cards or shadows: rules and type carry the page, colour only where a figure is good or bad.
 */
export function AdoptionView({
  data,
  projects,
  assistant,
  scored,
}: {
  data: AdoptionData;
  projects: ProjectsData | null;
  assistant: boolean;
  /** The scorecard above already gives the headline figures and the team (AiScorecard): only the lists show here. */
  scored?: boolean;
}) {
  const side = !scored || data.scope !== "team";
  return (
    <div className={cx("border-hairline bg-surface grid grid-cols-[minmax(0,1fr)] overflow-hidden rounded-xl border", side && "xl:grid-cols-[minmax(0,1fr)_18.5rem]")}>
      <div className="min-w-0">
        <Headline data={projects} noteOnly={scored} />
        <Projects data={projects} />
        <Suggestions data={data} assistant={assistant} />
      </div>
      {side ? <TeamPanel data={data} /> : null}
    </div>
  );
}

/** A Linear group bar: the group's name and count on a grey band, optional controls at the right. */
function GroupBar({ id, title, count, right, columns }: { id: string; title: string; count?: number; right?: React.ReactNode; columns?: React.ReactNode }) {
  return (
    <div className="bg-ground border-hairline flex min-h-9 items-center gap-2 border-y px-4 max-sm:px-3">
      {/* The title gives way (wraps) before the switch on the right does: a squeezed switch scrolled sideways (vi, 360px). */}
      <h2 id={id} className="text-ink m-0 flex min-w-0 items-center gap-x-2 py-1.5 text-[13px]/[1.3] font-medium">
        {title}
        {count !== undefined ? <span className="text-ink-2 font-normal tabular-nums">{count}</span> : null}
      </h2>
      <span className="min-w-0 flex-1" />
      {columns}
      {right ? <span className="shrink-0">{right}</span> : null}
    </div>
  );
}

/** Three figures in one strip, Linear's insight header: label, value, the two numbers behind it. */
function Headline({ data, noteOnly }: { data: ProjectsData | null; noteOnly?: boolean | undefined }) {
  const t = useT();
  const d = useDays();
  if (!data) return null;
  const { total } = data;
  // Each comparison needs MIN_COMPARE_SAMPLE tasks on both sides and always says how many it rests on.
  const { days, onTime } = compareOutcomes(total.assisted, total.other);
  const faster = days ? days.other - days.ai : null;
  const tooFew = (nAi: number, nOther: number) => t("aiHub.adoption.projects.notEnoughN", { ai: nAi, other: nOther, min: MIN_COMPARE_SAMPLE });
  const cells = [
    {
      label: t("aiHub.adoption.projects.share"),
      value: total.tasks ? `${pct(total.aiTasks / total.tasks)}%` : "–",
      note: t("aiHub.adoption.projects.shareNote", { ai: total.aiTasks, all: total.tasks }),
      good: false,
    },
    {
      label: t("aiHub.adoption.projects.faster"),
      value: faster !== null && faster > 0 ? t("aiHub.adoption.projects.days", { n: d(faster) }) : "–",
      note: days
        ? t("aiHub.adoption.projects.fasterNote", { ai: d(days.ai), other: d(days.other), nAi: days.nAi, nOther: days.nOther })
        : tooFew(total.assisted.done, total.other.done),
      good: faster !== null && faster > 0,
    },
    {
      label: t("aiHub.adoption.projects.onTime"),
      value: onTime ? `${onTime.ai - onTime.other > 0 ? "+" : ""}${onTime.ai - onTime.other} ${t("aiHub.adoption.projects.points")}` : "–",
      note: onTime
        ? t("aiHub.adoption.projects.onTimeNote", { ai: onTime.ai, other: onTime.other, nAi: onTime.nAi, nOther: onTime.nOther })
        : tooFew(total.assisted.dated, total.other.dated),
      good: !!onTime && onTime.ai > onTime.other,
    },
  ];
  return (
    <>
      <dl className={cx("divide-hairline m-0 grid grid-cols-3 divide-x", noteOnly && "hidden")} data-testid="ai-headline">
        {cells.map((c) => (
          <div key={c.label} className="min-w-0 px-4 py-3.5 max-sm:px-3">
            <dt className="text-ink-2 text-xs/4">{c.label}</dt>
            <dd className={cx("m-0 mt-1 text-xl font-semibold tabular-nums tracking-[-0.02em] max-sm:text-base", c.good ? "text-ok" : "text-ink")}>{c.value}</dd>
            <dd className="text-ink-2 m-0 mt-0.5 line-clamp-2 text-xs max-sm:hidden" title={c.note}>
              {c.note}
            </dd>
          </div>
        ))}
      </dl>
      {/* "Without AI" is only "not recorded": AI used where nothing records it (a desktop app, a phone) is unseen. */}
      <p className={cx("text-ink-2 border-hairline m-0 flex items-start gap-1.5 px-4 py-2 text-xs max-sm:px-3", !noteOnly && "border-t")}>
        <InfoIcon className="mt-px size-3.5 shrink-0" />
        <span>
          {t("aiHub.adoption.projects.recorded")}{" "}
          <Link href="/app/ai/adoption/how" className="text-ink-soft whitespace-nowrap">
            {t("aiHub.adoption.projects.how")}
          </Link>
        </span>
      </p>
    </>
  );
}

/** A 14px progress circle, Linear's project progress mark. */
function Pie({ value, className }: { value: number; className?: string }) {
  const p = Math.max(0, Math.min(1, value));
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={cx("size-3.5 shrink-0", className)}>
      <circle cx="8" cy="8" r="6.5" fill="none" strokeWidth="1.5" className="stroke-edge" />
      <circle cx="8" cy="8" r="3.25" fill="none" strokeWidth="6.5" pathLength={100} strokeDasharray={`${p * 100} 100`} transform="rotate(-90 8 8)" className="stroke-accent" />
    </svg>
  );
}

/** "1,6 / 4 ngày": the AI figure first and strong, the figure without AI after it in grey. */
function Pair({ ai, other, better }: { ai: string | null; other: string | null; better: boolean }) {
  return (
    <span className="tabular-nums">
      <span className={cx("font-medium", ai === null ? "text-ink-2" : better ? "text-ok" : "text-ink")}>{ai ?? "–"}</span>
      <span className="text-ink-2"> / {other ?? "–"}</span>
    </span>
  );
}

const COLS = "grid-cols-[minmax(0,1fr)_6.5rem_7rem_6.5rem_1.5rem] max-md:grid-cols-[minmax(0,1fr)_5.5rem_1.5rem]";

function Projects({ data }: { data: ProjectsData | null }) {
  const t = useT();
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section aria-labelledby="ai-projects" data-testid="ai-projects">
      <GroupBar
        id="ai-projects"
        title={t("aiHub.adoption.projects.title")}
        count={data?.projects.length}
        columns={
          <span aria-hidden="true" className={cx("text-ink-2 hidden w-[23.5rem] text-xs md:grid", "grid-cols-[6.5rem_7rem_6.5rem_1.5rem] gap-3")}>
            <span>{t("aiHub.adoption.projects.colAi")}</span>
            <span>{t("aiHub.adoption.projects.colDays")}</span>
            <span>{t("aiHub.adoption.projects.colOnTime")}</span>
            <span />
          </span>
        }
      />
      {!data ? (
        <LoadFailed what={t("aiHub.adoption.projects.title")} className="px-4 py-3" />
      ) : data.projects.length ? (
        <ul className="divide-divider m-0 list-none divide-y p-0">
          {data.projects.map((p) => (
            <ProjectRow key={p.id} p={p} open={open === p.id} onToggle={() => setOpen((o) => (o === p.id ? null : p.id))} />
          ))}
        </ul>
      ) : (
        <p className="text-ink-2 m-0 px-4 py-3 text-[13px]">{t("aiHub.adoption.projects.empty")}</p>
      )}
    </section>
  );
}

type TaskFilter = "all" | "ai" | "none";

function ProjectRow({ p, open, onToggle }: { p: ProjectAi; open: boolean; onToggle: () => void }) {
  const t = useT();
  const fmt = useFormat();
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [more, setMore] = useState(false);
  // A project has fewer tasks than the whole company: the same minimum applies, and the counts sit in the tooltip.
  const { days, onTime } = compareOutcomes(p.assisted, p.other);
  const a = days?.ai ?? null;
  const o = days?.other ?? null;
  const onA = onTime?.ai ?? null;
  const onO = onTime?.other ?? null;
  const sample = (nAi: number, nOther: number) => t("aiHub.adoption.projects.sampleTitle", { ai: nAi, other: nOther, min: MIN_COMPARE_SAMPLE });
  const list = p.list.filter((x) => (filter === "ai" ? x.ai : filter === "none" ? !x.ai : true));
  const shown = more ? list : list.slice(0, 8);
  const id = `pa-${p.id}`;
  return (
    <li className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={onToggle}
        className={cx(
          "hover:bg-hover/70 grid min-h-10 w-full cursor-pointer items-center gap-3 border-0 bg-transparent px-4 text-left text-[13px] transition-colors max-sm:px-3",
          COLS,
          open && "bg-hover/50",
        )}
      >
        <span className="flex min-w-0 items-center gap-2.5">
          <ProjectBadge id={p.id} name={p.name} size="sm" />
          <span className="text-ink truncate font-medium">{p.name}</span>
          <span className="text-ink-2 shrink-0 font-mono text-xs max-sm:hidden">{p.code}</span>
        </span>
        <span className="flex items-center gap-1.5 tabular-nums" title={t("aiHub.adoption.projects.shareNote", { ai: p.aiTasks, all: p.tasks })}>
          <Pie value={p.tasks ? p.aiTasks / p.tasks : 0} />
          <span className="text-ink">{p.aiTasks}</span>
          <span className="text-ink-2">/ {p.tasks}</span>
        </span>
        <span className="max-md:hidden" title={sample(p.assisted.done, p.other.done)}>
          <Pair ai={a === null ? null : fmt.daysShort(a)} other={o === null ? null : fmt.daysShort(o)} better={a !== null && o !== null && a < o} />
        </span>
        <span className="max-md:hidden" title={sample(p.assisted.dated, p.other.dated)}>
          <Pair ai={onA === null ? null : `${onA}%`} other={onO === null ? null : `${onO}%`} better={onA !== null && onO !== null && onA > onO} />
        </span>
        <ChevronRightIcon aria-hidden="true" className={cx("text-ink-2 size-4 justify-self-end transition-transform", open && "rotate-90")} />
      </button>
      {open ? (
        <div id={id} className="border-divider border-t">
          <div className="flex flex-wrap items-center gap-2 py-2 pl-11 pr-4 max-sm:pl-3">
            <Segmented
              size="sm"
              label={t("aiHub.adoption.projects.filter")}
              value={filter}
              onChange={(v) => {
                setFilter(v);
                setMore(false);
              }}
              options={[
                { value: "all", label: t("aiHub.adoption.projects.fAll"), count: p.list.length },
                { value: "ai", label: t("aiHub.adoption.projects.fAi"), count: p.list.filter((x) => x.ai).length },
                { value: "none", label: t("aiHub.adoption.projects.fNone"), count: p.list.filter((x) => !x.ai).length },
              ]}
            />
            <span className="text-ink-2 text-xs md:hidden">
              {t("aiHub.adoption.projects.colDays")}{" "}
              <Pair ai={a === null ? null : fmt.daysShort(a)} other={o === null ? null : fmt.daysShort(o)} better={a !== null && o !== null && a < o} />
            </span>
            <span className="flex-1" />
            <Link href={projectHref(p)} className="text-ink-soft text-xs">
              {t("aiHub.adoption.projects.openProject")}
            </Link>
          </div>
          <ul className="m-0 list-none p-0">
            {shown.map((x) => (
              <TaskLine key={x.id} x={x} />
            ))}
          </ul>
          {list.length > shown.length ? (
            <button type="button" className="text-ink-2 hover:text-ink block py-2 pl-11 text-xs max-sm:pl-3" onClick={() => setMore(true)}>
              {t("aiHub.adoption.projects.more", { count: list.length - shown.length })}
            </button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** One task of a project: status, code, title, AI help, who, and how it went, all on one 36px line. */
function TaskLine({ x }: { x: ProjectTask }) {
  const t = useT();
  const fmt = useFormat();
  const done = x.status === "done";
  return (
    <li className="hover:bg-hover/60 grid min-h-9 min-w-0 grid-cols-[minmax(0,1fr)_auto_auto_4.5rem] items-center gap-3 py-1 pl-11 pr-4 text-[13px] max-sm:grid-cols-[minmax(0,1fr)_auto] max-sm:pl-3">
      <span className="flex min-w-0 items-center gap-2.5">
        <span className="text-ink-2 w-12 shrink-0 font-mono text-xs max-sm:hidden">{x.code}</span>
        <Link href={taskHref(x)} className={cx("min-w-0 truncate no-underline hover:underline", done ? "text-ink-2" : "text-ink")}>
          {x.title}
        </Link>
      </span>
      <span className="max-sm:hidden">
        {x.ai ? (
          <span className="text-violet-text inline-flex items-center gap-1 text-xs tabular-nums" title={t("aiHub.adoption.projects.calls", { count: x.ai.calls })}>
            <SparkleIcon className="size-3.5" />
            {x.ai.calls}
          </span>
        ) : null}
      </span>
      <span className="max-sm:hidden">{x.assigneeId ? <Avatar id={x.assigneeId} size="xs" /> : null}</span>
      <span className={cx("text-right text-xs tabular-nums", done && x.onTime === false ? "text-block" : done ? "text-ink-soft" : x.overdue ? "text-block" : "text-ink-2")}>
        {done
          ? x.cycleDays !== null
            ? fmt.daysShort(x.cycleDays)
            : t("aiHub.adoption.projects.done")
          : x.overdue
            ? t("aiHub.adoption.now.overdue")
            : t("aiHub.adoption.projects.open")}
      </span>
    </li>
  );
}

/** The open tasks that should use AI, the reader's own or the team's, each with what AI does for that kind of work. */
function Suggestions({ data, assistant }: { data: AdoptionData; assistant: boolean }) {
  const t = useT();
  const team = data.teamTasks ?? [];
  const [who, setWho] = useState<"mine" | "team">(data.mine.length || !team.length ? "mine" : "team");
  const [all, setAll] = useState(false);
  const list: (MyTask & { assigneeId?: string })[] = who === "mine" ? data.mine : team;
  const rows = all ? list : list.slice(0, 8);
  return (
    <section aria-labelledby="ai-now">
      <GroupBar
        id="ai-now"
        title={t("aiHub.adoption.suggest.title")}
        count={list.length}
        right={
          team.length ? (
            <Segmented
              size="sm"
              label={t("aiHub.adoption.suggest.title")}
              value={who}
              onChange={(v) => {
                setWho(v);
                setAll(false);
              }}
              options={[
                { value: "mine", label: t("aiHub.adoption.suggest.mine"), count: data.mine.length },
                { value: "team", label: t("aiHub.adoption.suggest.team"), count: team.length },
              ]}
            />
          ) : null
        }
      />
      {rows.length ? (
        <ul className="divide-divider m-0 list-none divide-y p-0" data-testid="ai-now">
          {rows.map((x) => (
            <TaskRow key={x.id} task={x} assistant={assistant} assigneeId={x.assigneeId} />
          ))}
        </ul>
      ) : (
        <p className="text-ink-2 m-0 px-4 py-3 text-[13px]">{data.me.assisted ? t("aiHub.adoption.now.allAssisted") : t("aiHub.adoption.suggest.empty")}</p>
      )}
      {list.length > rows.length ? (
        <button type="button" className="text-ink-2 hover:text-ink border-divider block w-full border-t px-4 py-2 text-left text-xs" onClick={() => setAll(true)}>
          {t("aiHub.adoption.projects.more", { count: list.length - rows.length })}
        </button>
      ) : null}
    </section>
  );
}

type T = ReturnType<typeof useT>;
const prompt = (t: T, kind: Kind, task: string) => t(`aiHub.adoption.kind.${kind}.prompt`, { task });

/**
 * One open task as a Linear row: its kind's icon, code, title, what AI does for that kind (grey, after the title), who,
 * and "Tạo prompt". The prompt (the company AI's, or the kind's fixed one without AI) opens under the row to edit, copy
 * for any AI chat, or send to Hỏi đáp.
 */
function TaskRow({ task, assistant, assigneeId }: { task: MyTask; assistant: boolean; assigneeId?: string }) {
  const t = useT();
  const kind = kindOf(task.topic);
  const { icon: Icon, tone } = KIND[kind];
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const make = () => {
    if (!assistant) return setText(prompt(t, kind, `${task.code} "${task.title}"`));
    setBusy(true);
    api<{ prompt: string }>("ai/adoption/prompt", { method: "POST", body: { taskId: task.id } })
      .then((r) => setText(r.prompt))
      // The AI is busy or out of budget: the kind's own prompt still gets the person started.
      .catch(() => setText(prompt(t, kind, `${task.code} "${task.title}"`)))
      .finally(() => setBusy(false));
  };
  const opened = text !== null;
  useEffect(() => {
    if (opened) box.current?.focus({ preventScroll: true });
  }, [opened]);
  return (
    <li className="min-w-0">
      <div className="group/row hover:bg-hover/60 flex min-h-10 min-w-0 items-center gap-2.5 px-4 text-[13px] max-sm:px-3">
        <span aria-hidden="true" className={cx("grid size-5 shrink-0 place-items-center rounded-[5px]", tone)} title={topicLabel(t, kind)}>
          <Icon className="size-3" />
        </span>
        <span className="text-ink-2 w-12 shrink-0 font-mono text-xs max-sm:hidden">{task.code}</span>
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <Link href={taskHref(task)} className="text-ink shrink truncate no-underline hover:underline">
            {task.title}
          </Link>
          {kind !== "other" ? <span className="text-ink-2 min-w-0 flex-[2] truncate text-xs max-lg:hidden">{t(`aiHub.adoption.kind.${kind}.does`)}</span> : null}
        </span>
        {/* Phones: a red dot instead of the word, so the title keeps its room. */}
        {task.overdue ? (
          <>
            <span className="text-block shrink-0 text-xs max-sm:hidden">{t("aiHub.adoption.now.overdue")}</span>
            <span role="img" aria-label={t("aiHub.adoption.now.overdue")} title={t("aiHub.adoption.now.overdue")} className="bg-block size-1.5 shrink-0 rounded-full sm:hidden" />
          </>
        ) : null}
        {assigneeId ? <Avatar id={assigneeId} size="xs" /> : null}
        {opened ? (
          <button type="button" className={cx(btnGhost, btnSm, "shrink-0")} onClick={() => setText(null)}>
            {t("aiHub.adoption.now.close")}
          </button>
        ) : (
          <button
            type="button"
            className={cx(btn, btnSm, "shrink-0 md:opacity-0 md:focus-visible:opacity-100 md:group-hover/row:opacity-100")}
            disabled={busy}
            onClick={make}
            data-testid="ai-adoption-start"
            aria-label={t("aiHub.adoption.now.make")}
          >
            <SparkleIcon className="text-accent" />
            {/* Phones keep the room for the title: the button is its icon there. */}
            <span className="max-sm:hidden">{busy ? t("aiHub.adoption.now.making") : t("aiHub.adoption.now.make")}</span>
          </button>
        )}
      </div>
      {opened ? (
        <div className="grid gap-2 px-4 pb-3 pl-[4.75rem] max-sm:px-3">
          <textarea ref={box} className={cx(textarea, "min-h-28 text-[13px]")} value={text} onChange={(e) => setText(e.target.value)} aria-label={t("aiHub.adoption.prompt")} />
          <span className="flex flex-wrap gap-2">
            {assistant ? (
              <Link href={askHref(text, task.id)} className={cx(btnPrimary, btnSm, "no-underline")}>
                <SendIcon />
                {t("aiHub.adoption.now.send")}
              </Link>
            ) : null}
            <CopyButton text={text} primary={!assistant} copiedLabel={t("aiHub.adoption.copied")} label={t("aiHub.adoption.copy")} />
            {assistant ? (
              <button type="button" className={cx(btnGhost, btnSm)} disabled={busy} onClick={make}>
                <RefreshIcon />
                {busy ? t("aiHub.adoption.now.making") : t("aiHub.adoption.now.again")}
              </button>
            ) : null}
          </span>
        </div>
      ) : null}
    </li>
  );
}

const LEVEL = ["bg-accent", "bg-accent/40", "bg-edge"] as const;

/** A label over a properties group, as in Linear's side panel. */
const Label = ({ children }: { children: React.ReactNode }) => <h3 className="text-ink-2 m-0 mb-2 text-xs font-medium">{children}</h3>;

/** How far the team has taken AI, as a properties column: the share, the levels, departments, who leads, who has not started. */
function TeamPanel({ data }: { data: AdoptionData }) {
  const t = useT();
  const team = data.team;
  if (!team || data.scope !== "team" || !team.people) return <SelfPanel me={data.me} />;
  const levels = [team.regular, team.using - team.regular, team.people - team.using] as const;
  const top = team.rows.filter((r) => r.level).slice(0, 5);
  const none = team.rows.filter((r) => !r.level);
  return (
    <aside className="border-hairline grid content-start gap-6 border-l px-5 py-4 max-xl:border-l-0 max-xl:border-t max-sm:px-3" aria-labelledby="ai-team" data-testid="ai-team">
      <div>
        <h2 id="ai-team" className="text-ink m-0 text-[13px] font-medium">
          {t("aiHub.adoption.team.title")}
        </h2>
        <p className="m-0 mt-2 flex items-baseline gap-2">
          <span className="text-ink text-2xl font-semibold tabular-nums tracking-[-0.02em]">{pct(team.using / team.people)}%</span>
          <span className="text-ink-2 text-xs">{t("aiHub.adoption.team.using", { using: team.using, people: team.people })}</span>
        </p>
        <span className="mt-2.5 flex h-1.5 gap-px overflow-hidden rounded-full" aria-hidden="true">
          {levels.map((n, i) => (n ? <span key={i} className={cx("h-full", LEVEL[i])} style={{ width: `${(n / team.people) * 100}%` }} /> : null))}
        </span>
        <ul className="m-0 mt-2.5 grid list-none gap-1 p-0 text-[13px]">
          {(["regular", "sometimes", "none"] as const).map((k, i) => (
            <li key={k} className="flex items-center gap-2">
              <span aria-hidden="true" className={cx("size-2 rounded-[3px]", LEVEL[i])} />
              <span className="text-ink-soft min-w-0 flex-1 truncate">{t(`aiHub.adoption.team.level.${k}`)}</span>
              <span className="text-ink tabular-nums">{levels[i]}</span>
            </li>
          ))}
        </ul>
      </div>
      {team.departments.length > 1 ? (
        <div>
          <Label>{t("aiHub.adoption.team.departments")}</Label>
          <ul className="m-0 grid list-none gap-1 p-0 text-[13px]">
            {team.departments.map((x) => (
              <li key={x.name ?? ""} className="flex min-h-6 items-center gap-2">
                <Pie value={x.using / Math.max(1, x.people)} />
                <span className="text-ink min-w-0 flex-1 truncate">{x.name ?? t("aiHub.adoption.team.noDept")}</span>
                <span className="text-ink-2 text-xs tabular-nums">
                  {x.using}/{x.people}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {top.length ? (
        <div>
          <Label>{t("aiHub.adoption.team.top")}</Label>
          <ul className="m-0 grid list-none gap-1 p-0 text-[13px]">
            {top.map((r) => (
              <li key={r.userId} className="flex min-h-7 items-center gap-2" title={r.department ?? undefined}>
                <Avatar id={r.userId} name={r.displayName} size="xs" />
                <span className="text-ink min-w-0 flex-1 truncate">{r.displayName}</span>
                <span className="text-ink-2 text-xs tabular-nums" title={t("aiHub.adoption.team.countTitle")}>
                  {r.aiTasks ? t("aiHub.adoption.team.count", { conv: r.conversations, tasks: r.aiTasks }) : t("aiHub.adoption.team.chats", { count: r.conversations })}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {none.length ? (
        <div>
          <Label>{t("aiHub.adoption.team.notYet", { count: none.length })}</Label>
          <span className="flex flex-wrap gap-1">
            {none.slice(0, 16).map((r) => (
              <span key={r.userId} title={r.displayName}>
                <Avatar id={r.userId} name={r.displayName} size="xs" />
              </span>
            ))}
            {none.length > 16 ? <span className="text-ink-2 grid h-6 place-items-center px-1 text-xs">+{none.length - 16}</span> : null}
          </span>
        </div>
      ) : null}
    </aside>
  );
}

/** Someone who follows no team sees their own AI week instead. */
function SelfPanel({ me }: { me: AdoptionData["me"] }) {
  const t = useT();
  const { shortDate } = useFormat();
  const used = me.week.reduce((n, x) => n + x, 0);
  const top = Math.max(1, ...me.week);
  return (
    <aside className="border-hairline grid content-start gap-3 border-l px-5 py-4 max-xl:border-l-0 max-xl:border-t max-sm:px-3" aria-labelledby="ai-me">
      <h2 id="ai-me" className="text-ink m-0 text-[13px] font-medium">
        {t("aiHub.adoption.week.title")}
      </h2>
      <span className="flex h-12 items-end gap-1" aria-hidden="true">
        {me.week.map((n, i) => (
          <span
            key={i}
            title={t("aiHub.adoption.week.day", { date: shortDate(new Date(Date.now() - (6 - i) * 86400_000)), count: n })}
            className={cx("block flex-1 rounded-sm", n ? "bg-accent" : "bg-edge")}
            style={{ height: `${n ? Math.max(18, (n / top) * 100) : 8}%` }}
          />
        ))}
      </span>
      <ul className="text-ink-soft m-0 grid list-none gap-1 p-0 text-[13px]">
        <li>
          <b className="text-ink font-medium tabular-nums">{used}</b> {t("aiHub.adoption.week.unit", { count: used })}
        </li>
        <li>{t("aiHub.adoption.week.tasks", { count: me.tasks })}</li>
        {me.helpful !== null ? <li>{t("aiHub.adoption.week.helpful", { pct: pct(me.helpful) })}</li> : null}
      </ul>
    </aside>
  );
}
