"use client";

import Link from "next/link";
import { useT } from "@/lib/i18n/client";
import { btnPrimary, btnSm, cx } from "@/lib/ui";
import { BotIcon } from "@/components/app/icons";
import { MAX_ASK_ROUNDS, type TaskAsk } from "./types";

/**
 * "AI đang hỏi" at the top of a task (page and peek): the open round's questions to read at a glance, and one way to
 * answer them, the run's conversation (/app/chat/ask/<run>), where every question and approval is answered. Gone once
 * answered (the page reads the task again).
 */
export function TaskAskCard({ asks }: { asks: TaskAsk[] }) {
  const t = useT();
  if (!asks.length) return null;
  const count = asks.reduce((n, a) => n + a.questions.length, 0);
  return (
    <div className="mt-4 grid gap-3">
      {/* Announced when the card appears (a run asked while the task was open). */}
      <p role="status" className="sr-only">
        {t("workflows.ask.live", { count })}
      </p>
      {asks.map((a) => (
        <section key={a.id} aria-labelledby={`ask-${a.id}-h`} className="bg-surface ring-warn/30 grid min-w-0 overflow-hidden rounded-xl ring-1 ring-inset">
          <div className="flex min-w-0 items-start gap-3 px-4 pb-3 pt-3.5 max-sm:px-3.5">
            <span
              aria-hidden="true"
              className="bg-violet-wash text-violet-text ring-current/10 grid size-8 shrink-0 place-items-center rounded-full ring-1 ring-inset [&_svg]:size-4"
            >
              <BotIcon />
            </span>
            <div className="grid min-w-0 flex-1 gap-0.5">
              <h2 id={`ask-${a.id}-h`} className="text-ink m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-[15px] font-semibold tracking-[-0.01em]">
                {t("workflows.ask.title")}
                <span className="bg-warn-wash text-warn inline-flex h-5 items-center rounded-full px-2 text-[11px] font-medium tabular-nums">
                  {t("workflows.ask.round", { n: a.round, max: Math.max(MAX_ASK_ROUNDS, a.round) })}
                </span>
              </h2>
              <p className="text-ink-2 m-0 text-[13px]">{t("workflows.ask.intro", { workflow: a.workflowName, step: a.stepTitle ?? "" })}</p>
              <ol className="m-0 mt-2 grid list-none gap-1.5 p-0">
                {a.questions.map((q, i) => (
                  <li key={q.id} className="text-ink flex min-w-0 items-start gap-2 text-sm/6">
                    <span
                      aria-hidden="true"
                      className="bg-hover text-ink-2 mt-[3px] grid size-[18px] shrink-0 place-items-center rounded-full text-[10.5px] font-semibold tabular-nums"
                    >
                      {i + 1}
                    </span>
                    <span className="min-w-0">
                      {q.text}
                      {q.required === false ? <span className="text-ink-2 ml-1.5 text-xs">({t("workflows.ask.optional")})</span> : null}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          </div>
          <div className="border-hairline bg-warn-wash/30 flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-2 border-t px-4 py-2.5 max-sm:px-3.5">
            <p className="text-ink-2 m-0 mr-auto min-w-0 text-xs">{t(a.canAnswer ? "workflows.pipeline.askHint" : "workflows.ask.readOnly")}</p>
            <Link href={`/app/chat/ask/${a.runId}`} className={cx(btnPrimary, btnSm, "shrink-0 no-underline")}>
              {t(a.canAnswer ? "workflows.pipeline.answer" : "workflows.ask.open")}
            </Link>
          </div>
        </section>
      ))}
    </div>
  );
}
