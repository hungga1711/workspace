"use client";

import { useFormat, useT } from "@/lib/i18n/client";
import { DEFAULT_IMAGE, type WorkflowConfig, type WorkflowStep } from "../types";
import type { FactKey } from "./shared";

/**
 * A workflow's harness in five short rows, for someone deciding whether to use it: where it runs, what the AI reads,
 * who or what checks the work, its limits, and where the result goes. Self-contained: reads only the config and steps.
 */
export function HarnessFacts({ config, steps }: { config: WorkflowConfig; steps: Pick<WorkflowStep, "kind">[] }) {
  const t = useT();
  const f = useFormat();
  const k = (key: FactKey, vars?: Record<string, string | number>) => t(`workflows.library.facts.${key}`, vars);
  const e = config.environment;
  const r = config.resources;
  const g = config.guardrails;
  const o = config.output;

  const runs = [t(`workflows.env.${e.kind}`)];
  if (e.kind === "sandbox") {
    runs.push(e.isolation === "container" ? `${t("workflows.env.container")} ${e.image || DEFAULT_IMAGE}` : t("workflows.env.folder"));
    if (e.isolation === "container" && e.network === "off") runs.push(t("workflows.env.noNetwork"));
    if (e.host === "company") runs.push(t("workflows.env.companyRunner"));
    if (e.repo) runs.push(k("repo"));
  }

  const reads = [
    r.taskContext ? k("taskContext") : k("taskOnly"),
    r.notes.trim() ? t("workflows.studio.res.fact.instructions") : "",
    r.docs.length ? k("pages", { count: r.docs.length }) : "",
    // Uploaded files and files from the Drive read the same to the AI: one count.
    r.files.length + (r.drive?.length ?? 0) ? k("files", { count: r.files.length + (r.drive?.length ?? 0) }) : "",
    r.tasks?.length ? t("workflows.studio.res.fact.tasks", { count: r.tasks.length }) : "",
    r.links.length ? k("links", { count: r.links.length }) : "",
    r.taskFiles && e.kind !== "assistant" ? k("taskFiles") : "",
  ].filter(Boolean);

  const checks = steps.filter((s) => s.kind === "check").length;
  const approvals = steps.filter((s) => s.kind === "approval").length;
  const verified = [checks ? k("checks", { count: checks }) : "", approvals ? k("approvals", { count: approvals }) : ""].filter(Boolean);

  const limits = [
    k("minutes", { n: g.maxMinutes }),
    g.maxTokens ? k("tokens", { n: f.number(g.maxTokens) }) : "",
    g.ask === "never" ? k("neverAsks") : k("mayAsk"),
    config.autoStart ? k("autoStart") : "",
  ].filter(Boolean);

  const delivers = [
    o.comment ? k("comment") : "",
    o.doc ? k("doc") : "",
    o.files && e.kind !== "assistant" ? k("outFiles") : "",
    o.subtasks ? k("subtasks") : "",
    o.status ? k("status", { status: f.status(o.status) ?? o.status }) : "",
  ].filter(Boolean);

  const rows: [string, string][] = [
    [k("runsIn"), runs.join(" · ")],
    [k("reads"), reads.join(" · ")],
    [k("verifiedBy"), verified.join(" · ") || k("nobody")],
    [k("limits"), limits.join(" · ")],
    [k("delivers"), delivers.join(" · ") || k("nothing")],
  ];
  return (
    <dl className="bg-ground ring-hairline m-0 grid gap-x-4 gap-y-2 rounded-xl p-4 text-[13px] ring-1 ring-inset sm:grid-cols-[7.5rem_minmax(0,1fr)]">
      {rows.map(([label, value]) => (
        <div key={label} className="contents max-sm:grid max-sm:gap-0.5">
          <dt className="text-ink-2">{label}</dt>
          <dd className="text-ink m-0 min-w-0 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
