"use client";

import { useFeature } from "@/lib/features-context";
import { topicLabel, sourceLabel, sensitiveLabel } from "@/lib/ai-labels";
import Link from "next/link";
import { useFormat, useT } from "@/lib/i18n/client";
import { useAiMonitoring } from "@/lib/ai-context";
import { Avatar, useDirectory } from "@/lib/people";
import { cardLink, cx } from "@/lib/ui";
import { BoardIcon, CheckCircleIcon, CheckIcon, ChevronLeftIcon, ClockIcon, FlagIcon, SparkleIcon, TrendIcon } from "@/components/app/icons";
import { PanelHead, SlimEmpty, StatStrip } from "./progressUi";
import { TaskStatusPill } from "./TaskStatusPill";
import { card } from "@/components/ui/Bento";

/** Home's card: ring at rest, lift and pointer light on hover. */
const panel = cx(card, "min-w-0 rounded-xl p-5 max-sm:p-4");
import { SpotArea } from "@/components/ui/SpotArea";
import { PageHeader } from "@/components/ui/PageHeader";
import { CallButtons } from "@/components/call/CallButtons";
import type { TeamPerson } from "./team-types";
import type { AiConversation } from "./AiOversightView";
import { taskHref } from "@/lib/links";

/** Who is looking (work/people-access.ts): yourself, a manager or company follower, or a same-department colleague. */
export type PersonAccess = "self" | "manager" | "everyone" | "colleague";

/**
 * One person at a glance: figures, what they are on now (with reported progress and ETA), what is late, what they
 * finished, and their AI use. Laid out like the Tiến độ report it opens from: a strip of figures with a
 * rule above each, then flat sections. States are tinted pills, no dots. A colleague sees the figures only.
 */
