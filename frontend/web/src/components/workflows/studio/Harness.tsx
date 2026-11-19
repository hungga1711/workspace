"use client";

import { useFormat, useT } from "@/lib/i18n/client";
import { cx, input, textarea } from "@/lib/ui";
import { BookmarkIcon, ClockIcon, InfoIcon, SendIcon, ShieldIcon } from "@/components/app/icons";
import { Picker } from "@/components/ui/Picker";
import { ENV_ICON } from "../bits";
import { bySeverity, type Analysis, type Finding, type Section } from "../analyze";
import type { InputField, WorkflowConfig, WorkflowStep } from "../types";

/** The workflow's harness read back in plain words: where it runs, what it reads, who verifies, its limits, what it delivers. */
export function useHarnessFacts() {
  const t = useT();
  const f = useFormat();
  return (config: WorkflowConfig, a: Pick<Analysis, "summary">) => {
    const env = config.environment;
    const runs = [t(`workflows.env.${env.kind}`)];
    if (env.kind === "sandbox") {
      runs.push(env.isolation === "container" ? (env.image ?? t("workflows.env.container")) : t("workflows.env.folder"));
      if (env.isolation === "container" && env.network === "off") runs.push(t("workflows.env.noNetwork"));
      runs.push(t(env.host === "company" ? "workflows.env.companyRunner" : "workflows.studio.facts.myRunner"));
    }
    const r = config.resources;
    const reads = [
      r.taskContext ? t("workflows.studio.facts.task") : t("workflows.studio.facts.taskOnly"),
      r.notes.trim() ? t("workflows.studio.res.fact.instructions") : "",
      r.docs.length ? t("workflows.studio.facts.pages", { count: r.docs.length }) : "",
      // Uploaded files and files from the Drive read the same to the AI: one count.
      r.files.length + (r.drive?.length ?? 0) ? t("workflows.studio.facts.files", { count: r.files.length + (r.drive?.length ?? 0) }) : "",
      r.tasks?.length ? t("workflows.studio.res.fact.tasks", { count: r.tasks.length }) : "",
      r.links.length ? t("workflows.studio.facts.links", { count: r.links.length }) : "",
      config.inputs.length ? t("workflows.studio.facts.inputs", { count: config.inputs.length }) : "",
    ].filter(Boolean);
    const verified = [
      a.summary.checks ? t("workflows.studio.facts.checks", { count: a.summary.checks }) : "",
      a.summary.approvals ? t("workflows.studio.facts.approvals", { count: a.summary.approvals }) : "",
    ].filter(Boolean);
    const g = config.guardrails;
    const limits = [
      t("workflows.studio.facts.runMin", { n: g.maxMinutes }),
      t("workflows.studio.facts.stepMin", { n: g.stepMinutes }),
      g.maxTokens && env.kind === "assistant" ? t("workflows.studio.facts.tokens", { n: f.number(g.maxTokens) }) : "",
      t(g.ask === "never" ? "workflows.studio.facts.neverAsks" : "workflows.studio.facts.mayAsk"),
    ].filter(Boolean);
    const o = config.output;
    const delivers = [
      o.comment ? t("workflows.studio.facts.comment") : "",
      o.doc ? t("workflows.studio.facts.doc") : "",
      o.files ? t("workflows.studio.facts.outFiles") : "",
      o.subtasks ? t("workflows.studio.facts.subtasks") : "",
      o.status ? t("workflows.studio.facts.moves", { status: f.status(o.status) ?? o.status }) : "",
    ].filter(Boolean);
    return [
      { key: "runs" as const, section: "environment" as Section, icon: ENV_ICON[env.kind], text: runs.join(" · "), weak: false },
      { key: "reads" as const, section: "resources" as Section, icon: <BookmarkIcon />, text: reads.join(" · "), weak: false },
      {
        key: "verified" as const,
        section: "steps" as Section,
        icon: <ShieldIcon />,
        text: verified.join(" · ") || t("workflows.studio.facts.unverified"),
        weak: !verified.length,
      },
      { key: "limits" as const, section: "guardrails" as Section, icon: <ClockIcon />, text: limits.join(" · "), weak: false },
      { key: "delivers" as const, section: "output" as Section, icon: <SendIcon />, text: delivers.join(" · ") || t("workflows.studio.facts.nothing"), weak: !delivers.length },
    ];
  };
}

/**
 * The five facts as rows (the studio's Preflight) or as a strip of tiles (the workflow's page). With `onPick` each
 * fact is a button that opens the section it comes from.
 */
