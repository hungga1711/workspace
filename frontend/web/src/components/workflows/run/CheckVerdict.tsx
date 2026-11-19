"use client";

import { useT } from "@/lib/i18n/client";
import { cx } from "@/lib/ui";
import { CheckIcon, ShieldIcon } from "@/components/app/icons";
import type { RunStep } from "../types";

/**
 * A check's verdict. Passed is one quiet green line ("Passed · round 2 of 3"); failed lists what it found and says
 * what the engine did with it: sent the work back, went on with the issues on record, or stopped the run.
 */
export function CheckVerdict({
  step,
  from,
  compact,
}: {
  step: Pick<RunStep, "verdict" | "attempts" | "onFail" | "state" | "criteria" | "command">;
  /** The step whose result it judges. */
  from?: string | undefined;
  compact?: boolean;
}) {
  const t = useT();
  const v = step.verdict;
  if (!v)
    return compact ? null : (
      <div className="grid gap-3">
        {from ? <p className="text-ink-2 m-0 text-sm">{t("workflows.run.check.pending", { step: from })}</p> : null}
        <Criteria step={step} />
      </div>
    );
  // The rounds a check may judge: the first, then one per send-back.
  const max = (step.attempts ?? 2) + 1;
  const round = v.round <= max ? t("workflows.run.check.round", { n: v.round, max }) : t("workflows.run.check.roundOnly", { n: v.round });
  if (v.pass)
    return (
      <div className="grid gap-3">
        <p className="text-ok m-0 flex items-center gap-1.5 text-sm font-medium [&_svg]:size-4">
          <CheckIcon />
          {t("workflows.run.check.passed")}
          <span className="text-ink-2 font-normal tabular-nums">· {round}</span>
        </p>
        {compact ? null : <Criteria step={step} />}
      </div>
    );
  const after = step.state === "failed" ? "stopped" : step.state === "done" ? "continued" : from ? "sentBack" : null;
  return (
    <div className="grid gap-3">
      <div className={cx("bg-rose-wash/50 ring-rose-text/15 grid min-w-0 gap-2 rounded-xl px-3.5 py-3 ring-1 ring-inset", compact && "px-3 py-2.5")}>
        <p className="text-rose-text m-0 flex items-center gap-1.5 text-sm font-medium [&_svg]:size-4">
          <ShieldIcon />
          {t("workflows.run.check.failed")}
          <span className="text-ink-2 font-normal tabular-nums">· {round}</span>
        </p>
        {v.issues.length ? (
          <ul aria-label={t("workflows.run.check.issues")} className="text-ink m-0 grid list-disc gap-1 pl-5 text-[13px]/5">
            {v.issues.map((x, i) => (
              <li key={i} className="break-words">
                {x}
              </li>
            ))}
          </ul>
        ) : null}
        {after ? (
          <p className="text-ink-2 m-0 text-xs">{after === "sentBack" ? t("workflows.run.check.sentBack", { step: from ?? "" }) : t(`workflows.run.check.${after}`)}</p>
        ) : null}
      </div>
      {compact ? null : <Criteria step={step} />}
    </div>
  );
}

function Criteria({ step }: { step: Pick<RunStep, "criteria" | "command"> }) {
  const t = useT();
  if (step.command)
    return (
      <div className="grid gap-1.5">
        <p className="text-ink-2 m-0 text-xs font-medium">{t("workflows.run.check.command")}</p>
        <pre className="text-ink-soft bg-ground ring-hairline m-0 whitespace-pre-wrap break-words rounded-lg px-3 py-2 font-mono text-[12.5px]/5 ring-1 ring-inset">
          {step.command}
        </pre>
      </div>
    );
  const lines = (step.criteria ?? "")
    .split("\n")
    .map((l) => l.replace(/^\s*[-*•]\s*/, "").trim())
    .filter(Boolean);
  if (!lines.length) return null;
  return (
    <div className="grid gap-1.5">
      <p className="text-ink-2 m-0 text-xs font-medium">{t("workflows.run.check.criteria")}</p>
      <ul className="text-ink-soft m-0 grid list-disc gap-0.5 pl-5 text-[13px]/5">
        {lines.map((l, i) => (
          <li key={i} className="break-words">
            {l}
          </li>
        ))}
      </ul>
    </div>
  );
}
