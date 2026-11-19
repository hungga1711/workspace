"use client";

import { dateFormat, numberFormat } from "@/lib/intl";
import { PersonChip } from "@/components/chat/PersonTrigger";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { useLocale, useT } from "@/lib/i18n/client";
import { INTL_TAG, type Locale } from "@/lib/i18n/config";
import { deptTone } from "@/lib/identity";
import { Avatar, useDirectory } from "@/lib/people";
import { btn, btnPrimary, btnSm, card, chip, chipBlock, chipOk, chipWarn, cx, input } from "@/lib/ui";
import { Modal } from "@/components/ui/Modal";
import { Menu } from "@/components/ui/Menu";
import { Meter, type PartTone } from "@/components/ui/charts";
import { Segmented } from "@/components/ui/Segmented";
import { ReportPage } from "./report";
import { SlimEmpty, StatStrip } from "./progressUi";
import { Picker } from "@/components/ui/Picker";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BoardIcon,
  ChartIcon,
  ClockIcon,
  FlagIcon,
  CalendarIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  MoreIcon,
  PencilIcon,
  PlusIcon,
  TrashIcon,
  TrendIcon,
} from "@/components/app/icons";
import { HEALTH_DOT, reasonText, type Health, type HealthReason } from "@/lib/health";

export interface KeyResult {
  id: string;
  title: string;
  kind: "number" | "project";
  start: number;
  target: number;
  current: number;
  unit: string;
  /** Higher-is-better ("up") or lower-is-better ("down": p95 latency, days to hire). */
  direction?: "up" | "down";
  met?: boolean;
  projectId: string | null;
  projectName: string | null;
  done: number;
  total: number;
  progress: number;
  health?: Health;
  reason?: HealthReason | null;
}
export type { Health };
export interface Goal {
  id: string;
  title: string;
  ownerId: string;
  department: string | null;
  period: string;
  startsOn: string;
  endsOn: string;
  progress: number;
  expected: number;
  health: Health;
  /** Why it is not on track (the worst key result's reason), from the work module. */
  reason?: HealthReason | null;
  canEdit: boolean;
  keyResults: KeyResult[];
}
export interface GoalsData {
  period: string;
  periods: string[];
  canCreate: boolean;
  goals: Goal[];
}

