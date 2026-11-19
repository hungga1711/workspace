"use client";

import { useFormat, useT } from "@/lib/i18n/client";
import { useDirectory } from "@/lib/people";
import { MAX_ASK_ROUNDS, type AskRound } from "./types";

/** Who closed a round and how: answered, left to the AI, or the run was cancelled. */
export function useAskOutcome() {
  const t = useT();
  const dir = useDirectory();
  return (r: AskRound) =>
    r.outcome === "cancelled"
      ? t("workflows.ask.cancelled")
      : r.outcome === "skipped"
        ? t("workflows.ask.skipped", { name: dir.name(r.answeredBy ?? "") })
        : t("workflows.ask.answeredBy", { name: dir.name(r.answeredBy ?? "") });
}

/** A step's closed rounds of questions, each question with its answer (the pipeline's record of what was asked). */
export function AskHistory({ rounds }: { rounds: AskRound[] }) {
  const t = useT();
  const { time } = useFormat();
  const outcome = useAskOutcome();
  if (!rounds.length) return null;
  return (
    <div className="grid gap-2">
      {rounds.map((r) => (
        <div key={r.id} className="bg-ground ring-hairline grid gap-2 rounded-xl p-3.5 ring-1 ring-inset">
          <p className="text-ink-2 m-0 text-xs">
            {t("workflows.ask.round", { n: r.round, max: Math.max(MAX_ASK_ROUNDS, r.round) })} · {outcome(r)}
            {r.closedAt ? ` · ${time(r.closedAt)}` : ""}
          </p>
          <dl className="m-0 grid gap-2">
            {r.questions.map((q) => (
              <div key={q.id} className="grid gap-0.5">
                <dt className="text-ink text-[13px] font-medium">{q.text}</dt>
                <dd className="text-ink-soft m-0 whitespace-pre-wrap text-[13px]">{r.answers?.[q.id] ?? "—"}</dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </div>
  );
}