export function PersonView({
  userId,
  access,
  profile,
  person,
  ai,
}: {
  userId: string;
  access: PersonAccess;
  profile: { displayName: string; title: string | null; department: string | null; departmentId: string | null };
  person: TeamPerson | null;
  ai: { conversations: AiConversation[] } | null;
}) {
  const t = useT();
  const { dueLabel, shortDate, ago, status } = useFormat();
  const dir = useDirectory();
  // AI use is part of a person's picture only while the company records it (Admin › AI, extension monitoring).
  const monitoring = useAiMonitoring();
  const name = profile.displayName || person?.displayName || dir.name(userId);
  // The team view is AI › Tiến độ: without the AI destination (left out at deploy time) the way back is the task list.
  const hasAi = useFeature("ai");
  const back =
    hasAi && (access === "manager" || access === "everyone") ? { href: "/app/ai/progress", label: t("work.page.team") } : { href: "/app/work", label: t("shell.nav.tasks") };
  const open = person?.tasks.filter((x) => x.status !== "done") ?? [];
  const topics = (ai?.conversations ?? []).reduce<Record<string, number>>((acc, c) => ((acc[c.topic] = (acc[c.topic] ?? 0) + c.prompts), acc), {});
  const sources = (ai?.conversations ?? []).reduce<Record<string, number>>((acc, c) => ((acc[c.source] = (acc[c.source] ?? 0) + c.prompts), acc), {});
  return (
    // minmax(0,1fr) columns: a truncated title's full length must not set the page width on phones.
    <SpotArea className="grid grid-cols-[minmax(0,1fr)] gap-6 max-md:gap-4">
      <div className="grid gap-3">
        {/* Wide screens: the top bar's "Tiến độ / <name>" is the way back; phones keep a back link. */}
        <Link href={back.href} className="text-ink-2 hover:text-ink flex w-fit items-center gap-1 text-sm no-underline md:hidden">
          <ChevronLeftIcon className="size-4" />
          {back.label}
        </Link>
        <PageHeader
          size="entity"
          className="mb-0"
          title={name}
          lead={<Avatar id={userId} name={name} size="lg" />}
          meta={
            <>
              {[profile.title ?? person?.title, person?.lastActivityAt ? t("person.lastActive", { when: ago(person.lastActivityAt) }) : null].filter(Boolean).join(" · ")}
              {profile.department ? (
                <>
                  {profile.title || person?.lastActivityAt ? " · " : null}
                  {profile.departmentId ? (
                    <Link href={`/app/work/departments/${profile.departmentId}`} className="text-current hover:underline">
                      {profile.department}
                    </Link>
                  ) : (
                    profile.department
                  )}
                </>
              ) : null}
            </>
          }
          actions={
            <span className="flex gap-2 print:hidden">
              <CallButtons userId={userId} variant="button" />
            </span>
          }
        />
      </div>

      {access === "self" ? <p className="text-ink-2 m-0 -mt-2 text-sm">{t("person.selfNote")}</p> : null}

      {person ? (
        <StatStrip
          label={t("person.numbers")}
          items={[
            { label: t("follow.colNow"), value: person.inProgress, icon: <BoardIcon />, tone: "sky", quiet: !person.inProgress },
            { label: t("follow.colLate"), value: person.overdue, icon: <ClockIcon />, tone: "red", alert: person.overdue > 0, quiet: !person.overdue },
            { label: t("follow.colRisk"), value: person.atRisk ?? 0, icon: <FlagIcon />, tone: "tangerine", quiet: !person.atRisk },
            { label: t("follow.colDone"), value: person.done7, icon: <CheckIcon />, tone: "green", quiet: !person.done7 },
            {
              label: t("follow.colOnTime"),
              value: person.onTimeRate == null ? "–" : `${person.onTimeRate}%`,
              icon: <TrendIcon />,
              tone: "violet",
              quiet: person.onTimeRate == null,
            },
          ]}
        />
      ) : null}

      <div className={cx("grid grid-cols-[minmax(0,1fr)] items-start gap-6", monitoring && access !== "colleague" && "xl:grid-cols-[minmax(0,1fr)_380px]")}>
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4">
          <section aria-labelledby="person-work-h" className={panel}>
            <PanelHead id="person-work-h" title={t("person.work")} count={access === "colleague" ? undefined : open.length} icon={<BoardIcon />} tone="sky" />
            {access === "colleague" ? (
              <p className="text-ink-2 m-0 text-sm">{t("person.colleagueNote")}</p>
            ) : open.length === 0 ? (
              <SlimEmpty className="min-h-0 bg-transparent p-0 shadow-none max-sm:p-0" tone="green" title={t("person.noWork")} />
            ) : (
              <ul className="divide-divider-soft m-0 list-none divide-y p-0">
                {open.map((x) => {
                  const due = x.dueAt ? dueLabel(x.dueAt) : null;
                  return (
                    <li key={x.id}>
                      <Link
                        href={taskHref(x)}
                        className="text-ink hover:bg-hover -mx-2 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 rounded-md px-2 py-3 no-underline transition-colors"
                      >
                        <span className="min-w-0 font-medium" title={x.code}>
                          {x.title}
                        </span>
                        {x.overdue ? (
                          <span className="bg-block-wash text-block inline-flex h-5 items-center justify-self-end whitespace-nowrap rounded-md px-1.5 text-xs font-medium">
                            {t("follow.overdue")}
                          </span>
                        ) : x.atRisk ? (
                          <span className="bg-warn-wash text-warn inline-flex h-5 items-center justify-self-end whitespace-nowrap rounded-md px-1.5 text-xs font-medium">
                            {t("checkin.atRiskShort")}
                          </span>
                        ) : (
                          <TaskStatusPill status={x.status} label={status(x.status)} className="justify-self-end" />
                        )}
                        {/* No typed-in percentage: nothing keeps it current (the pace is above). */}
                        <span />
                        <span className="text-ink-2 text-right text-xs tabular-nums">
                          {x.etaAt ? t("person.eta", { date: shortDate(x.etaAt) }) : due ? due.text : t("person.noDue")}
                        </span>
                        {x.lastNote ? (
                          <span className="text-ink-2 col-span-2 text-sm">
                            “{x.lastNote.text}” <span className="text-xs">· {ago(x.lastNote.at)}</span>
                          </span>
                        ) : null}
                        {x.blockedReason ? <span className="text-ink-soft col-span-2 text-sm">{t("person.blocked", { reason: x.blockedReason })}</span> : null}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
          {person?.doneRecently.length ? (
            <section aria-labelledby="person-done-h" className={panel}>
              <PanelHead id="person-done-h" title={t("person.done")} count={person.doneRecently.length} icon={<CheckIcon />} tone="green" />
              <ul className="m-0 grid list-none grid-cols-[minmax(0,1fr)] gap-1.5 p-0 text-sm">
                {person.doneRecently.map((d) => (
                  <li key={d.id} className="flex items-center gap-2">
                    <CheckCircleIcon className="text-ok size-4 shrink-0" />
                    <Link href={taskHref(d)} className="text-ink min-w-0 flex-1 truncate no-underline hover:underline">
                      {d.title}
                    </Link>
                    <span className="text-ink-2 shrink-0 text-xs">{ago(d.completedAt)}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>

        {monitoring && access !== "colleague" ? (
          <section aria-labelledby="person-ai-h" className={cx(panel, "grid grid-cols-[minmax(0,1fr)] content-start gap-3")}>
            <PanelHead id="person-ai-h" title={t("person.ai")} className="mb-0" icon={<SparkleIcon />} tone="violet" />
            {!ai ? (
              <p className="text-ink-2 m-0 text-sm">{t("person.aiHidden")}</p>
            ) : ai.conversations.length === 0 ? (
              <p className="text-ink-2 m-0 text-sm">{t("aiw.o.personEmpty", { count: 30 })}</p>
            ) : (
              <>
                <p className="m-0 flex flex-wrap gap-1.5 text-xs">
                  {Object.entries(sources).map(([s, n]) => (
                    <span key={s} className="bg-hover rounded-md px-1.5 py-0.5 tabular-nums">
                      {sourceLabel(t, s)} · {n}
                    </span>
                  ))}
                </p>
                <p className="text-ink-2 m-0 flex flex-wrap gap-1.5 text-xs">
                  {Object.entries(topics)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 4)
                    .map(([k]) => (
                      <span key={k} className="bg-hover text-ink rounded-md px-1.5 py-0.5">
                        {topicLabel(t, k)}
                      </span>
                    ))}
                </p>
                <ul className="divide-hairline m-0 grid list-none grid-cols-[minmax(0,1fr)] divide-y p-0">
                  {ai.conversations.slice(0, 6).map((c) => (
                    <li key={c.id} className="py-2">
                      <p className="text-ink-2 m-0 text-xs">
                        {sourceLabel(t, c.source)} · {topicLabel(t, c.topic)} · {ago(c.lastAt)}
                      </p>
                      {c.summary ? <p className="m-0 text-sm">{c.summary}</p> : null}
                      {c.sensitive.length ? (
                        <p className="m-0 mt-1 flex flex-wrap gap-1">
                          {c.sensitive.map((s) => (
                            <span key={s} className="bg-block-wash text-block rounded-sm px-1.5 py-0.5 text-xs font-medium">
                              {sensitiveLabel(t, s)}
                            </span>
                          ))}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
                <Link href="/app/ai/adoption/usage" className={cx(cardLink, "justify-self-start")}>
                  {t("person.aiAll")}
                </Link>
              </>
            )}
          </section>
        ) : null}
      </div>
    </SpotArea>
  );
}