const num = (n: number, locale: Locale) => numberFormat(INTL_TAG[locale]).format(n);
const DATED = /^D\/(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$/;
/** "3 thg 11 – 16 thg 11, 2026" for a dated period (a sprint, a campaign); the years are shown when they differ. */
function datedLabel(period: string, locale: Locale): string | null {
  const m = DATED.exec(period);
  if (!m) return null;
  const [from, to] = [new Date(`${m[1]}T00:00:00Z`), new Date(`${m[2]}T00:00:00Z`)];
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return period;
  const day = dateFormat(INTL_TAG[locale], { day: "numeric", month: "short", timeZone: "UTC" });
  const full = dateFormat(INTL_TAG[locale], { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  return from.getUTCFullYear() === to.getUTCFullYear() ? `${day.format(from)} – ${full.format(to)}` : `${full.format(from)} – ${full.format(to)}`;
}

/** The periods offered in the picker: the current quarter, the next one, and those that already have goals. */
function periodsAround(current: string, known: string[]) {
  const [q, y] = current.split("/") as [string, string];
  const n = Number(q.slice(1));
  const next = n === 4 ? `Q1/${Number(y) + 1}` : `Q${n + 1}/${y}`;
  return [...new Set([current, next, `N/${y}`, ...known])];
}

/** The mean of a figure over a set of goals (a department's row, the company's row). */
const avgOf = (gs: Goal[], k: "progress" | "expected") => (gs.length ? Math.round(gs.reduce((n, g) => n + g[k], 0) / gs.length) : 0);
const ORDER: Health[] = ["behind", "at_risk", "not_started", "on_track", "done"];
/** The state a group of goals reads as: its worst goal. */
const worstOf = (gs: Goal[]): Health => gs.reduce<Health>((w, g) => (ORDER.indexOf(g.health) < ORDER.indexOf(w) ? g.health : w), "done");
// Status: the bar takes the goal's colour, the chip says the word.
const FILL: Record<Health, PartTone> = { done: "ok", on_track: "ok", at_risk: "warn", behind: "block", not_started: "muted" };
const CHIP: Record<Health, string> = { done: chipOk, on_track: chipOk, at_risk: chipWarn, behind: chipBlock, not_started: chip };
// One row shape at every level: name · period (xl) · owner (lg) · status · bar with figure · action. Below lg (a
// tablet beside the sidebar) the bar takes its own line under the name, so names are never squeezed to a few letters.
const ROW =
  "grid grid-cols-[minmax(0,1fr)_auto_2rem] items-center gap-x-3 gap-y-2 lg:grid-cols-[minmax(0,1fr)_8.5rem_6.75rem_minmax(8rem,13rem)_2rem] xl:grid-cols-[minmax(0,1fr)_5.5rem_8.5rem_6.75rem_minmax(9rem,14rem)_2rem]";
const PERIOD = "max-xl:hidden";
const OWNER = "max-lg:hidden";
const BARCELL = "max-lg:order-last max-lg:col-span-3";

/**
 * Tiến độ › Mục tiêu: a list where every goal is a
 * row with its period, owner, a status chip and a bar in the status colour (a tick where it should be by now), nested
 * company → department → goal → key results; and a strategy map of the same goals as cards hanging from the company.
 */
export function GoalsView({ data }: { data: GoalsData }) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const [edit, setEdit] = useState<Goal | "new" | null>(null);
  const [view, setView] = useState<"list" | "map">("list");
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const [openGoal, setOpenGoal] = useState<string | null>(null);
  const groups = new Map<string, Goal[]>();
  for (const g of data.goals) groups.set(g.department ?? "", [...(groups.get(g.department ?? "") ?? []), g]);
  const count = (h: Health[]) => data.goals.filter((g) => h.includes(g.health)).length;
  const slug = (d: string) => `goals-${d ? d.toLowerCase().replace(/[^a-z0-9]+/g, "-") : "company"}`;
  const periodLabel = (p: string) => (p.startsWith("N/") ? t("goals.year", { year: p.slice(2) }) : (datedLabel(p, locale) ?? p));
  const toggleDept = (d: string) =>
    setClosed((prev) => {
      const next = new Set(prev);
      if (next.has(d)) next.delete(d);
      else next.add(d);
      return next;
    });
  // The company row's words: a chip per state that exists ("3 chậm"), never four zeros.
  const states = (
    [
      ["behind", count(["behind"])],
      ["at_risk", count(["at_risk"])],
      ["on_track", count(["on_track", "done"])],
      ["not_started", count(["not_started"])],
    ] as [Health, number][]
  ).filter(([, n]) => n > 0);
  const openFromMap = (g: Goal) => {
    setView("list");
    setClosed((prev) => {
      const next = new Set(prev);
      next.delete(g.department ?? "");
      return next;
    });
    setOpenGoal(g.id);
  };
  return (
    <ReportPage
      title={`${t("work.report.goals")} · ${periodLabel(data.period)}`}
      actions={
        <>
          {data.goals.length ? (
            <Segmented
              label={t("goals.view")}
              value={view}
              onChange={setView}
              options={[
                { value: "list", label: t("goals.viewList") },
                { value: "map", label: t("goals.viewMap") },
              ]}
            />
          ) : null}
          <Picker
            variant="button"
            label={t("goals.period")}
            prefix={`${t("goals.period")}:`}
            value={data.period}
            onChange={(v) => router.push(`/app/work/goals?period=${encodeURIComponent(v)}`)}
            options={periodsAround(data.period, data.periods).map((p) => ({ value: p, label: periodLabel(p) }))}
          />
          {data.canCreate ? (
            <button type="button" className={btnPrimary} onClick={() => setEdit("new")}>
              <PlusIcon className="size-4" />
              {t("goals.new")}
            </button>
          ) : null}
        </>
      }
    >
      {data.goals.length ? (
        // The period at a glance (Home's strip): how many goals, how many are behind or at risk, where the company is.
        <StatStrip
          label={t("goals.figures")}
          items={[
            { label: t("goals.tab"), value: data.goals.length, icon: <FlagIcon />, tone: "violet" },
            { label: t("goals.health.behind"), value: count(["behind"]), icon: <TrendIcon />, tone: "red", alert: count(["behind"]) > 0, quiet: !count(["behind"]) },
            { label: t("goals.health.at_risk"), value: count(["at_risk"]), icon: <ClockIcon />, tone: "tangerine", quiet: !count(["at_risk"]) },
            { label: t("follow.colProgress"), value: `${avgOf(data.goals, "progress")}%`, icon: <ChartIcon />, tone: "green" },
          ]}
        />
      ) : null}
      {!data.goals.length ? (
        <SlimEmpty
          icon={<FlagIcon />}
          tone="violet"
          title={t("goals.emptyTitle")}
          action={
            data.canCreate ? (
              <button type="button" className={cx(btnPrimary, btnSm)} onClick={() => setEdit("new")}>
                {t("goals.new")}
              </button>
            ) : undefined
          }
        >
          {t("goals.emptyBody")}
        </SlimEmpty>
      ) : view === "map" ? (
        <StrategyMap groups={groups} goals={data.goals} states={states} periodLabel={periodLabel} onOpen={openFromMap} />
      ) : (
        <section aria-label={t("goals.summary")} className={cx(card, "px-5 pb-2 pt-1 max-sm:px-4")}>
          {/* Column heads, once. */}
          <div className={cx(ROW, "text-ink-2 border-hairline border-b py-2 text-xs max-lg:hidden")} aria-hidden="true">
            <span>{t("goals.title")}</span>
            <span className={PERIOD}>{t("goals.period")}</span>
            <span className={OWNER}>{t("goals.owner")}</span>
            <span>{t("work.report.colStatus")}</span>
            <span>{t("follow.colProgress")}</span>
            <span />
          </div>
          {/* Root: the company. */}
          <div id="goals-figures" className={cx(ROW, "border-hairline scroll-mt-16 border-b py-3")}>
            {/* Below lg the status chips take their own row: beside the name they squeezed it to one letter at 390px. */}
            <span className="flex min-w-0 items-center gap-2.5 max-lg:col-span-3">
              <span className="bg-ink text-on-brand grid size-8 shrink-0 place-items-center rounded-[9px] text-xs font-semibold" aria-hidden="true">
                {t("goals.company").slice(0, 1)}
              </span>
              <span className="min-w-0">
                <span className="text-ink block truncate text-[15px] font-medium">{t("goals.company")}</span>
                <span className="text-ink-2 block text-xs tabular-nums">{t("goals.goalCount", { count: data.goals.length })}</span>
              </span>
            </span>
            <span className={cx(PERIOD, "text-ink-2 text-xs tabular-nums")}>{periodLabel(data.period)}</span>
            <span className={cx(OWNER, "flex -space-x-1.5")}>
              {[...new Set(data.goals.map((g) => g.ownerId))].slice(0, 4).map((id) => (
                <span key={id} className="ring-surface rounded-full ring-2">
                  <Avatar id={id} size="xs" />
                </span>
              ))}
            </span>
            <span className="flex flex-wrap gap-1 max-lg:col-span-3">
              {states.map(([h, n]) => (
                <span key={h} className={CHIP[h]}>
                  {n} {t(`goals.health.${h}`).toLowerCase()}
                </span>
              ))}
            </span>
            <span className={BARCELL}>
              <Bar value={avgOf(data.goals, "progress")} expected={avgOf(data.goals, "expected")} tone="progress" strong />
            </span>
            <span className="max-lg:hidden" />
          </div>
          <ul className="divide-hairline m-0 grid list-none grid-cols-[minmax(0,1fr)] divide-y p-0">
            {[...groups.entries()].map(([dept, goals]) => {
              const open = !closed.has(dept);
              const worst = worstOf(goals);
              return (
                <li key={dept} id={slug(dept)} className="scroll-mt-16 py-1">
                  <div className={cx(ROW, "hover:bg-hover -mx-2 rounded-md px-2")}>
                    <button type="button" aria-expanded={open} onClick={() => toggleDept(dept)} className="flex min-w-0 items-center gap-2 py-2 text-left">
                      <ChevronDownIcon className={cx("text-ink-2 size-4 shrink-0 transition-transform", !open && "-rotate-90")} />
                      <span
                        aria-hidden="true"
                        className={cx(
                          "grid size-6 shrink-0 place-items-center rounded-md text-xs font-semibold",
                          dept ? cx(deptTone(dept).wash, deptTone(dept).text) : "bg-selected text-ink-2",
                        )}
                      >
                        {dept ? Array.from(dept.trim())[0]?.toLocaleUpperCase("vi") : "•"}
                      </span>
                      <h3 className="m-0 line-clamp-2 text-sm font-medium">{dept || t("goals.company")}</h3>
                      <span className="text-ink-2 shrink-0 text-xs tabular-nums">{goals.length}</span>
                    </button>
                    <span className={cx(PERIOD, "text-ink-2 text-xs tabular-nums")} />
                    <span className={cx(OWNER, "flex -space-x-1.5")}>
                      {[...new Set(goals.map((g) => g.ownerId))].slice(0, 3).map((id) => (
                        <span key={id} className="ring-surface rounded-full ring-2">
                          <Avatar id={id} size="xs" />
                        </span>
                      ))}
                    </span>
                    <span>
                      <span className={CHIP[worst]}>{t(`goals.health.${worst}`)}</span>
                    </span>
                    <span className={BARCELL}>
                      <Bar value={avgOf(goals, "progress")} expected={avgOf(goals, "expected")} tone={FILL[worst]} />
                    </span>
                    <span />
                  </div>
                  {open ? (
                    <ul className="m-0 grid list-none grid-cols-[minmax(0,1fr)] p-0">
                      {goals.map((g) => (
                        <GoalRow
                          key={g.id}
                          goal={g}
                          period={periodLabel(g.period)}
                          open={openGoal === g.id}
                          onToggle={() => setOpenGoal(openGoal === g.id ? null : g.id)}
                          onEdit={() => setEdit(g)}
                        />
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {edit ? (
        <GoalDialog goal={edit === "new" ? null : edit} period={data.period} departments={[...new Set(data.goals.map((g) => g.department ?? ""))]} onClose={() => setEdit(null)} />
      ) : null}
    </ReportPage>
  );
}

/** A bar in the status colour with the figure beside it; the tick is where it should be by now. */
function Bar({ value, expected, tone, strong }: { value: number; expected: number; tone: PartTone; strong?: boolean }) {
  const t = useT();
  return (
    <span className="flex items-center gap-2.5">
      <span className="min-w-0 flex-1 [&>div]:h-2">
        <Meter value={value} marker={expected} tone={tone} label={t("goals.progressLabel", { progress: value, expected })} />
      </span>
      <span
        className={cx("w-9 shrink-0 text-right tabular-nums", strong ? "text-ink text-[15px] font-medium" : "text-ink text-[13px]")}
        title={t("work.report.expected", { pct: expected })}
      >
        {value}%
      </span>
    </span>
  );
}

/** A goal in the list: one row; open, the reason it is where it is and its key results underneath. */
function GoalRow({ goal: g, period, open, onToggle, onEdit }: { goal: Goal; period: string; open: boolean; onToggle: () => void; onEdit: () => void }) {
  const t = useT();
  const why = reasonText(t, g.reason);
  return (
    <li className="min-w-0" aria-label={g.title}>
      <div className={cx(ROW, "hover:bg-hover -mx-2 rounded-md px-2 pl-9")}>
        <button type="button" aria-expanded={open} onClick={onToggle} className="flex min-w-0 items-center gap-2 py-2.5 text-left">
          <ChevronDownIcon className={cx("text-ink-2 size-3.5 shrink-0 transition-transform", !open && "-rotate-90")} />
          <span className="text-ink line-clamp-2 text-sm xl:truncate" title={g.title}>
            {g.title}
          </span>
        </button>
        <span className={cx(PERIOD, "text-ink-2 text-xs tabular-nums")}>{period}</span>
        <span className={cx(OWNER, "flex min-w-0")}>
          <PersonChip userId={g.ownerId} nameClassName="text-ink-2 text-xs" />
        </span>
        <span>
          <span className={CHIP[g.health]} title={why ?? undefined}>
            {t(`goals.health.${g.health}`)}
          </span>
        </span>
        <span className={BARCELL}>
          <Bar value={g.progress} expected={g.expected} tone={FILL[g.health]} />
        </span>
        {g.canEdit ? (
          <Menu
            label={t("ui.more")}
            trigger={
              <span className="text-ink-2 hover:bg-selected grid size-7 place-items-center justify-self-end rounded-md [&_svg]:size-4">
                <MoreIcon />
              </span>
            }
            items={[{ label: t("goals.edit"), icon: <PencilIcon />, onSelect: onEdit }]}
          />
        ) : (
          <span />
        )}
      </div>
      {open ? (
        <div className="grid gap-2 pb-3 pl-[3.75rem] pt-1 max-md:pl-6">
          {why ? <p className="text-ink-2 m-0 text-xs">{why}</p> : null}
          <ul className="m-0 grid list-none grid-cols-[minmax(0,1fr)] gap-1.5 p-0">
            {g.keyResults.map((k) => (
              <KeyResultRow key={k.id} kr={k} canEdit={g.canEdit} />
            ))}
          </ul>
        </div>
      ) : null}
    </li>
  );
}

/**
 * The strategy map: the company at the top, departments hanging from one rail, each department's goals as cards
 * under it. A card opens the goal in the list.
 */
function StrategyMap({
  groups,
  goals,
  states,
  periodLabel,
  onOpen,
}: {
  groups: Map<string, Goal[]>;
  goals: Goal[];
  states: [Health, number][];
  periodLabel: (p: string) => string;
  onOpen: (g: Goal) => void;
}) {
  const t = useT();
  const dir = useDirectory();
  return (
    <section aria-label={t("goals.viewMap")} className="grid grid-cols-[minmax(0,1fr)] justify-items-center">
      <div className={cx(card, "grid w-full max-w-sm gap-3 p-4")}>
        <span className="flex items-center gap-2.5">
          <span className="bg-ink text-on-brand grid size-8 shrink-0 place-items-center rounded-[9px] text-xs font-semibold" aria-hidden="true">
            {t("goals.company").slice(0, 1)}
          </span>
          <span className="min-w-0">
            <span className="text-ink block truncate text-[15px] font-medium">{t("goals.company")}</span>
            <span className="text-ink-2 block text-xs tabular-nums">{t("goals.goalCount", { count: goals.length })}</span>
          </span>
        </span>
        <span className="flex flex-wrap gap-1">
          {states.map(([h, n]) => (
            <span key={h} className={CHIP[h]}>
              {n} {t(`goals.health.${h}`).toLowerCase()}
            </span>
          ))}
        </span>
        <Bar value={avgOf(goals, "progress")} expected={avgOf(goals, "expected")} tone="progress" strong />
      </div>
      <span className="bg-hairline block h-6 w-px" aria-hidden="true" />
      {/* One rail across the top; a tick from it to every department. */}
      <ul className="border-hairline m-0 grid w-full list-none grid-cols-[repeat(auto-fit,minmax(15rem,1fr))] gap-x-3 border-t p-0">
        {[...groups.entries()].map(([dept, dgoals]) => {
          const worst = worstOf(dgoals);
          return (
            <li key={dept} className="before:bg-hairline relative grid content-start gap-2 pt-6 before:absolute before:left-1/2 before:top-0 before:h-6 before:w-px">
              <div className={cx(card, "grid gap-2.5 p-3")}>
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className={cx(
                      "grid size-6 shrink-0 place-items-center rounded-md text-xs font-semibold",
                      dept ? cx(deptTone(dept).wash, deptTone(dept).text) : "bg-selected text-ink-2",
                    )}
                  >
                    {dept ? Array.from(dept.trim())[0]?.toLocaleUpperCase("vi") : "•"}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{dept || t("goals.company")}</span>
                  <span className={CHIP[worst]}>{t(`goals.health.${worst}`)}</span>
                </span>
                <Bar value={avgOf(dgoals, "progress")} expected={avgOf(dgoals, "expected")} tone={FILL[worst]} />
              </div>
              <ul className="border-hairline m-0 ml-4 grid list-none grid-cols-[minmax(0,1fr)] gap-2 border-l p-0 pl-3">
                {dgoals.map((g) => (
                  <li key={g.id} className="before:bg-hairline relative before:absolute before:-left-3 before:top-6 before:h-px before:w-3">
                    <button type="button" onClick={() => onOpen(g)} className={cx(card, "hover:bg-hover grid w-full gap-2.5 p-3 text-left transition-colors")}>
                      <span className="text-ink line-clamp-2 text-sm font-medium leading-snug">{g.title}</span>
                      <span className="flex items-center gap-2 text-xs">
                        <Avatar id={g.ownerId} name={dir.name(g.ownerId)} size="xs" />
                        <span className="text-ink-2 min-w-0 flex-1 truncate">{dir.name(g.ownerId)}</span>
                        <span className="text-ink-2 shrink-0 tabular-nums">{periodLabel(g.period)}</span>
                      </span>
                      <span className="flex items-center gap-2">
                        <span className={CHIP[g.health]}>{t(`goals.health.${g.health}`)}</span>
                        <span className="min-w-0 flex-1">
                          <Bar value={g.progress} expected={g.expected} tone={FILL[g.health]} />
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function KeyResultRow({ kr, canEdit }: { kr: KeyResult; canEdit: boolean }) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(kr.current));
  const save = async () => {
    await api(`work/key-results/${kr.id}`, { method: "PATCH", body: { current: Number(value) } });
    setEditing(false);
    router.refresh();
  };
  const flagged = kr.health === "at_risk" || kr.health === "behind";
  const why = flagged ? reasonText(t, kr.reason) : null;
  const unit = kr.unit ? ` ${kr.unit}` : "";
  // "mục tiêu ≤300 ms": the target with its direction, so 520/300 never reads as 173%.
  const target = t(kr.direction === "down" ? "goals.targetDown" : "goals.targetUp", { value: `${num(kr.target, locale)}${unit}` });
  // One line, "1.000 / ≥2.000 triệu": the value, then the target with its direction in quiet ink.
  const figure = (
    <span className="inline-flex items-baseline gap-1 whitespace-nowrap tabular-nums leading-tight">
      <span className="text-ink">
        {num(kr.current, locale)}
        {unit}
      </span>
      <span className="text-ink-2 text-xs">{kr.met ? t("goals.met") : target}</span>
    </span>
  );
  return (
    // Phones: the name takes its own line and the bar and figure sit under it; beside them it was cut to "Organ…".
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 text-sm sm:grid-cols-[minmax(0,1fr)_4rem_auto] sm:gap-y-0">
      <span className="min-w-0 max-sm:col-span-2" title={why ? `${kr.title} · ${why}` : kr.title}>
        <span className="flex items-center gap-1.5">
          {flagged ? <span className={cx("size-1.5 shrink-0 rounded-full", HEALTH_DOT[kr.health!])} aria-hidden="true" /> : null}
          <span className="truncate">{kr.title}</span>
        </span>
        {flagged ? <span className="sr-only">{why ?? t(`goals.health.${kr.health!}`)}</span> : null}
      </span>
      <span className="bg-progress-track block h-1.5 overflow-hidden rounded-full" aria-hidden="true">
        <span
          className={cx(
            "block h-full rounded-full",
            kr.health === "behind" ? "bg-block" : kr.health === "at_risk" ? "bg-warn-fill" : kr.met || kr.health === "done" ? "bg-ok-fill" : "bg-progress",
          )}
          style={{ width: `${kr.progress}%` }}
        />
      </span>
      {kr.kind === "number" ? (
        editing ? (
          <form
            className="flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <input
              autoFocus
              aria-label={t("goals.newValue", { title: kr.title })}
              className={cx(input, "tabular-nums", "h-7 min-h-0 w-24 px-2 text-xs")}
              inputMode="decimal"
              value={value}
              onChange={(e) => setValue(e.target.value.replace(/[^\d.,-]/g, "").replace(",", "."))}
            />
            <button type="submit" className={cx(btnPrimary, btnSm)}>
              {t("common.save")}
            </button>
          </form>
        ) : canEdit ? (
          <button
            type="button"
            className="hover:bg-hover -mr-1.5 inline-flex min-h-7 items-center justify-end rounded-md px-1.5 text-right text-xs"
            onClick={() => setEditing(true)}
            aria-label={t("goals.update", { title: kr.title })}
            title={t("goals.updateShort")}
          >
            {figure}
          </button>
        ) : (
          <span className="text-right text-xs">{figure}</span>
        )
      ) : kr.projectId ? (
        <Link
          href={`/app/work/projects/${kr.projectId}`}
          className="text-ink-2 hover:text-ink inline-flex min-h-7 items-center justify-end text-right text-xs tabular-nums no-underline hover:underline"
        >
          {t("goals.projectTasks", { done: kr.done, total: kr.total })}
        </Link>
      ) : (
        <span className="text-ink-2 text-right text-xs tabular-nums">{kr.progress}%</span>
      )}
    </li>
  );
}

interface KrDraft {
  id?: string;
  title: string;
  kind: "number" | "project";
  start: string;
  target: string;
  unit: string;
  direction: "up" | "down";
  /** Someone picked the direction; until then it follows the numbers (a target below the start = lower-is-better). */
  dirTouched: boolean;
  projectId: string;
}
interface ProjectOption {
  id: string;
  name: string;
  doneTasks: number;
  totalTasks: number;
}

const blankKr = (): KrDraft => ({ title: "", kind: "number", start: "0", target: "100", unit: "%", direction: "up", dirTouched: false, projectId: "" });
const OTHER_DEPT = "__other";

/** The dates a period code stands for (mirrors periodRange on the server): the first day and the last day, inclusive. */
function periodDates(period: string): { from: Date; to: Date; starts: number; ends: number } {
  const [p, y, z] = period.split("/") as [string, string, string?];
  if (p === "D") {
    const starts = Date.parse(`${y}T00:00:00Z`);
    const to = Date.parse(`${z}T00:00:00Z`);
    return { from: new Date(starts), to: new Date(to), starts, ends: to + 86_400_000 };
  }
  const year = Number(y);
  const [month, months] = p === "N" ? [0, 12] : p.startsWith("H") ? [(Number(p[1]) - 1) * 6, 6] : [(Number(p[1]) - 1) * 3, 3];
  const starts = Date.UTC(year, month, 1);
  const ends = Date.UTC(year, month + months, 1);
  return { from: new Date(starts), to: new Date(ends - 86_400_000), starts, ends };
}

/**
 * The period as a grid, not a code in a dropdown: a year stepper, then the four quarters, the two halves and the
 * full year as radio chips, with the dates the choice stands for and how much of it has already gone, since that
 * share is what the goal's pace is judged against.
 */
function PeriodPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const t = useT();
  const locale = useLocale();
  const dated = DATED.exec(value);
  const [year, setYear] = useState(dated ? new Date().getFullYear() : Number(value.split("/")[1]));
  const now = Date.now();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  // "Tuỳ chọn" starts as the next two weeks: a sprint's shape, edited from there.
  const custom = () => onChange(`D/${iso(new Date())}/${iso(new Date(now + 13 * 86_400_000))}`);
  const setDates = (from: string, to: string) => onChange(`D/${from}/${to}`);
  const cur = `Q${Math.floor(new Date().getMonth() / 3) + 1}/${new Date().getFullYear()}`;
  const fmt = dateFormat(INTL_TAG[locale], { day: "numeric", month: "short", timeZone: "UTC" });
  const { from, to, starts, ends } = periodDates(value);
  const gone = Math.max(0, Math.min(100, Math.round(((now - starts) / (ends - starts)) * 100)));
  const state = now < starts ? t("goals.form.notStarted") : now >= ends ? t("goals.form.ended") : t("goals.form.elapsed", { pct: gone });
  const valid = !dated || (Number.isFinite(starts) && Number.isFinite(ends) && ends > starts);
  const rows: { code: string; label: string }[][] = [
    [1, 2, 3, 4].map((n) => ({ code: `Q${n}/${year}`, label: `Q${n}` })),
    [
      { code: `H1/${year}`, label: t("goals.form.h1") },
      { code: `H2/${year}`, label: t("goals.form.h2") },
    ],
    [{ code: `N/${year}`, label: t("goals.form.fullYear") }],
  ];
  const chip = (on: boolean) =>
    cx(
      "inline-flex min-h-8 items-center justify-center gap-1 rounded-md px-3 text-sm transition-colors max-md:min-h-10",
      on ? "bg-brand text-on-brand font-medium" : "shadow-[0_0_0_1px_var(--hairline)] hover:bg-hover",
    );
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="inline-flex items-center gap-1" role="group" aria-label={t("goals.form.year")}>
          <button type="button" className="hover:bg-hover grid size-8 place-items-center rounded-md" aria-label={t("goals.form.prevYear")} onClick={() => setYear(year - 1)}>
            <ChevronLeftIcon className="size-4" />
          </button>
          <span className="min-w-12 text-center text-sm font-semibold tabular-nums">{year}</span>
          <button type="button" className="hover:bg-hover grid size-8 place-items-center rounded-md" aria-label={t("goals.form.nextYear")} onClick={() => setYear(year + 1)}>
            <ChevronRightIcon className="size-4" />
          </button>
        </div>
        <div role="radiogroup" aria-label={t("goals.period")} className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {rows.map((row, i) => (
            <div key={i} className="flex flex-wrap gap-1.5">
              {row.map((o) => {
                const on = o.code === value;
                return (
                  <button key={o.code} type="button" role="radio" aria-checked={on} className={chip(on)} onClick={() => onChange(o.code)}>
                    {o.label}
                    {o.code === cur ? <span aria-label={t("goals.form.current")} className={cx("size-1.5 rounded-full", on ? "bg-on-brand" : "bg-brand")} /> : null}
                  </button>
                );
              })}
            </div>
          ))}
          <button type="button" role="radio" aria-checked={!!dated} className={chip(!!dated)} onClick={() => (dated ? undefined : custom())}>
            <CalendarIcon className="size-3.5" />
            {t("goals.form.custom")}
          </button>
        </div>
      </div>
      {dated ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-2 text-sm">
          <span className="text-ink-2">{t("goals.form.fromDate")}</span>
          <input type="date" className={cx(input, "w-40!")} aria-label={t("goals.form.fromDate")} value={dated[1]} onChange={(e) => setDates(e.target.value, dated[2]!)} />
          <span className="text-ink-2">{t("goals.form.toDate")}</span>
          <input
            type="date"
            className={cx(input, "w-40!")}
            aria-label={t("goals.form.toDate")}
            aria-invalid={!valid || undefined}
            min={dated[1]}
            value={dated[2]}
            onChange={(e) => setDates(dated[1]!, e.target.value)}
          />
        </div>
      ) : null}
      <p className={cx("m-0 text-xs", valid ? "text-ink-2" : "text-block")}>
        {!valid ? (
          t("goals.form.needDates")
        ) : (
          <>
            <span className="text-ink font-medium tabular-nums">{dated ? datedLabel(value, locale) : `${fmt.format(from)} – ${fmt.format(to)}, ${year}`}</span>
            {` · ${state}. `}
            {dated ? t("goals.form.customHint") : t("goals.form.periodHint")}
          </>
        )}
      </p>
    </div>
  );
}

/** A labelled block of the goal form: the label on the left on a wide screen, above on a phone. */
function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5 sm:grid-cols-[8.5rem_minmax(0,1fr)] sm:gap-4">
      <div className="min-w-0 sm:pt-1.5">
        <span className="block text-sm font-semibold">{label}</span>
        {hint ? <span className="text-ink-2 block text-xs">{hint}</span> : null}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function GoalDialog({ goal, period, departments: known, onClose }: { goal: Goal | null; period: string; departments: string[]; onClose: () => void }) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const dir = useDirectory();
  const [title, setTitle] = useState(goal?.title ?? "");
  const [ownerId, setOwnerId] = useState(goal?.ownerId ?? dir.me);
  const [department, setDepartment] = useState(goal?.department ?? "");
  const [otherDept, setOtherDept] = useState(false);
  const [per, setPer] = useState(goal?.period ?? period);
  const [krs, setKrs] = useState<KrDraft[]>(
    goal?.keyResults.map((k) => ({
      id: k.id,
      title: k.title,
      kind: k.kind,
      start: String(k.start),
      target: String(k.target),
      unit: k.unit,
      direction: k.direction ?? (k.target < k.start ? "down" : "up"),
      dirTouched: true,
      projectId: k.projectId ?? "",
    })) ?? [blankKr()],
  );
  const [projects, setProjects] = useState<ProjectOption[] | null>(null);
  const [orgDepts, setOrgDepts] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<{ projects: ProjectOption[] }>("work/projects")
      .then((r) => setProjects(r.projects))
      .catch(() => setProjects([]));
    void api<{ departments: { name: string }[] }>("employee/departments")
      .then((r) => setOrgDepts(r.departments.map((d) => d.name)))
      .catch(() => setOrgDepts([]));
  }, []);
  const deptOptions = [...new Set([...orgDepts, ...known, ...(department ? [department] : [])])].filter(Boolean).sort((a, b) => a.localeCompare(b));
  const set = (i: number, patch: Partial<KrDraft>) =>
    setKrs(
      krs.map((k, j) => {
        if (j !== i) return k;
        const next = { ...k, ...patch };
        // Until the owner says otherwise, 900 → 300 reads as "lower is better" and 0 → 2000 as "higher is better".
        if (!next.dirTouched && ("start" in patch || "target" in patch)) {
          const s = Number(next.start);
          const g = Number(next.target);
          if (Number.isFinite(s) && Number.isFinite(g) && s !== g) next.direction = g < s ? "down" : "up";
        }
        return next;
      }),
    );
  // Why Save is off, in words next to it, instead of a silent grey button.
  const blocker = (() => {
    if (!title.trim()) return t("goals.form.needTitle");
    if (per.startsWith("D/")) {
      const { starts, ends } = periodDates(per);
      if (!Number.isFinite(starts) || !Number.isFinite(ends) || ends <= starts) return t("goals.form.needDates");
    }
    for (const [i, k] of krs.entries()) {
      const n = i + 1;
      if (!k.title.trim()) return t("goals.form.needKrTitle", { n });
      if (k.kind === "project" && !k.projectId) return t("goals.form.needProject", { n });
      if (k.kind === "number" && Number(k.start) === Number(k.target)) return t("goals.form.needDiff", { n });
    }
    return null;
  })();
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = {
        title,
        ownerId,
        department: department.trim() || null,
        period: per,
        keyResults: krs.map((k) => ({
          ...(k.id ? { id: k.id } : {}),
          title: k.title,
          kind: k.kind,
          start: Number(k.start) || 0,
          target: Number(k.target) || 0,
          unit: k.unit,
          ...(k.kind === "number" ? { direction: k.direction } : {}),
          projectId: k.kind === "project" ? k.projectId || null : null,
        })),
      };
      await api(goal ? `work/goals/${goal.id}` : "work/goals", { method: goal ? "PUT" : "POST", body });
      router.refresh();
      onClose();
    } catch {
      setError(t("goals.saveFailed"));
    } finally {
      setBusy(false);
    }
  };
  const archive = async () => {
    if (!goal || !window.confirm(t("goals.archiveConfirm", { title: goal.title }))) return;
    await api(`work/goals/${goal.id}`, { method: "DELETE" });
    router.refresh();
    onClose();
  };
  const kindCard = (on: boolean) =>
    cx("grid content-start gap-0.5 rounded-lg p-2.5 text-left transition-colors", on ? "bg-signal-wash ring-brand ring-2" : "shadow-[0_0_0_1px_var(--hairline)] hover:bg-hover");
  return (
    <Modal
      title={goal ? t("goals.edit") : t("goals.new")}
      onClose={onClose}
      wide
      footer={
        <>
          {goal ? (
            <button type="button" className={cx(btn, "mr-auto")} onClick={() => void archive()}>
              {t("goals.archive")}
            </button>
          ) : null}
          {blocker ? <span className="text-ink-2 mr-auto self-center text-xs">{blocker}</span> : null}
          <button type="button" className={btn} onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className={btnPrimary} disabled={busy || !!blocker} onClick={() => void save()}>
            {t("common.save")}
          </button>
        </>
      }
    >
      <div className="grid gap-5">
        <Row label={t("goals.title")}>
          <input
            className={cx(input, "min-h-9 text-base/6 sm:text-sm/6")}
            aria-label={t("goals.title")}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t("goals.titleHint")}
            autoFocus
          />
        </Row>
        <Row label={t("goals.form.belongs")} hint={t("goals.form.belongsHint")}>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Picker
                variant="field"
                label={t("goals.department")}
                value={otherDept ? OTHER_DEPT : department}
                onChange={(v) => {
                  if (v === OTHER_DEPT) {
                    setOtherDept(true);
                    setDepartment("");
                  } else {
                    setOtherDept(false);
                    setDepartment(v);
                  }
                }}
                options={[
                  {
                    value: "",
                    label: t("goals.company"),
                    icon: <span className="bg-ink text-on-brand grid size-4 place-items-center rounded-[4px] text-[11px] font-semibold">∗</span>,
                  },
                  ...deptOptions.map((d) => {
                    const tone = deptTone(d);
                    return {
                      value: d,
                      label: d,
                      icon: <span className={cx(tone.wash, tone.text, "grid size-4 place-items-center rounded-[4px] text-[11px] font-semibold")}>{d[0]}</span>,
                    };
                  }),
                  { value: OTHER_DEPT, label: t("goals.form.otherDept") },
                ]}
              />
              {otherDept ? (
                <input
                  className={input}
                  aria-label={t("goals.form.deptName")}
                  placeholder={t("goals.form.deptName")}
                  value={department}
                  onChange={(e) => setDepartment(e.target.value)}
                  autoFocus
                />
              ) : null}
            </div>
            <Picker
              variant="field"
              label={t("goals.owner")}
              prefix={`${t("goals.owner")}:`}
              value={ownerId}
              onChange={setOwnerId}
              options={dir.people.map((p) => ({ value: p.userId, label: p.displayName, icon: <Avatar id={p.userId} size="xs" /> }))}
            />
          </div>
        </Row>
        <Row label={t("goals.period")}>
          <PeriodPicker value={per} onChange={setPer} />
        </Row>
        <fieldset className="m-0 grid gap-3 border-0 p-0">
          <legend className="mb-2 grid gap-0.5">
            <span className="text-sm font-semibold">{t("goals.keyResults")}</span>
            <span className="text-ink-2 text-xs">{t("goals.form.krLead")}</span>
          </legend>
          {krs.map((k, i) => {
            const project = k.kind === "project" ? (projects ?? []).find((p) => p.id === k.projectId) : undefined;
            const target = Number(k.target);
            const same = k.kind === "number" && Number(k.start) === target;
            const targetText = t(k.direction === "down" ? "goals.targetDown" : "goals.targetUp", { value: Number.isFinite(target) ? num(target, locale) : k.target });
            return (
              <div key={i} className="bg-hover/40 grid gap-3 rounded-xl p-3 sm:p-4">
                <div className="flex items-center gap-2">
                  <span className="text-ink-2 text-xs font-semibold uppercase tracking-wide">{t("goals.krTitle", { n: i + 1 })}</span>
                  <button
                    type="button"
                    className="text-ink-2 hover:text-block hover:bg-hover ml-auto grid size-8 place-items-center rounded-md disabled:opacity-40"
                    aria-label={t("goals.removeKr", { n: i + 1 })}
                    disabled={krs.length === 1}
                    onClick={() => setKrs(krs.filter((_, j) => j !== i))}
                  >
                    <TrashIcon className="size-4" />
                  </button>
                </div>
                <input
                  className={input}
                  aria-label={t("goals.krTitle", { n: i + 1 })}
                  value={k.title}
                  onChange={(e) => set(i, { title: e.target.value })}
                  placeholder={t("goals.krHint")}
                />
                <div role="radiogroup" aria-label={t("goals.krKind", { n: i + 1 })} className="grid gap-2 sm:grid-cols-2">
                  {(["number", "project"] as const).map((kind) => (
                    <button key={kind} type="button" role="radio" aria-checked={k.kind === kind} className={kindCard(k.kind === kind)} onClick={() => set(i, { kind })}>
                      <span className="flex items-center gap-1.5 text-sm font-medium">
                        {kind === "number" ? <TrendIcon className="size-4" /> : <BoardIcon className="size-4" />}
                        {t(`goals.kind.${kind}`)}
                      </span>
                      <span className="text-ink-2 text-xs">{t(kind === "number" ? "goals.form.numberDesc" : "goals.form.projectDesc")}</span>
                    </button>
                  ))}
                </div>
                {k.kind === "number" ? (
                  <div className="grid gap-2">
                    {/* Read as a sentence: from 0 to 2,000 million, going up. */}
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-2 text-sm">
                      <span className="text-ink-2">{t("goals.form.from")}</span>
                      <input
                        className={cx(input, "w-24! tabular-nums")}
                        inputMode="decimal"
                        aria-label={t("goals.start")}
                        aria-invalid={same || undefined}
                        value={k.start}
                        onChange={(e) => set(i, { start: e.target.value })}
                      />
                      <span className="text-ink-2">{t("goals.form.to")}</span>
                      <input
                        className={cx(input, "w-24! tabular-nums")}
                        inputMode="decimal"
                        aria-label={t("goals.target")}
                        aria-invalid={same || undefined}
                        value={k.target}
                        onChange={(e) => set(i, { target: e.target.value })}
                      />
                      <input
                        className={cx(input, "w-28!")}
                        aria-label={t("goals.unit")}
                        placeholder={t("goals.form.unitHint")}
                        value={k.unit}
                        onChange={(e) => set(i, { unit: e.target.value })}
                      />
                      <Segmented<"up" | "down">
                        label={t("goals.direction")}
                        size="sm"
                        value={k.direction}
                        onChange={(v) => set(i, { direction: v, dirTouched: true })}
                        options={[
                          { value: "up", label: t("goals.form.dirUp"), icon: <ArrowUpIcon /> },
                          { value: "down", label: t("goals.form.dirDown"), icon: <ArrowDownIcon /> },
                        ]}
                      />
                    </div>
                    <p className={cx("m-0 text-xs", same ? "text-block" : "text-ink-2")}>
                      {same ? (
                        t("goals.form.sameValue")
                      ) : (
                        <>
                          <span className="text-ink font-medium">{t("goals.form.metWhen", { target: `${targetText}${k.unit ? ` ${k.unit}` : ""}` })}</span>{" "}
                          {t(k.direction === "down" ? "goals.form.dirDownHint" : "goals.form.dirUpHint")}
                        </>
                      )}
                    </p>
                  </div>
                ) : (
                  <div className="grid gap-1.5">
                    <Picker
                      variant="field"
                      label={t("goals.project")}
                      placeholder={t("goals.pickProject")}
                      value={k.projectId}
                      onChange={(v) => set(i, { projectId: v })}
                      options={(projects ?? []).map((p) => ({ value: p.id, label: p.name, keywords: String(p.totalTasks) }))}
                    />
                    <p className="text-ink-2 m-0 text-xs">
                      {project
                        ? t("goals.form.projectNow", {
                            done: project.doneTasks,
                            total: project.totalTasks,
                            pct: project.totalTasks ? Math.round((project.doneTasks / project.totalTasks) * 100) : 0,
                          })
                        : t("goals.form.projectHint")}
                    </p>
                  </div>
                )}
              </div>
            );
          })}
          {krs.length < 8 ? (
            <button type="button" className={cx(btn, btnSm, "justify-self-start")} onClick={() => setKrs([...krs, blankKr()])}>
              <PlusIcon className="size-4" />
              {t("goals.addKr")}
            </button>
          ) : null}
        </fieldset>
        {error ? (
          <p role="alert" className="text-block m-0 text-sm">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
