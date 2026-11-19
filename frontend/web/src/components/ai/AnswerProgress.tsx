"use client";

import { useState } from "react";
import { useT } from "@/lib/i18n/client";
import { cx } from "@/lib/ui";

/** One tool call of an answer, as the server words it (progress.ts), in the answer's language. */
export interface AnswerStep {
  id: string;
  tool: string;
  text: string;
  state: "running" | "done" | "failed";
}

/**
 * What the AI is doing while it answers ("Reading overdue tasks: Engineering…"), from the stream's `step` events; once
 * the answer is written, one quiet line ("Used 3 tools") that opens to the same list. Nothing when no tool ran.
 */
export function AnswerProgress({ steps, live }: { steps: AnswerStep[] | undefined; live: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  if (!steps?.length) return null;
  if (live)
    return (
      <ul className="m-0 mb-2 grid list-none gap-1 p-0 text-xs" aria-live="polite" aria-label={t("aiw.chat.steps.label")}>
        {steps.slice(-4).map((s) => (
          <Line key={s.id} step={s} />
        ))}
      </ul>
    );
  return (
    <div className="mb-1.5 text-xs">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="text-ink-2 hover:text-ink -ml-1 inline-flex items-center gap-1 rounded px-1 py-0.5 transition-colors"
      >
        <span aria-hidden className={cx("inline-block transition-transform", open && "rotate-90")}>
          ›
        </span>
        {t("aiw.chat.steps.used", { count: steps.length })}
      </button>
      {open ? (
        <ul className="m-0 mt-1 grid list-none gap-1 p-0 pl-4" aria-label={t("aiw.chat.steps.label")}>
          {steps.map((s) => (
            <Line key={s.id} step={s} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Line({ step }: { step: AnswerStep }) {
  return (
    <li className={cx("flex min-w-0 items-center gap-2", step.state === "failed" ? "text-warn" : "text-ink-2")}>
      <span
        aria-hidden
        className={cx("size-1.5 shrink-0 rounded-full", step.state === "running" ? "bg-brand motion-safe:animate-pulse" : step.state === "failed" ? "bg-warn" : "bg-ink-2/40")}
      />
      <span className="truncate">{step.text}</span>
    </li>
  );
}

/** What limits the answer (a source it could not read, a partial view), under it in small print. */
export function AnswerNotes({ notes }: { notes: string[] | undefined }) {
  const t = useT();
  if (!notes?.length) return null;
  return (
    <ul className="text-ink-2 m-0 mt-2 grid list-none gap-0.5 p-0 text-xs" aria-label={t("aiw.chat.notesLabel")}>
      {notes.map((n) => (
        <li key={n} className="flex gap-1.5">
          <span aria-hidden>ⓘ</span>
          <span>{n}</span>
        </li>
      ))}
    </ul>
  );
}
