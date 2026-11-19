import Link from "next/link";
import { getT } from "@/lib/i18n/server";
import { cx } from "@/lib/ui";
import { BotIcon, ChartIcon, ClockIcon, ShieldIcon, SparkleIcon } from "@/components/app/icons";
import { IconTile, Tile, tileRow, type Tone } from "@/components/ui/Bento";
import { Avatar } from "@/lib/people";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { AI_MIN_GROUP, aiComparison, type AiDone, type AiWeek, type TodayItem } from "./model";

/**
 * The boss's "Today": at most three things to act on, ranked in model.ts (todayItems): the most stuck
 * person and why, what waits for my decision, a sensitive-data alert. Nothing to act on: the strip is not drawn
 * (the focus card says so); a source that failed shows as one quiet "couldn't load" row, never as all clear.
 */
export async function TodayBrief({ items }: { items: TodayItem[] }) {
  const t = await getT();
  if (!items.length) return null;
  // `who`: the row is about a person, so their face leads it instead of an icon.
  const row = (key: string, tone: Tone, icon: React.ReactNode, title: React.ReactNode, sub: React.ReactNode, href?: string, action?: string, who?: string) => (
    <li key={key}>
      {href ? (
        <Link href={href} className={cx(tileRow, "text-ink no-underline")}>
          {who ? <Avatar id={who} size="md" /> : <IconTile tone={tone}>{icon}</IconTile>}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{title}</span>
            <span className="text-ink-2 block truncate text-[13px]">{sub}</span>
          </span>
          {action ? <span className="text-ink-2 shrink-0 text-[13px] font-medium max-sm:hidden">{action} →</span> : null}
        </Link>
      ) : (
        <div className={tileRow}>
          <IconTile tone={tone}>{icon}</IconTile>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{title}</span>
            <span className="text-ink-2 block text-[13px]">{sub}</span>
          </span>
        </div>
      )}
    </li>
  );
  return (
    <Tile id="home-brief" icon={<ClockIcon />} tone="tangerine" title={t("home.today.title")}>
      <ul className="m-0 mt-2 flex list-none flex-col p-0" aria-label={t("home.today.title")}>
        {items.map((it, i) => {
          if (it.kind === "stuck") {
            const p = it.person;
            const facts = [
              p.overdue ? t("home.today.late", { count: p.overdue }) : null,
              p.blocked ? t("home.today.blocked", { count: p.blocked }) : null,
              p.stale ? t("home.today.stale", { count: p.stale }) : null,
            ].filter(Boolean);
            return row(
              `s:${p.userId}`,
              "red",
              <ClockIcon />,
              t("home.today.stuck", { name: p.displayName }),
              p.reason ? `${facts.join(" · ")} · “${p.reason}”` : facts.join(" · "),
              `/app/work/people/${p.userId}`,
              t("home.today.look"),
              p.userId,
            );
          }
          if (it.kind === "waiting")
            return row(
              "w",
              "violet",
              <BotIcon />,
              t("home.today.waiting", { count: it.pipeline + it.approvals }),
              [it.pipeline ? t("home.today.drafts", { count: it.pipeline }) : null, it.approvals ? t("home.today.requests", { count: it.approvals }) : null]
                .filter(Boolean)
                .join(" · "),
              it.href,
              t("home.today.review"),
            );
          if (it.kind === "sensitive")
            return row(
              "x",
              "tangerine",
              <ShieldIcon />,
              t("home.today.sensitive", { count: it.blocked + it.redacted + it.warned }),
              [
                it.blocked ? t("home.today.sBlocked", { count: it.blocked }) : null,
                it.redacted ? t("home.today.sRedacted", { count: it.redacted }) : null,
                it.warned ? t("home.today.sWarned", { count: it.warned }) : null,
              ]
                .filter(Boolean)
                .join(" · "),
              "/app/ai/adoption/usage",
              t("home.today.look"),
            );
          return (
            <li key={`f:${it.what}:${i}`} className="py-1.5">
              <LoadFailed what={t(it.what === "team" ? "home.today.failedTeam" : "home.today.failedWaiting")} />
            </li>
          );
        })}
      </ul>
    </Tile>
  );
}

/**
 * AI this week, for the people I follow: who used AI (the ai module's one definition, usesAi) and who has not yet,
 * and tasks finished with AI against without. The on-time comparison shows only when both groups are big enough.
 */
export async function AiThisWeek({ ai, withAi }: { ai: AiWeek | null; withAi: { assisted: AiDone; other: AiDone } | null }) {
  const t = await getT();
  const link = { href: "/app/ai/adoption", label: t("home.aiWeek.open") };
  if (!ai)
    return (
      <Tile id="home-ai-week" icon={<SparkleIcon />} tone="violet" title={t("home.aiWeek.title")} link={link}>
        <LoadFailed className="mt-4" />
      </Tile>
    );
  // Counts for groups under AI_MIN_GROUP people would point at individuals: the tile stays out then.
  if (ai.totals.people < AI_MIN_GROUP) return null;
  const cmp = aiComparison(withAi);
  const notYet = Math.max(0, ai.totals.people - ai.totals.active);
  return (
    <Tile id="home-ai-week" icon={<SparkleIcon />} tone="violet" title={t("home.aiWeek.title")} link={link}>
      <p className="m-0 mt-3 flex items-baseline gap-2">
        <span className="font-display text-[30px]/none font-semibold tabular-nums tracking-[-0.045em]">
          {ai.totals.active}
          <span className="text-ink-2 text-lg font-medium">/{ai.totals.people}</span>
        </span>
        <span className="text-ink-2 text-[13px]">{t("home.aiWeek.using")}</span>
      </p>
      <ul className="text-ink-soft m-0 mt-3 flex list-none flex-col gap-1.5 p-0 text-[13px]">
        {notYet ? (
          <li>
            <Link href="/app/ai/adoption" className="text-current no-underline hover:underline">
              {t("home.aiWeek.notYet", { count: notYet })}
            </Link>
          </li>
        ) : null}
        {cmp ? (
          <li className="flex items-center gap-2">
            <ChartIcon className="text-ink-2 size-3.5 shrink-0" />
            {t("home.aiWeek.finished", { withAi: cmp.withAi, without: cmp.without })}
          </li>
        ) : null}
        {cmp?.rates && cmp.rates.withAi !== null && cmp.rates.without !== null ? (
          <li className="text-ink-2">{t("home.aiWeek.onTime", { withAi: cmp.rates.withAi, without: cmp.rates.without })}</li>
        ) : cmp ? (
          <li className="text-ink-2">{t("home.aiWeek.fewTasks")}</li>
        ) : null}
      </ul>
    </Tile>
  );
}
