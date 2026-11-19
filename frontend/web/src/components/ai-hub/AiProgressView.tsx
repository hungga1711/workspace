"use client";

import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/client";
import { useFormat, useT } from "@/lib/i18n/client";
import { Avatar } from "@/lib/people";
import { taskHref } from "@/lib/links";
import { btn, btnPrimary, btnSm, chip, chipBlock, chipWarn, cx, input } from "@/lib/ui";
import { ArrowRightIcon, BellIcon, CheckIcon, SparkleIcon, StarIcon, UsersIcon } from "@/components/app/icons";
import { IconTile, card, tileRow } from "@/components/ui/Bento";
import { SpotArea } from "@/components/ui/SpotArea";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { AllClear, TileHead } from "./Intro";

type ReasonKind = "overdue" | "blocked" | "atRisk" | "stale" | "quiet" | "slowing" | "overloaded";
type Flag = "overdue" | "blocked" | "atRisk" | "stale";
export interface Attention {
  userId: string;
  displayName: string;
  title: string | null;
  department: string | null;
  reasons: { kind: ReasonKind; count?: number; days?: number }[];
  tasks: { id: string; code: string; title: string; status: string; dueAt: string | null; blockedReason: string | null; flag: Flag }[];
  nudgeTaskId: string | null;
}
export interface ProgressBrief {
  scope: "team" | "self";
  people: number;
  totals: { open?: number; overdue?: number; blocked?: number; done7?: number };
  attention: Attention[];
  highlights: { userId: string; displayName: string; done7: number; onTimeRate: number | null }[];
}
interface Reading {
  summary: string;
  people: { userId: string; why: string; nudge: string }[];
  next: string[];
}

const FLAG_CHIP: Record<Flag, string> = { overdue: chipBlock, blocked: chipBlock, atRisk: chipWarn, stale: chip };
const REASON_CHIP: Record<ReasonKind, string> = { overdue: chipBlock, blocked: chipBlock, atRisk: chipWarn, quiet: chipWarn, stale: chip, slowing: chip, overloaded: chip };

/**
 * AI › Tiến độ: the figures, who needs attention and why (rules, so it works without a model), and, with the
 * company AI on, a reading on request: a summary, next steps, and per person the cause and a drafted nudge the
 * manager edits and sends themselves.
 */