export function HarnessSummary({
  config,
  analysis,
  layout = "rows",
  onPick,
}: {
  config: WorkflowConfig;
  analysis: Pick<Analysis, "summary">;
  layout?: "rows" | "strip";
  onPick?: (s: Section) => void;
}) {
  const t = useT();
  const facts = useHarnessFacts()(config, analysis);
  return (
    <ul
      className={cx(
        "m-0 grid min-w-0 list-none p-0",
        layout === "strip" ? "bg-surface shadow-card divide-divider-soft divide-y rounded-xl lg:grid-cols-5 lg:divide-x lg:divide-y-0" : "gap-0.5",
      )}
    >
      {facts.map((x) => {
        const body = (
          <>
            <span
              aria-hidden="true"
              className={cx("bg-hover text-ink-soft mt-px grid size-6 shrink-0 place-items-center rounded-md [&_svg]:size-3.5", x.weak && "bg-warn-wash text-warn")}
            >
              {x.icon}
            </span>
            <span className="grid min-w-0 flex-1">
              <span className="text-ink-2 text-xs">{t(`workflows.studio.facts.${x.key}`)}</span>
              <span className={cx("text-[13px]/5 [overflow-wrap:anywhere]", x.weak ? "text-warn" : "text-ink")}>{x.text}</span>
            </span>
          </>
        );
        const cls = cx("flex min-w-0 items-start gap-2.5 text-left", layout === "strip" ? "px-4 py-3" : "rounded-lg px-2 py-1.5");
        return (
          <li key={x.key} className="min-w-0">
            {onPick ? (
              <button type="button" className={cx(cls, "hover:bg-hover w-full")} onClick={() => onPick(x.section)}>
                {body}
              </button>
            ) : (
              <div className={cls}>{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export const SEVERITY: Record<Finding["severity"], string> = {
  error: "bg-block-wash text-block",
  warn: "bg-warn-wash text-warn",
  info: "bg-hover text-ink-soft",
};

/** One thing to check, in its severity's tint; names its step when it has one. `onPick` makes it open where to fix it. */
export function FindingLine({ x, steps, onPick }: { x: Finding; steps?: Pick<WorkflowStep, "title">[]; onPick?: (x: Finding) => void }) {
  const t = useT();
  const text = (
    <>
      {steps && x.step !== null && steps[x.step] ? <span className="font-medium">{t("workflows.bp.stepRef", { n: x.step + 1, step: steps[x.step]!.title })}: </span> : null}
      {t(`workflows.findings.${x.code}`, x.params ?? {})}
    </>
  );
  const cls = cx("flex w-full min-w-0 items-start gap-2 rounded-lg px-2.5 py-2 text-left text-[13px]/5", SEVERITY[x.severity]);
  return (
    <li className="min-w-0">
      {onPick ? (
        <button type="button" className={cx(cls, "hover:brightness-[0.97]")} onClick={() => onPick(x)}>
          <InfoIcon className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 [overflow-wrap:anywhere]">{text}</span>
        </button>
      ) : (
        <span className={cls}>
          <InfoIcon className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 [overflow-wrap:anywhere]">{text}</span>
        </span>
      )}
    </li>
  );
}

/** Everything to check, errors first. */
export function FindingList({ findings, steps, onPick }: { findings: Finding[]; steps: Pick<WorkflowStep, "title">[]; onPick?: (x: Finding) => void }) {
  return (
    <ul className="m-0 grid list-none gap-1.5 p-0">
      {bySeverity(findings).map((x, k) => (
        <FindingLine key={k} x={x} steps={steps} {...(onPick ? { onPick } : {})} />
      ))}
    </ul>
  );
}

/**
 * The form a person fills when they press Run, drawn from the workflow's inputs. Read-only here (a preview): the
 * fields take typing so the form can be tried, nothing is kept.
 */
export function RunFormPreview({ fields, className }: { fields: InputField[]; className?: string }) {
  const t = useT();
  if (!fields.length) return null;
  return (
    <div className={cx("bg-ground ring-hairline grid gap-3 rounded-xl p-3.5 ring-1 ring-inset", className)}>
      {fields.map((f, i) => (
        <label key={i} className="grid min-w-0 gap-1">
          <span className="text-ink text-[13px] font-medium">
            {f.label || t("workflows.studio.inputs.untitled")}
            {f.required ? (
              <span className="text-block" aria-hidden="true">
                {" *"}
              </span>
            ) : null}
          </span>
          {f.type === "long" ? (
            <textarea className={cx(textarea, "min-h-16")} placeholder={f.placeholder} defaultValue={f.default} key={`${f.default}`} />
          ) : f.type === "choice" ? (
            <PreviewChoice f={f} />
          ) : (
            <input
              className={input}
              type={f.type === "number" ? "number" : f.type === "date" ? "date" : "text"}
              placeholder={f.placeholder}
              defaultValue={f.default}
              key={`${f.type}${f.default}`}
            />
          )}
        </label>
      ))}
    </div>
  );
}

function PreviewChoice({ f }: { f: InputField }) {
  const t = useT();
  const options = (f.options ?? []).filter(Boolean);
  return (
    <Picker
      variant="field"
      label={f.label}
      value={f.default && options.includes(f.default) ? f.default : ""}
      onChange={() => undefined}
      placeholder={f.placeholder || t("workflows.studio.inputs.choose")}
      options={options.map((o) => ({ value: o, label: o }))}
    />
  );
}
