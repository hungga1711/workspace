import Link from "next/link";
import { getT } from "@/lib/i18n/server";
import { featureOn } from "@/lib/features";
import { taskHref } from "@/lib/links";
import { btn, cx } from "@/lib/ui";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { ChartIcon, CheckIcon, TrendIcon } from "@/components/app/icons";
import { Chip, Figure, Tile } from "@/components/ui/Bento";
import { deptBars, weekItems, type AiWeek, type DeptNumbers, type TeamTotals } from "./model";

/**
 * Managers' tile: late work across the team as the big figure, the week's other numbers as chips, then the departments
 * with late work as bars, worst first. Every figure links to Tiến độ. Laid wide (when it is the only full tile), the
 * figure sits left of the bars.
 */
export async function TeamTile({ team, ai, behind }: { team: { scope: string; totals: TeamTotals; departments?: DeptNumbers[] } | null; ai: AiWeek | null; behind: number }) {
  const t = await getT();
  const title = t(team?.scope === "everyone" ? "home.team.company" : "home.team.team");
  // Tiến độ lives in the AI destination; an installation without it (DISABLED_FEATURES=ai) opens the task list.
  const progress = (await featureOn("ai")) ? "/app/ai/progress" : "/app/work/tasks";
  const link = { href: progress, label: t(progress.startsWith("/app/ai") ? "home.team.progress" : "shell.nav.tasks") };
  if (!team)
    return (
      <Tile id="home-week" icon={<ChartIcon />} tone="green" title={title} link={link}>
        <LoadFailed className="mt-4" />
      </Tile>
    );
  const items = weekItems(team.totals, ai, progress);
  const late = team.totals.overdue;
  const bars = deptBars(team.departments ?? []);
  const chip = (id: string) => items.find((x) => x.id === id);
  const done = chip("done");
  const blocked = chip("blocked");
  const aiUse = chip("ai");
  return (
    <Tile id="home-week" icon={<ChartIcon />} tone="green" title={title} link={link}>
      <div className="@2xl/tile:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] @2xl/tile:gap-x-12 grid flex-1">
        <div className="min-w-0">
          <Figure
            n={
              <Link href={progress} className="text-current no-underline hover:underline">
                {late}
              </Link>
            }
            label={t("home.team.late")}
            tone={late ? "alert" : "muted"}
          />
          <div className="mt-3.5 flex flex-wrap gap-1.5">
            {done ? <Chip href={done.href} n={done.value} label={t("home.team.done")} tone="ok" /> : null}
            {blocked && blocked.value ? <Chip href={blocked.href} n={blocked.value} label={t("home.team.blocked")} tone="alert" /> : null}
            {behind ? <Chip href="/app/work/tasks?view=projects" n={behind} label={t("home.team.behind")} tone="alert" /> : null}
            {aiUse ? <Chip href={aiUse.href} n={`${aiUse.value}/${aiUse.of}`} label={t("home.team.ai")} /> : null}
          </div>
        </div>
        {bars.length ? (
          <ul className="@2xl/tile:mt-4 @2xl/tile:self-center m-0 mt-5 flex list-none flex-col gap-3 p-0" aria-label={t("home.team.byDept")}>
            {bars.map((d) => (
              <li key={d.name ?? ""} className="flex min-w-0 items-center gap-3 text-[13px]">
                <span className="text-ink-soft w-28 shrink-0 truncate">{d.name ?? t("home.team.noDept")}</span>
                <span className="bg-progress-track h-1.5 min-w-0 flex-1 overflow-hidden rounded-full">
                  <span className="bg-block/85 animate-grow-x block h-full origin-left rounded-full" style={{ width: `${d.share}%` }} />
                </span>
                <b className="text-block w-8 shrink-0 text-right font-semibold tabular-nums">{d.overdue}</b>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-ok @2xl/tile:self-center m-0 mt-5 flex items-center gap-2 text-[13px] font-medium">
            <span aria-hidden="true" className="bg-ok-wash ring-current/15 grid size-6 place-items-center rounded-full ring-1 ring-inset">
              <CheckIcon className="size-3.5" />
            </span>
            {t("home.team.calm")}
          </p>
        )}
      </div>
    </Tile>
  );
}

/** Everyone else's tile: what I finished this week (vs last week), my on-time rate and the leave I have left. */
export async function WeekTile({
  stats,
  leaveLeft,
  recent,
}: {
  stats: { doneThisWeek: number; doneLastWeek: number; onTimeRate: number | null; onTimeOf?: number } | null;
  leaveLeft: number | null;
  /** What I finished last, newest first. */
  recent: { id: string; code?: string | null; title: string }[];
}) {
  const t = await getT();
  const title = t("home.week.title");
  const link = { href: "/app/me", label: t("home.week.open") };
  if (!stats)
    return (
      <Tile id="home-week" icon={<TrendIcon />} tone="rose" title={title} link={link}>
        <LoadFailed className="mt-4" />
      </Tile>
    );
  const delta = stats.doneThisWeek - stats.doneLastWeek;
  return (
    <Tile id="home-week" icon={<TrendIcon />} tone="rose" title={title} link={link}>
      {/* Narrow: figure, recent, button in a column. Wide (the only full tile): figure and button left, recent right. */}
      <div className="@2xl/tile:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] @2xl/tile:grid-rows-[auto_1fr] @2xl/tile:gap-x-12 grid flex-1 grid-rows-[auto_auto_1fr]">
        <div className="min-w-0">
          <Figure n={stats.doneThisWeek} label={t("home.week.done", { count: stats.doneThisWeek })} tone={stats.doneThisWeek ? undefined : "muted"}>
            {delta ? (
              <span
                title={t("home.week.vsLast")}
                className={cx(
                  "rounded-full px-2 py-0.5 text-xs font-medium tabular-nums",
                  delta > 0 ? "bg-ok-wash text-ok" : "bg-ground ring-hairline text-ink-2 ring-1 ring-inset",
                )}
              >
                {delta > 0 ? `▲ ${delta}` : `▼ ${-delta}`}
              </span>
            ) : null}
          </Figure>
          <div className="mt-3.5 flex flex-wrap gap-1.5">
            {stats.onTimeRate !== null && (stats.onTimeOf ?? 3) >= 3 ? (
              <Chip n={`${stats.onTimeRate}%`} label={t("home.week.onTime")} tone={stats.onTimeRate >= 80 ? "ok" : undefined} />
            ) : null}
            {leaveLeft !== null ? <Chip href="/app/time?tab=leave" n={leaveLeft} label={t("home.week.leave", { count: leaveLeft })} /> : null}
          </div>
        </div>
        {recent.length ? (
          <ul className="@2xl/tile:col-start-2 @2xl/tile:row-span-2 @2xl/tile:row-start-1 @2xl/tile:mt-3 m-0 mt-4 flex list-none flex-col p-0" aria-label={t("home.week.recent")}>
            {recent.slice(0, 4).map((x) => (
              <li key={x.id} className="hover:bg-hover -mx-2 flex min-h-9 min-w-0 items-center gap-2.5 rounded-lg px-2 text-[13px] transition-colors">
                <span aria-hidden="true" className="bg-ok-wash text-ok ring-current/15 grid size-5 shrink-0 place-items-center rounded-full ring-1 ring-inset">
                  <CheckIcon className="size-3" />
                </span>
                <Link href={taskHref(x)} className="text-ink-soft min-w-0 flex-1 truncate no-underline hover:underline">
                  {x.title}
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-ink-2 @2xl/tile:col-start-2 @2xl/tile:row-span-2 @2xl/tile:row-start-1 @2xl/tile:self-center m-0 mt-4 text-[13px]">{t("home.week.none")}</p>
        )}
        <div className="flex items-end pt-5">
          <Link href="/app/work/ops" className={cx(btn, "w-full")}>
            {t("home.week.request")}
          </Link>
        </div>
      </div>
    </Tile>
  );
}