export function AiProgressView({ data, aiEnabled, failed = false }: { data: ProgressBrief; aiEnabled: boolean; failed?: boolean }) {
  const t = useT();
  const [reading, setReading] = useState<Reading | null>(null);
  const [state, setState] = useState<"idle" | "busy" | "failed">("idle");
  const [all, setAll] = useState(false);
  const team = data.scope === "team";
  // Worst first; the rest one click away, so a big team's page stays a page.
  const shown = all ? data.attention : data.attention.slice(0, 8);
  const byUser = new Map((reading?.people ?? []).map((x) => [x.userId, x]));
  const analyze = () => {
    setState("busy");
    api<Reading>("ai/progress/analyze", { method: "POST", body: {} })
      .then((r) => {
        setReading(r);
        setState("idle");
      })
      .catch(() => setState("failed"));
  };
  const overdue = data.totals.overdue ?? 0;
  const blocked = data.totals.blocked ?? 0;
  const figures = [
    // A status dot, not an icon tile: the four are states of the same tasks, read in one glance.
    { key: "people", value: data.people, dot: "bg-ink-2", alert: false },
    { key: "open", value: data.totals.open ?? 0, dot: "bg-sky", alert: false },
    { key: "overdue", value: overdue, dot: "bg-block", alert: overdue > 0 },
    { key: "blocked", value: blocked, dot: "bg-tangerine", alert: blocked > 0 },
    { key: "done7", value: data.totals.done7 ?? 0, dot: "bg-ok-fill", alert: false },
  ] as const;
  const n = data.attention.length;
  const analyzeBtn = aiEnabled ? (
    <button type="button" className={cx(reading ? btn : btnPrimary)} disabled={state === "busy"} onClick={analyze} data-testid="ai-progress-analyze">
      <SparkleIcon />
      {state === "busy" ? t("aiHub.progress.analyzing") : reading ? t("aiHub.progress.reanalyze") : t("aiHub.progress.analyze")}
    </button>
  ) : null;
  return (
    <SpotArea className="grid grid-cols-[minmax(0,1fr)] gap-5 max-md:gap-4">
      {/* No headline: the strip is the header (people followed, then their tasks by state) and "Needs attention"
        below carries its own count; a title repeating both read as noise (user, 2026-11-05). */}
      {team || analyzeBtn ? (
        <div className="flex flex-wrap items-center gap-3">
          {team ? (
            <section
              aria-label={t("aiHub.progress.title")}
              className={cx(card, "divide-divider grid min-w-0 flex-1 grid-cols-5 divide-x rounded-xl max-lg:basis-full max-sm:grid-cols-2 max-sm:divide-x-0")}
            >
              {figures.map((f, i) => (
                <div
                  key={f.key}
                  className={cx(
                    "flex min-w-0 flex-col gap-1 px-4 py-3",
                    i === 0 && "max-sm:col-span-2",
                    i > 0 && i % 2 === 0 && "max-sm:border-divider max-sm:border-l",
                    i > 0 && "max-sm:border-divider max-sm:border-t",
                  )}
                >
                  <span className="text-ink-2 flex min-w-0 items-baseline gap-2 text-xs/4">
                    <span aria-hidden="true" className={cx("size-1.5 shrink-0 -translate-y-px rounded-full", f.dot, !f.value && "opacity-40")} />
                    <span className="min-w-0">{t(`aiHub.progress.totals.${f.key}`)}</span>
                  </span>
                  <span className={cx("font-display text-[22px]/none font-semibold tabular-nums tracking-[-0.03em]", f.alert ? "text-block" : f.value ? "text-ink" : "text-ink-2")}>
                    {f.value}
                  </span>
                </div>
              ))}
            </section>
          ) : null}
          {analyzeBtn ? <div className={cx("flex shrink-0", !team && "ml-auto")}>{analyzeBtn}</div> : null}
        </div>
      ) : null}

      {/* The AI's reading appears only once asked for (or while it is being written); without a model it is never offered. */}
      {aiEnabled && (reading || state !== "idle") ? (
        <section id="ai-reading" aria-labelledby="ai-reading-h" className={cx(card, "animate-rise grid min-w-0 gap-3 rounded-xl p-5 max-sm:p-4")}>
          <TileHead
            id="ai-reading-h"
            icon={
              <IconTile tone="violet">
                <SparkleIcon />
              </IconTile>
            }
            title={t("aiHub.progress.aiSummary")}
          />
          {state === "failed" ? (
            <p className="text-block m-0 text-sm">{t("aiHub.progress.error")}</p>
          ) : reading ? (
            <div className="grid gap-3">
              <p className="text-ink-soft m-0 max-w-3xl whitespace-pre-line text-sm/6">{reading.summary}</p>
              {reading.next.length ? (
                <div className="grid gap-2">
                  <h4 className="text-ink-2 m-0 text-xs font-medium uppercase tracking-[0.08em]">{t("aiHub.progress.next")}</h4>
                  <ol className="m-0 grid list-none gap-1.5 p-0 text-sm">
                    {reading.next.map((x, i) => (
                      <li key={i} className="flex items-start gap-2.5">
                        <span className="bg-violet-wash text-violet-text grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-semibold tabular-nums">{i + 1}</span>
                        <span className="min-w-0">{x}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              ) : null}
            </div>
          ) : (
            <p className="text-ink-2 m-0 text-sm">{t("aiHub.progress.analyzing")}</p>
          )}
        </section>
      ) : null}

      <section id="ai-attention" aria-labelledby="ai-attention-h" className={cx(card, "grid min-w-0 gap-3 rounded-xl p-5 max-sm:p-4")}>
        <TileHead
          id="ai-attention-h"
          icon={
            <IconTile tone={n ? "rose" : "green"}>
              <UsersIcon />
            </IconTile>
          }
          title={t("aiHub.progress.attention")}
          count={n || undefined}
        />
        {failed ? (
          <LoadFailed />
        ) : n ? (
          <ul className="divide-divider-soft m-0 grid list-none divide-y p-0" data-testid="ai-attention">
            {shown.map((a) => (
              <PersonRow key={a.userId} a={a} team={team} why={byUser.get(a.userId)?.why} draft={byUser.get(a.userId)?.nudge} />
            ))}
            {shown.length < n ? (
              <li className="pt-3">
                <button type="button" className={cx(btn, btnSm)} onClick={() => setAll(true)}>
                  {t("aiHub.progress.showAll", { count: n })}
                </button>
              </li>
            ) : null}
          </ul>
        ) : (
          <AllClear>{team ? t("aiHub.progress.attentionEmpty") : t("aiHub.progress.selfEmpty")}</AllClear>
        )}
      </section>

      {team && data.highlights.length ? (
        <section id="ai-highlights" aria-labelledby="ai-highlights-h" className={cx(card, "grid min-w-0 gap-4 rounded-xl p-5 max-sm:p-4")}>
          <TileHead
            id="ai-highlights-h"
            icon={
              <IconTile tone="green">
                <StarIcon />
              </IconTile>
            }
            title={t("aiHub.progress.highlights")}
          />
          <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-x-4 gap-y-1 p-0">
            {data.highlights.map((h) => (
              <li key={h.userId}>
                <Link href={`/app/work/people/${h.userId}`} className={cx(tileRow, "group/row no-underline")}>
                  <Avatar id={h.userId} name={h.displayName} size="sm" />
                  <span className="grid min-w-0 flex-1">
                    <span className="text-ink truncate text-sm font-medium">{h.displayName}</span>
                    <span className="text-ok text-xs tabular-nums">{t("aiHub.progress.highlightLine", { count: h.done7 })}</span>
                  </span>
                  <ArrowRightIcon className="text-ink-2 size-3.5 shrink-0 opacity-0 transition-[opacity,transform] group-hover/row:translate-x-0.5 group-hover/row:opacity-100" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {aiEnabled ? null : <p className="text-ink-2 m-0 text-xs">{t("aiHub.progress.noAi")}</p>}
    </SpotArea>
  );
}

/** One person: who, why (the rules' chips, then the AI's sentence when there is one), the tasks, and the nudge. */
function PersonRow({ a, team, why, draft }: { a: Attention; team: boolean; why?: string; draft?: string }) {
  const t = useT();
  const { shortDate } = useFormat();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "done" | "failed">("idle");
  const task = a.tasks.find((x) => x.id === a.nudgeTaskId);
  const send = () => {
    if (!a.nudgeTaskId) return;
    setState("busy");
    api(`work/tasks/${a.nudgeTaskId}/nudge`, { method: "POST", body: { message: text.trim() } })
      .then(() => {
        setState("done");
        setOpen(false);
      })
      .catch(() => setState("failed"));
  };
  return (
    <li className="grid gap-2 py-3 first:pt-0 last:pb-0">
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-2">
          {team ? <Avatar id={a.userId} name={a.displayName} dept={a.department} size="sm" /> : null}
          {team ? (
            <span className="grid min-w-0">
              <Link href={`/app/work/people/${a.userId}`} className="text-ink truncate text-sm font-medium no-underline hover:underline">
                {a.displayName}
              </Link>
              {a.department || a.title ? <span className="text-ink-2 truncate text-xs">{[a.title, a.department].filter(Boolean).join(" · ")}</span> : null}
            </span>
          ) : null}
          <span className="flex flex-wrap gap-1.5">
            {a.reasons.map((r) => (
              <span key={r.kind} className={REASON_CHIP[r.kind]}>
                {t(`aiHub.progress.reason.${r.kind}`, { count: r.count ?? 0, days: r.days ?? 0 })}
              </span>
            ))}
          </span>
        </div>
        {team && a.nudgeTaskId ? (
          <span className="shrink-0">
            {state === "done" ? (
              <span className="text-ok inline-flex items-center gap-1 text-xs font-medium">
                <CheckIcon className="size-3.5" />
                {t("aiHub.progress.nudged")}
              </span>
            ) : (
              <button
                type="button"
                className={cx(btn, btnSm)}
                onClick={() => {
                  setText(draft ?? "");
                  setOpen((o) => !o);
                }}
              >
                <BellIcon />
                {t("aiHub.progress.nudge")}
              </button>
            )}
          </span>
        ) : null}
      </div>
      {why ? (
        <p className="text-ink-soft m-0 flex gap-1.5 text-sm">
          <SparkleIcon className="text-accent mt-0.5 size-3.5 shrink-0" />
          <span>{why}</span>
        </p>
      ) : null}
      {a.tasks.length ? (
        <ul className="m-0 grid list-none gap-1 p-0">
          {a.tasks.map((x) => (
            <li key={x.id} className="flex min-w-0 items-center gap-2 text-sm">
              <span className={cx(FLAG_CHIP[x.flag], "shrink-0")}>{t(`aiHub.progress.flag.${x.flag}`)}</span>
              <Link href={taskHref(x)} className="text-ink min-w-0 truncate no-underline hover:underline">
                <span className="text-ink-2 font-mono text-xs">{x.code}</span> {x.title}
              </Link>
              {x.blockedReason ? <span className="text-ink-2 hidden min-w-0 truncate text-xs md:inline">· {x.blockedReason}</span> : null}
              {x.dueAt ? <span className="text-ink-2 ml-auto shrink-0 text-xs tabular-nums">{shortDate(x.dueAt)}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {open && task ? (
        <div className="bg-ground grid gap-2 rounded-lg p-3">
          <textarea
            className={cx(input, "min-h-20 py-2")}
            value={text}
            maxLength={1000}
            placeholder={t("aiHub.progress.nudgePlaceholder")}
            onChange={(e) => setText(e.target.value)}
            aria-label={t("aiHub.progress.nudge")}
          />
          <div className="flex flex-wrap items-center gap-2">
            <span className={cx("text-xs", state === "failed" ? "text-block" : "text-ink-2")} role={state === "failed" ? "alert" : undefined}>
              {state === "failed" ? t("aiHub.progress.nudgeFailed") : t("aiHub.progress.nudgeHint", { code: task.code })}
            </span>
            <span className="ml-auto flex gap-2">
              <button type="button" className={cx(btn, btnSm)} onClick={() => setOpen(false)}>
                {t("aiHub.progress.cancel")}
              </button>
              <button type="button" className={cx(btnPrimary, btnSm)} disabled={state === "busy"} onClick={send}>
                {t("aiHub.progress.nudgeSend")}
              </button>
            </span>
          </div>
        </div>
      ) : null}
    </li>
  );
}
