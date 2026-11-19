"use client";

import { Check, GitPullRequest, Hand, LoaderCircle, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";

// A run of the "Ship a change" template (backend/server/src/modules/work/workflows/templates.ts), played out once the card
// scrolls into view. It runs the plan, then stops at the approval step until the reader presses Approve, the way a
// real run waits in `waiting_approval` for a person.

const STEPS: [string, string][] = [
  ["Plan", "Reads the task, the repo and similar finished tasks"],
  ["Approve the plan", "Waits for a person"],
  ["Implement", "Codes on its own branch"],
  ["Tests pass", "npm test · 12 passed"],
  ["Self-review", "Reads its own diff"],
  ["Tests still pass", "npm test · 12 passed"],
  ["Open a pull request", "branch t-077 · +65 −5"],
  ["Move to In review", "The task moves on the board"],
];
const APPROVAL = 1;
const STEP_MS = 1100;

export function WorkflowRun() {
  const ref = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState(-1);
  const [approved, setApproved] = useState(false);

  // Start once the card is on screen; reduced motion jumps straight to the approval.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setStep(APPROVAL);
      return;
    }
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setStep((s) => (s < 0 ? 0 : s));
          io.disconnect();
        }
      },
      { threshold: 0.4 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (step < 0 || step >= STEPS.length) return;
    if (step === APPROVAL && !approved) return;
    const t = setTimeout(() => setStep((s) => s + 1), STEP_MS);
    return () => clearTimeout(t);
  }, [step, approved]);

  const waiting = step === APPROVAL && !approved;
  const done = step >= STEPS.length;

  return (
    <div ref={ref} className="overflow-hidden rounded-xl bg-panel shadow-[0_0_0_1px_var(--color-hair),0_30px_60px_-30px_rgba(0,0,0,0.9)]">
      <div className="flex items-center justify-between gap-3 border-b border-hair px-5 py-3.5">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-ink">
            <span className="mr-2 font-mono text-xs text-ink-4">T-077</span>Ship a change
          </p>
          <p className="mt-0.5 text-xs text-ink-3">Runs on Minh&apos;s computer · Claude Code</p>
        </div>
        <span className="shrink-0 rounded-full bg-muted px-2.5 py-1 font-mono text-xs text-ink-2 tabular-nums">
          {Math.min(Math.max(step + 1, 1), STEPS.length)} of {STEPS.length}
        </span>
      </div>

      <ol className="px-5 py-4">
        {STEPS.map(([title, sub], i) => {
          const state = i < step || done ? "done" : i === step ? (waiting ? "waiting" : "running") : "pending";
          return (
            <li key={title} className="relative flex gap-3 pb-3.5 last:pb-0">
              {i < STEPS.length - 1 ? (
                <span aria-hidden className={`absolute top-6 bottom-0 left-[11px] w-px ${state === "done" ? "bg-signal/60" : "bg-hair"}`} />
              ) : null}
              <span
                className={`relative z-10 inline-flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] [&_svg]:size-3.5 ${
                  state === "done"
                    ? "bg-signal text-white"
                    : state === "running"
                      ? "bg-signal-wash text-signal-text shadow-[0_0_0_1px_var(--color-signal)]"
                      : state === "waiting"
                        ? "bg-[#f5a524]/15 text-[#f5a524] shadow-[0_0_0_1px_#f5a524]"
                        : "bg-muted text-ink-4"
                }`}
              >
                {state === "done" ? <Check /> : state === "running" ? <LoaderCircle className="animate-spin" /> : state === "waiting" ? <Hand /> : i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className={`text-sm ${state === "pending" ? "text-ink-4" : "text-ink"}`}>{title}</p>
                <p className={`text-xs ${state === "pending" ? "text-ink-4/70" : "text-ink-3"}`}>{sub}</p>
                {state === "waiting" ? (
                  <div className="mt-2.5 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setApproved(true)}
                      className="inline-flex h-8 items-center rounded-md bg-ink px-3 text-xs font-medium text-ground transition-colors hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
                    >
                      Approve
                    </button>
                    <span className="text-xs text-ink-3">or send it back with a note</span>
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>

      <div className="flex items-center justify-between gap-3 border-t border-hair bg-subtle px-5 py-3 text-xs">
        {done ? (
          <>
            <span className="inline-flex items-center gap-2 text-ink-2">
              <GitPullRequest className="size-4 text-ok" /> Pull request opened, task in review
            </span>
            <button
              type="button"
              onClick={() => {
                setApproved(false);
                setStep(0);
              }}
              className="inline-flex items-center gap-1.5 text-ink-3 hover:text-ink"
            >
              <RotateCcw className="size-3.5" /> Run again
            </button>
          </>
        ) : (
          <span className="text-ink-3">{waiting ? "Waiting for a person. Nothing runs until someone decides." : step < 0 ? "Queued" : "Running"}</span>
        )}
      </div>
    </div>
  );
}
