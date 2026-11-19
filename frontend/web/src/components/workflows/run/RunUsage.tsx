"use client";

import { useFormat, useT } from "@/lib/i18n/client";
import { cx } from "@/lib/ui";
import { duration } from "../Graph";
import type { Run } from "../types";

/** A thin bar of used against a limit: blue, orange near the limit, red past it. */
function Meter({ pct }: { pct: number }) {
  const p = Math.max(0, Math.min(100, pct));
  return (
    <span aria-hidden="true" className="bg-progress-track block h-1 w-full overflow-hidden rounded-full">
      <span className={cx("block h-full rounded-full", pct >= 100 ? "bg-block" : pct >= 80 ? "bg-warn-fill" : "bg-progress")} style={{ width: `${p}%` }} />
    </span>
  );
}

/**
 * What a run has spent against its guardrails: working time over the time limit as a thin bar, tokens over the budget
 * when one is set (else just the count). Nothing for a run from before usage was recorded.
 */
export function RunUsage({ run, className }: { run: Pick<Run, "usage" | "config">; className?: string }) {
  const t = useT();
  const { number } = useFormat();
  const u = run.usage;
  if (!u) return null;
  const g = run.config?.guardrails;
  const tokens = (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
  const limitMs = (g?.maxMinutes ?? 0) * 60_000;
  const used = duration(Math.max(0, u.workMs ?? 0) / 1000) || "0s";
  if (!u.workMs && !tokens) return null;
  return (
    <dl aria-label={t("workflows.run.usage.label")} className={cx("m-0 flex min-w-0 flex-wrap items-end gap-x-5 gap-y-2", className)}>
      <div className="grid min-w-[7rem] flex-1 gap-1 sm:max-w-44">
        <dt className="sr-only">{t("workflows.pipeline.facts.took")}</dt>
        <dd className="text-ink-2 m-0 truncate text-xs tabular-nums">
          {limitMs ? t("workflows.run.usage.time", { used, limit: t("workflows.run.usage.min", { count: g!.maxMinutes }) }) : t("workflows.run.usage.timeOnly", { used })}
        </dd>
        {limitMs ? <Meter pct={((u.workMs ?? 0) / limitMs) * 100} /> : null}
      </div>
      {tokens ? (
        <div className="grid min-w-[7rem] flex-1 gap-1 sm:max-w-44">
          <dt className="sr-only">{t("workflows.pipeline.facts.tokens")}</dt>
          <dd className="text-ink-2 m-0 truncate text-xs tabular-nums">
            {g?.maxTokens ? t("workflows.run.usage.tokens", { used: number(tokens), limit: number(g.maxTokens) }) : t("workflows.run.usage.tokensOnly", { used: number(tokens) })}
          </dd>
          {g?.maxTokens ? <Meter pct={(tokens / g.maxTokens) * 100} /> : null}
        </div>
      ) : null}
    </dl>
  );
}
