"use client";

import Link from "next/link";
import { useT } from "@/lib/i18n/client";
import { cx } from "@/lib/ui";
import { duration } from "../Graph";
import type { Environment, RunEnv, RunnerInfo, Workflow } from "../types";
import { runnerFor } from "./helpers";

/** What the runner actually gave the run, as short facts: "Container · python:3.12-slim · no network · 3 files · on MacBook". */
export function useEnvFacts() {
  const t = useT();
  return (env: RunEnv, device?: string | null): string[] => {
    const out: string[] = [];
    if (env.isolation) out.push(t(`workflows.run.env.${env.isolation}`));
    if (env.image) out.push(env.image);
    if (env.isolation === "container" && env.network) out.push(t(env.network === "off" ? "workflows.run.env.noNetwork" : "workflows.run.env.network"));
    if (env.assets) out.push(t("workflows.run.env.assets", { count: env.assets }));
    const on = env.device ?? device;
    if (on) out.push(t("workflows.run.env.on", { device: on }));
    return out;
  };
}

const STATE_TONE: Record<RunEnv["state"], string> = { preparing: "bg-accent-wash text-accent-text", ready: "bg-ok-wash text-ok", failed: "bg-block-wash text-block" };

/**
 * The pipeline's first stage on a runner: the environment it prepared (sandbox folder or container, repository, assets,
 * setup command). Facts as chips, what was asked against what was given said plainly, and the setup log to open.
 */
export function RunEnvironment({ env, asked, device }: { env: RunEnv; asked?: Environment | undefined; device?: string | null }) {
  const t = useT();
  const facts = useEnvFacts()(env, device);
  const took = env.startedAt && env.finishedAt ? duration((Date.parse(env.finishedAt) - Date.parse(env.startedAt)) / 1000) : "";
  const wantedContainer = asked?.kind === "sandbox" && asked.isolation === "container";
  return (
    <div className="grid max-w-3xl gap-4">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span className={cx("inline-flex h-6 items-center gap-1.5 rounded-full px-2 text-xs font-medium", STATE_TONE[env.state] ?? STATE_TONE.preparing)}>
          {env.state === "preparing" ? <span aria-hidden="true" className="size-1.5 rounded-full bg-current motion-safe:animate-pulse" /> : null}
          {t(`workflows.run.env.${env.state}`)}
        </span>
        {facts.map((f, i) => (
          <span key={i} className="bg-hover text-ink-soft inline-flex h-6 max-w-full items-center rounded-full px-2 text-xs">
            <span className="truncate">{f}</span>
          </span>
        ))}
        {took ? <span className="text-ink-2 text-xs tabular-nums">{t("workflows.run.env.took", { time: took })}</span> : null}
      </div>
      {wantedContainer && env.isolation && env.isolation !== "container" ? (
        <p className="bg-warn-wash text-warn m-0 rounded-lg px-3 py-2 text-[13px]">
          {t("workflows.run.env.downgraded", { given: t(`workflows.run.env.${env.isolation}`).toLowerCase() })}
        </p>
      ) : env.isolation === "container" && env.agentIn === "host" ? (
        <p className="bg-warn-wash text-warn m-0 rounded-lg px-3 py-2 text-[13px]">{t("workflows.run.env.agentHost")}</p>
      ) : env.isolation === "container" && env.agentIn === "container" ? (
        <p className="text-ink-2 m-0 text-[13px]">{t("workflows.run.env.agentContainer")}</p>
      ) : null}
      {env.state === "preparing" && !env.log ? (
        <p role="status" className="text-accent-text m-0 text-sm font-medium">
          {t("workflows.run.env.preparingNote")}
        </p>
      ) : null}
      <details open={env.state !== "ready"} className="group">
        <summary className="text-ink-2 hover:text-ink cursor-pointer text-xs font-medium">{t("workflows.run.env.log")}</summary>
        {env.log ? (
          <pre className="text-ink-soft bg-ground ring-hairline m-0 mt-1.5 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-xl px-4 py-3 font-mono text-[12.5px]/5 ring-1 ring-inset">
            {env.log}
          </pre>
        ) : (
          <p className="text-ink-2 m-0 mt-1.5 text-[13px]">{t("workflows.run.env.noLog")}</p>
        )}
      </details>
    </div>
  );
}

/**
 * Which computer will take a run of this workflow, before it starts: the reader's own, a company runner, or none yet
 * (a warning with the way to connect one; the run still queues). Nothing for the company's AI.
 */
export function RunnerLine({ workflow, runners, className }: { workflow: Pick<Workflow, "config" | "runner">; runners: RunnerInfo[] | undefined; className?: string }) {
  const t = useT();
  const r = runnerFor(workflow, runners);
  if (!r) return null;
  if (r.kind === "mine" || r.kind === "company")
    return (
      <p className={cx("text-ink-2 m-0 flex min-w-0 items-center gap-1.5 text-xs", className)}>
        <span aria-hidden="true" className="bg-ok-fill size-1.5 shrink-0 rounded-full" />
        <span className="min-w-0">{t(`workflows.run.runner.${r.kind}`, { device: r.device ?? "" })}</span>
      </p>
    );
  return (
    <p className={cx("bg-warn-wash text-warn m-0 rounded-md px-2.5 py-1.5 text-xs", className)}>
      {t(`workflows.run.runner.${r.kind}`)}{" "}
      <Link href="/app/ai/connect" className="font-medium text-current underline">
        {t("workflows.run.runner.connect")}
      </Link>
    </p>
  );
}
