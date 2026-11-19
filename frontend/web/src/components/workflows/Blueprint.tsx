"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useFormat, useT } from "@/lib/i18n/client";
import { useDirectory } from "@/lib/people";
import { btn, btnSm, cx } from "@/lib/ui";
import { CheckIcon, ChevronDownIcon, ChevronLeftIcon, CopyIcon, FileIcon, FlagIcon, InfoIcon, LinkIcon, PaperclipIcon, PencilIcon, PlayIcon } from "@/components/app/icons";
import { kb } from "@/components/chat/attachments";
import { CategoryTile, EnvBadge, STEP_TONE, StepNode } from "./bits";
import { duration } from "./Graph";
import { analyze, bySeverity, describeModel, type Analysis, type Finding, type ModelInfo, type StepFlow } from "./analyze";
import { fullConfig } from "./studio/draft";
import { FindingLine, HarnessSummary, RunFormPreview, SEVERITY } from "./studio/Harness";
import { StartsBlock } from "./StartsBlock";
import { UsualTime, useDuration, useWorkflowEstimate } from "./run/eta";
import type { ModelCatalog, Prompting, Runner, RunnerInfo, Workflow, WorkflowConfig, WorkflowStep, WorkflowUsage } from "./types";

// The description and a step's role are Markdown; the renderer loads with the page's text, not in its first chunk.
const Markdown = dynamic(() => import("@/lib/markdown").then((m) => m.Markdown));
// How the workflow performed lately (tokens, time, suggestions): read after the page, never part of its first load.
const WorkflowPerformance = dynamic(() => import("./library/Performance").then((m) => m.WorkflowPerformance), { ssr: false });
const md = "[&>div>:first-child]:mt-0 [&>div>:last-child]:mb-0 [&>div]:text-[13px]/5";

/**
 * A workflow drawn as it runs: one column, each step a single line (what it is and the
 * model or command it uses) that opens to the details on demand; the things to check sit folded in one bar at the
 * top. The harness around the steps is read back first (where it runs, what it reads, who verifies, its
 * limits, what it delivers), then the form a run asks for and the resources; editing happens in the studio.
 */
export function Blueprint({
  w,
  usage,
  catalog,
  prompting,
  runners,
}: {
  w: Workflow;
  /** undefined: the activity read failed (say nothing); null: never run. */
  usage: WorkflowUsage | null | undefined;
  /** null: the model list could not be read (no company AI, or the read failed). */
  catalog: ModelCatalog | null;
  prompting: Prompting | null;
  runners?: RunnerInfo[] | null;
}) {
  const t = useT();
  const f = useFormat();
  const config = fullConfig(w.config, w.runner === "local" ? "computer" : "assistant");
  const a = analyze(w.steps, w.runner, catalog, { config, runners: runners ?? null });
  const finished = usage ? usage.done30d + usage.failed30d : 0;
  // How long a run should take (each step and the whole), unless the workflow leaves estimates out.
  const estimate = useWorkflowEstimate(w.id, config.estimate !== false);
  const env = config.environment;
  const r = config.resources;
  const hasResources = !!r.notes.trim() || r.docs.length + r.files.length + (r.drive?.length ?? 0) + (r.tasks?.length ?? 0) + r.links.length > 0;
  const delivered = [
    config.output.comment ? t("workflows.studio.facts.comment") : "",
    config.output.doc ? t("workflows.studio.facts.doc") : "",
    config.output.subtasks ? t("workflows.studio.facts.subtasks") : "",
    config.output.files ? t("workflows.studio.facts.outFiles") : "",
  ].filter(Boolean);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
      <Link href="/app/ai/workflows" className="text-ink-2 hover:text-ink inline-flex items-center gap-1 justify-self-start text-[13px] no-underline">
        <ChevronLeftIcon className="size-4" />
        {t("workflows.title")}
      </Link>
      <header className="flex min-w-0 flex-wrap items-start gap-x-3.5 gap-y-3">
        <CategoryTile category={w.category} />
        <div className="min-w-0 flex-1 basis-64">
          <h1 className="font-display text-ink m-0 text-xl/7 font-semibold tracking-[-0.02em]">{w.name}</h1>
          {w.description ? (
            <div className={cx("text-ink-soft mt-0.5 text-[13px]", md)}>
              <Markdown source={w.description} />
            </div>
          ) : null}
          <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
            <span className="bg-hover text-ink-soft inline-flex h-6 items-center rounded-full px-2 text-xs font-medium">{t(`workflows.category.${w.category}`)}</span>
            <EnvBadge env={env} />
            {usage !== undefined ? (
              <span className="text-ink-2 text-xs tabular-nums">
                {usage?.runs30d
                  ? [
                      `${t("workflows.detail.last30")}: ${t("workflows.usage.runs", { count: usage.runs30d })}`,
                      finished ? `${Math.round((usage.done30d / finished) * 100)}% ${t("workflows.bp.doneShare")}` : "",
                      usage.avgSec ? t("workflows.studio.bp.avgTime", { time: duration(usage.avgSec) }) : "",
                      usage.avgTokens ? t("workflows.studio.bp.avgTokens", { n: f.number(Math.round(usage.avgTokens)) }) : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")
                  : t("workflows.detail.noRuns")}
              </span>
            ) : null}
            <UsualTime estimate={estimate} />
          </div>
          {usage?.runs30d ? <WorkflowPerformance workflowId={w.id} className="mt-2.5" /> : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Link href={`/app/ai/workflows/new?from=${w.id}`} className={cx(btn, btnSm)}>
            <CopyIcon />
            {t("workflows.studio.duplicate")}
          </Link>
          {w.canEdit ? (
            <Link href={`/app/ai/workflows/${w.id}/edit`} className={cx(btn, btnSm)}>
              <PencilIcon />
              {t("common.edit")}
            </Link>
          ) : null}
        </div>
      </header>

      <HarnessSummary config={config} analysis={a} layout="strip" />

      {a.findings.length ? <Findings findings={a.findings} steps={w.steps} /> : null}

      {/* How it starts by itself, and how that went lately. */}
      <StartsBlock w={{ id: w.id, config, canEdit: w.canEdit }} />

      {config.inputs.length || hasResources ? (
        <div className={cx("grid min-w-0 items-start gap-4", !!config.inputs.length && hasResources && "lg:grid-cols-2")}>
          {config.inputs.length ? (
            <section className="bg-surface shadow-card grid min-w-0 gap-3 rounded-xl p-4" aria-label={t("workflows.studio.section.inputs")}>
              <div>
                <h2 className="text-ink m-0 text-sm font-semibold">{t("workflows.studio.section.inputs")}</h2>
                <p className="text-ink-2 m-0 text-[13px]">{t("workflows.studio.bp.inputs")}</p>
              </div>
              <RunFormPreview fields={config.inputs} />
            </section>
          ) : null}
          {hasResources ? <ResourceList config={config} /> : null}
        </div>
      ) : null}

      <ol className="m-0 grid min-w-0 list-none p-0" aria-label={t("workflows.steps")}>
        <Spine>
          <div className="grid gap-1 pt-1.5">
            <p className="text-ink m-0 text-sm font-semibold">{t("workflows.bp.start")}</p>
            <p className="text-ink-2 m-0 text-[13px]">
              {t(
                env.kind === "sandbox"
                  ? env.host === "company"
                    ? "workflows.studio.bp.startSandboxCompany"
                    : "workflows.studio.bp.startSandbox"
                  : w.runner === "local"
                    ? "workflows.bp.startLocal"
                    : "workflows.bp.startServer",
              )}
              {config.autoStart ? ` ${t("workflows.studio.bp.autoStart")}` : ""}
            </p>
            <details className="mt-0.5">
              <summary className="text-accent-text w-fit cursor-pointer text-[13px] hover:underline">{t("workflows.bp.placeholders")}</summary>
              <div className="mt-2">
                <TaskInput prompting={prompting} />
              </div>
            </details>
          </div>
        </Spine>
        {w.steps.map((s, i) => (
          <Spine key={i} kind={s.kind}>
            <StepCard
              s={s}
              i={i}
              steps={w.steps}
              runner={w.runner}
              config={config}
              analysis={a}
              flow={a.flows[i]!}
              findings={a.findings.filter((x) => x.step === i)}
              model={
                s.kind === "ai" || (s.kind === "check" && !(w.runner === "local" && s.command))
                  ? describeModel(s.kind === "check" && !s.model && w.runner === "server" ? { model: "fast" } : s, w.runner, catalog)
                  : null
              }
              stats={usage?.steps?.[s.key]}
              usual={estimate?.steps?.[s.key]}
              catalog={catalog}
              prompting={prompting}
            />
          </Spine>
        ))}
        <Spine last>
          <div className="grid gap-1 pt-1.5">
            <p className="text-ink m-0 text-sm font-semibold">{t("workflows.bp.end")}</p>
            <p className="text-ink-2 m-0 text-[13px]">
              {a.summary.final >= 0 && delivered.length
                ? t("workflows.studio.bp.end", { n: a.summary.final + 1, step: w.steps[a.summary.final]!.title, how: delivered.join(" · ") })
                : t("workflows.bp.endNothing")}
              {config.output.status ? ` ${t("workflows.studio.bp.endMoves", { status: f.status(config.output.status) ?? config.output.status })}` : ""}
            </p>
          </div>
        </Spine>
      </ol>
    </div>
  );
}

/** What every AI step may read: the playbook, pages, files and links. */
function ResourceList({ config }: { config: WorkflowConfig }) {
  const t = useT();
  const r = config.resources;
  const item = "flex min-h-9 min-w-0 items-center gap-2.5 px-3 py-1.5 text-[13px] [&_svg]:size-4 [&_svg]:shrink-0";
  return (
    <section className="bg-surface shadow-card grid min-w-0 gap-3 rounded-xl p-4" aria-label={t("workflows.studio.section.resources")}>
      <div>
        <h2 className="text-ink m-0 text-sm font-semibold">{t("workflows.studio.section.resources")}</h2>
        <p className="text-ink-2 m-0 text-[13px]">{t("workflows.studio.bp.resources")}</p>
      </div>
      {r.notes.trim() ? (
        <details className="group/pb ring-hairline min-w-0 rounded-lg ring-1 ring-inset">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-[13px] font-medium [&::-webkit-details-marker]:hidden">
            <span className="flex-1">{t("workflows.studio.res.playbook")}</span>
            <ChevronDownIcon className="text-ink-2 size-4 transition-transform group-open/pb:rotate-180" />
          </summary>
          <div className={cx("border-divider-soft text-ink-soft max-h-80 overflow-auto border-t px-3 py-2.5", md)}>
            <Markdown source={r.notes} />
          </div>
        </details>
      ) : null}
      {r.docs.length + r.files.length + (r.drive?.length ?? 0) + (r.tasks?.length ?? 0) + r.links.length ? (
        <ul className="divide-divider-soft ring-hairline m-0 grid min-w-0 list-none divide-y rounded-lg p-0 ring-1 ring-inset">
          {r.docs.map((p) => (
            <li key={p.id} className={item}>
              <FileIcon className="text-ink-2" />
              <Link href={`/app/work/docs/${p.id}`} className="text-ink min-w-0 flex-1 truncate no-underline hover:underline">
                {p.title || t("workflows.studio.res.untitled")}
              </Link>
            </li>
          ))}
          {r.files.map((x) => (
            <li key={x.id} className={item}>
              <PaperclipIcon className="text-ink-2" />
              <a href={`/app/files/${x.id}`} target="_blank" rel="noreferrer" className="text-ink min-w-0 flex-1 truncate no-underline hover:underline">
                {x.name}
              </a>
              <span className="text-ink-2 shrink-0 text-xs tabular-nums">{kb(x.size)}</span>
            </li>
          ))}
          {(r.drive ?? []).map((x) => (
            <li key={x.id} className={item}>
              <PaperclipIcon className="text-ink-2" />
              <Link href={`/app/work/docs?view=files&q=${encodeURIComponent(x.name)}`} className="text-ink min-w-0 flex-1 truncate no-underline hover:underline">
                {x.name}
              </Link>
            </li>
          ))}
          {(r.tasks ?? []).map((x) => (
            <li key={x.id} className={item}>
              <CheckIcon className="text-ink-2" />
              <Link href={`/app/work/tasks/${x.code || x.id}`} className="text-ink min-w-0 flex-1 truncate no-underline hover:underline">
                {x.code ? `${x.code} · ${x.title}` : x.title}
              </Link>
            </li>
          ))}
          {r.links.map((l) => (
            <li key={l.url} className={item}>
              <LinkIcon className="text-ink-2" />
              <a href={l.url} target="_blank" rel="noreferrer" className="text-ink min-w-0 flex-1 truncate no-underline hover:underline">
                {l.title || l.url.replace(/^https?:\/\//, "")}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** One row of the pipeline: the node on the spine, the content beside it, the line on to the next. */
function Spine({ kind, last, children }: { kind?: WorkflowStep["kind"]; last?: boolean; children: React.ReactNode }) {
  return (
    <li className="grid grid-cols-[2.25rem_minmax(0,1fr)] gap-x-3 max-sm:grid-cols-[1.75rem_minmax(0,1fr)] max-sm:gap-x-2">
      <span className="flex flex-col items-center">
        {kind ? (
          <StepNode kind={kind} className="mt-2.5 max-sm:size-7 max-sm:[&_svg]:size-3.5" />
        ) : (
          <span aria-hidden="true" className="bg-ink text-on-brand mt-1 grid size-8 place-items-center rounded-full max-sm:size-7 [&_svg]:size-3.5">
            {last ? <FlagIcon /> : <PlayIcon />}
          </span>
        )}
        {last ? null : <span aria-hidden="true" className="bg-edge mt-1 w-px flex-1" />}
      </span>
      <div className="min-w-0 pb-3">{children}</div>
    </li>
  );
}

/** What each placeholder carries, with the server's limits. */
function TaskInput({ prompting }: { prompting: Prompting | null }) {
  const t = useT();
  const f = useFormat();
  const lim = prompting?.limits;
  const rows: [string, string][] = [
    ["task", t("workflows.bp.taskIs", { description: lim ? f.number(lim.description) : "4,000", context: lim ? f.number(lim.context) : "6,000" })],
    ["previous", t("workflows.bp.previousIs", { max: lim ? f.number(lim.previous) : "8,000" })],
    ["steps.key", t("workflows.studio.ph.steps")],
    ["input.key", t("workflows.studio.ph.input")],
    ["resources", t("workflows.studio.ph.resourcesIs", { max: lim?.resources ? f.number(lim.resources) : "12,000" })],
    ["answers", t("workflows.bp.answersIs")],
  ];
  return (
    <dl className="m-0 grid gap-1.5 text-[13px]">
      {rows.map(([name, text]) => (
        <div key={name} className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
          <dt>
            <Token name={name} />
          </dt>
          <dd className="text-ink-soft m-0 min-w-0 flex-1 basis-60">{text}</dd>
        </div>
      ))}
    </dl>
  );
}

const TONES = {
  sky: "bg-sky-wash text-sky-text ring-sky-text/20",
  violet: "bg-violet-wash text-violet-text ring-violet-text/20",
  tangerine: "bg-tangerine-wash text-tangerine-text ring-tangerine-text/20",
  green: "bg-ok-wash text-ok ring-ok/20",
};
/** A placeholder's tint by what it carries: the task sky, results violet, what people gave orange, resources green. */
const tokenTone = (name: string): string | undefined =>
  name === "task"
    ? TONES.sky
    : name === "previous" || name.startsWith("steps.")
      ? TONES.violet
      : name === "answers" || name === "inputs" || name.startsWith("input.")
        ? TONES.tangerine
        : name === "resources"
          ? TONES.green
          : undefined;
/** A placeholder as a small tinted token; unknown ones in red (the server leaves them as written). */
export function Token({ name, children }: { name: string; children?: React.ReactNode }) {
  return (
    <span className={cx("mx-px inline-flex items-center rounded px-1 font-mono text-[12px]/[18px] ring-1 ring-inset", tokenTone(name) ?? "bg-block-wash text-block ring-block/25")}>
      {children ?? `{{${name}}}`}
    </span>
  );
}

const TOKEN = /(\{\{\s*[a-zA-Z_][\w.-]*\s*\}\})/g;
/** An instruction with its placeholders drawn as tokens; `label` swaps a token's text (the "sent" view). */
function PromptText({ text, label, known }: { text: string; label?: (name: string) => string; known?: (name: string) => boolean }) {
  const parts = text.split(TOKEN);
  return (
    <>
      {parts.map((p, i) => {
        const m = /^\{\{\s*([a-zA-Z_][\w.-]*)\s*\}\}$/.exec(p);
        if (!m) return <span key={i}>{p}</span>;
        const name = m[1]!;
        // A key the workflow does not have is drawn like an unknown placeholder: it reaches the model as written.
        return (
          <Token key={i} name={known && !known(name) ? "?" : name}>
            {label?.(name) ?? `{{${name}}}`}
          </Token>
        );
      })}
    </>
  );
}

/** A step's model in a line: who and which model, and how it was chosen. */
export function ModelBadge({ info, className }: { info: ModelInfo; className?: string }) {
  const t = useT();
  const name = info.kind === "agentDefault" ? t("workflows.model.agentDefault") : info.kind === "none" ? t("workflows.model.none") : null;
  return (
    <span className={cx("inline-flex min-w-0 flex-wrap items-baseline gap-x-1.5", className)}>
      {name ? (
        <span className={cx("font-medium", info.kind === "none" ? "text-block" : "text-ink")}>{name}</span>
      ) : (
        <>
          {info.label ? <span className="text-ink font-medium">{info.label}</span> : null}
          <code className={cx("break-all font-mono text-[12.5px]", info.kind === "missing" ? "text-block" : "text-ink-soft")}>{info.model}</code>
        </>
      )}
      <span className="text-ink-2 text-xs">{t(`workflows.model.how.${info.kind}`)}</span>
    </span>
  );
}

function StepCard({
  s,
  i,
  steps,
  runner,
  config,
  analysis,
  flow,
  findings,
  model,
  stats,
  usual,
  catalog,
  prompting,
}: {
  s: WorkflowStep;
  i: number;
  steps: WorkflowStep[];
  runner: Runner;
  config: WorkflowConfig;
  analysis: Analysis;
  flow: StepFlow;
  findings: Finding[];
  model: ModelInfo | null;
  stats: { done: number; failed: number; avgSec: number | null; sentBack?: number } | undefined;
  /** What the step should take (seconds), shown until it has a real average of its own. */
  usual?: number | undefined;
  catalog: ModelCatalog | null;
  prompting: Prompting | null;
}) {
  const t = useT();
  const words = useDuration();
  const f = useFormat();
  const dir = useDirectory();
  const ref = (n: number | null) => (n === null ? "" : t("workflows.bp.stepRef", { n: n + 1, step: steps[n]!.title }));
  const worst = findings.some((x) => x.severity === "error") ? "error" : findings.some((x) => x.severity === "warn") ? "warn" : findings.length ? "info" : null;
  const byCommand = s.kind === "check" && runner === "local" && !!s.command?.trim();
  const approver =
    s.approver === "person" ? (s.approverId ? dir.name(s.approverId) : t("workflows.studio.approver.person")) : t(`workflows.studio.approver.${s.approver ?? "editors"}`);
  const modelLine = model ? (
    model.kind === "agentDefault" ? (
      t("workflows.model.agentDefault")
    ) : model.kind === "none" ? (
      <span className="text-block">{t("workflows.model.none")}</span>
    ) : (
      (model.label ?? model.model)
    )
  ) : null;
  // The one line a step needs closed: the model it asks, the command it runs, what is checked or who approves.
  const line =
    s.kind === "ai" ? (
      modelLine
    ) : s.kind === "command" || byCommand ? (
      <code className="font-mono text-[12.5px]">$ {s.command}</code>
    ) : s.kind === "check" ? (
      flow.previousFrom === null ? (
        t("workflows.bp.seesNothing")
      ) : (
        t("workflows.studio.bp.sumCheck", { step: ref(flow.previousFrom) })
      )
    ) : s.kind === "approval" ? (
      flow.previousFrom === null ? (
        t("workflows.bp.seesNothing")
      ) : (
        `${approver} · ${ref(flow.previousFrom)}`
      )
    ) : (
      (f.status(s.status ?? "review") ?? s.status ?? "")
    );
  const limits = [
    s.timeoutMin ? t("workflows.studio.facts.stepMin", { n: s.timeoutMin }) : "",
    s.retries ? t("workflows.studio.bp.retries", { count: s.retries }) : "",
    s.kind === "ai" && runner === "server" && s.maxOutput ? t("workflows.studio.bp.maxOutput", { n: f.number(s.maxOutput) }) : "",
  ].filter(Boolean);
  const attempts = s.attempts ?? 2;
  return (
    <details id={`step-${i + 1}`} className="bg-surface shadow-card group/step min-w-0 scroll-mt-20 rounded-xl">
      <summary className="hover:bg-hover/60 flex min-w-0 cursor-pointer list-none items-center gap-3 rounded-xl px-4 py-3 max-sm:px-3.5 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="text-ink-2 shrink-0 text-xs tabular-nums">{i + 1}</span>
            <span className="text-ink truncate text-sm font-semibold tracking-[-0.01em]">{s.title}</span>
          </span>
          <span className="text-ink-2 mt-0.5 flex min-w-0 items-baseline gap-1.5 text-[13px]">
            <span className={cx("shrink-0 font-medium", TEXT[STEP_TONE[s.kind]])}>{t(`workflows.kind.${s.kind}`)}</span>
            {line ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="truncate">{line}</span>
              </>
            ) : null}
          </span>
        </span>
        {stats && stats.done + stats.failed ? (
          <span className="text-ink-2 shrink-0 text-xs tabular-nums max-sm:hidden">
            {t("workflows.detail.stepStats", { done: stats.done, failed: stats.failed })}
            {stats.sentBack ? ` · ${t("workflows.studio.bp.sentBack", { count: stats.sentBack })}` : ""}
            {stats.avgSec !== null ? ` · ${duration(stats.avgSec)}` : ""}
          </span>
        ) : usual && usual > 0 ? (
          <span className="text-ink-2 shrink-0 text-xs tabular-nums max-sm:hidden">{t("workflows.run.eta.short", { d: words(usual) })}</span>
        ) : null}
        {worst ? (
          <span
            title={t("workflows.bp.findings", { count: findings.length })}
            className={cx("inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-1.5 text-xs font-medium tabular-nums", SEVERITY[worst])}
          >
            <InfoIcon className="size-3" />
            {findings.length}
          </span>
        ) : null}
        <ChevronDownIcon className="text-ink-2 size-4 shrink-0 transition-transform group-open/step:rotate-180" />
      </summary>

      <div className="border-divider grid min-w-0 gap-3 border-t px-4 py-3.5 max-sm:px-3.5">
        {s.kind === "ai" && model ? (
          <>
            <dl className="m-0 grid gap-x-4 gap-y-2 text-[13px] sm:grid-cols-[7.5rem_minmax(0,1fr)]">
              <Row label={t("workflows.bp.model")}>
                <ModelBadge info={model} />
              </Row>
              {s.role ? (
                <Row label={t("workflows.bp.role")}>
                  <div className={cx("text-ink-soft min-w-0", md)}>
                    <Markdown source={s.role} />
                  </div>
                </Row>
              ) : null}
              <Row label={t("workflows.bp.input")}>
                <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                  {flow.task ? <Chip name="task">{t("workflows.bp.inTask")}</Chip> : null}
                  {flow.previous ? (
                    <Chip name="previous">{flow.previousFrom === null ? t("workflows.bp.inNothing") : t("workflows.bp.inResult", { n: flow.previousFrom + 1 })}</Chip>
                  ) : null}
                  {flow.reads
                    .filter((n) => !(flow.previous && n === flow.previousFrom))
                    .map((n) => (
                      <Chip key={n} name="previous">
                        {t("workflows.bp.inResult", { n: n + 1 })}
                      </Chip>
                    ))}
                  {flow.previous && flow.notesFrom.length ? <Chip name="answers">{t("workflows.bp.inNotes", { n: flow.notesFrom.map((n) => n + 1).join(", ") })}</Chip> : null}
                  {flow.allInputs || flow.input.length ? (
                    <Chip name="inputs">{flow.allInputs ? t("workflows.studio.bp.inInputs") : t("workflows.studio.bp.inInput", { names: flow.input.join(", ") })}</Chip>
                  ) : null}
                  {flow.resources ? <Chip name="resources">{t("workflows.studio.section.resources")}</Chip> : null}
                  {!flow.task && !flow.previous && !flow.answers && !flow.reads.length && !flow.input.length && !flow.allInputs && !flow.resources ? (
                    <span className="text-ink-2">{t("workflows.bp.inNone")}</span>
                  ) : null}
                </span>
              </Row>
              <Row label={t("workflows.bp.output")}>
                <span className="text-ink-soft">
                  {[
                    ...flow.readBy.map((n) => t("workflows.studio.bp.outRead", { step: ref(n) })),
                    ...flow.checkedBy.map((n) => t("workflows.studio.bp.outChecked", { step: ref(n) })),
                    flow.reviewedBy !== null ? t("workflows.bp.outReviewed", { step: ref(flow.reviewedBy) }) : "",
                    flow.final ? t("workflows.studio.bp.outFinal") : "",
                  ]
                    .filter(Boolean)
                    .join(" · ") || t("workflows.bp.outNone")}
                </span>
              </Row>
              <Row label={t("workflows.bp.tools")}>
                <span className="text-ink-soft">{t(runner === "local" ? "workflows.bp.toolsAgent" : s.tools === false ? "workflows.bp.toolsOff" : "workflows.bp.toolsOn")}</span>
              </Row>
              <Row label={t("workflows.bp.ask")}>
                <span className="text-ink-soft">{t(flow.mayAsk ? "workflows.bp.askFirst" : "workflows.bp.askDecide")}</span>
              </Row>
              {limits.length ? (
                <Row label={t("workflows.studio.facts.limits")}>
                  <span className="text-ink-soft">{limits.join(" · ")}</span>
                </Row>
              ) : null}
            </dl>
            <div className="grid gap-1.5">
              <p className="text-ink-2 m-0 text-xs font-medium">{t("workflows.bp.prompt")}</p>
              <pre className="bg-ground ring-hairline text-ink m-0 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg px-3.5 py-3 font-mono text-[12.5px]/5 ring-1 ring-inset">
                <PromptText text={s.prompt ?? ""} />
              </pre>
            </div>
            <Sent s={s} runner={runner} flow={flow} analysis={analysis} catalog={catalog} prompting={prompting} />
          </>
        ) : s.kind === "command" ? (
          <>
            <p className="text-ink-soft m-0 text-[13px]">{t(config.environment.kind === "sandbox" ? "workflows.studio.bp.commandSandbox" : "workflows.bp.command")}</p>
            {limits.length ? <p className="text-ink-2 m-0 text-xs">{limits.join(" · ")}</p> : null}
          </>
        ) : s.kind === "check" ? (
          <dl className="m-0 grid gap-x-4 gap-y-2 text-[13px] sm:grid-cols-[7.5rem_minmax(0,1fr)]">
            <Row label={t("workflows.studio.bp.judge")}>
              {byCommand ? <span className="text-ink-soft">{t("workflows.studio.check.commandHint")}</span> : model ? <ModelBadge info={model} /> : null}
            </Row>
            {!byCommand ? (
              <Row label={t("workflows.studio.check.criteria")}>
                <ul className="text-ink-soft m-0 grid list-disc gap-0.5 pl-4">
                  {(s.criteria ?? "")
                    .split("\n")
                    .map((x) => x.replace(/^\s*[-*•]\s*/, "").trim())
                    .filter(Boolean)
                    .map((x, k) => (
                      <li key={k}>{x}</li>
                    ))}
                </ul>
              </Row>
            ) : null}
            <Row label={t("workflows.studio.check.onFail")}>
              <span className="text-ink-soft">
                {attempts && flow.sendsBackTo !== null ? `${t("workflows.studio.bp.sendsBack", { step: ref(flow.sendsBackTo), count: attempts })} ` : ""}
                {t(s.onFail === "continue" ? "workflows.studio.check.continueHint" : "workflows.studio.check.stopHint")}
              </span>
            </Row>
            {limits.length ? (
              <Row label={t("workflows.studio.facts.limits")}>
                <span className="text-ink-soft">{limits.join(" · ")}</span>
              </Row>
            ) : null}
          </dl>
        ) : s.kind === "approval" ? (
          <dl className="m-0 grid gap-x-4 gap-y-2 text-[13px] sm:grid-cols-[7.5rem_minmax(0,1fr)]">
            <Row label={t("workflows.bp.who")}>
              <span className="text-ink-soft">{approver}</span>
            </Row>
            <Row label={t("workflows.bp.choices")}>
              <ul className="text-ink-soft m-0 grid list-disc gap-0.5 pl-4">
                <li>{t("workflows.bp.approve")}</li>
                {flow.previousFrom !== null && steps[flow.previousFrom]!.kind === "ai" ? <li>{t("workflows.bp.rework", { step: ref(flow.previousFrom) })}</li> : null}
                <li>{t("workflows.bp.stop")}</li>
              </ul>
            </Row>
          </dl>
        ) : (
          <p className="text-ink-soft m-0 text-[13px]">{t("workflows.bp.status", { status: f.status(s.status ?? "review") ?? s.status ?? "" })}</p>
        )}

        {findings.length ? (
          <ul className="m-0 grid list-none gap-1.5 p-0">
            {findings.map((x, k) => (
              <FindingLine key={k} x={x} />
            ))}
          </ul>
        ) : null}
      </div>
    </details>
  );
}

/** The step kind's tint as text only, for the line under a step's title. */
const TEXT: Record<string, string> = { violet: "text-violet-text", sky: "text-sky-text", tangerine: "text-tangerine-text", green: "text-ok", rose: "text-rose-text" };

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="contents max-sm:grid max-sm:gap-0.5">
      <dt className="text-ink-2 pt-px text-xs font-medium sm:text-[13px] sm:font-normal">{label}</dt>
      <dd className="m-0 min-w-0">{children}</dd>
    </div>
  );
}

function Chip({ name, children }: { name: string; children: React.ReactNode }) {
  return <span className={cx("inline-flex h-6 items-center rounded-md px-2 text-xs font-medium ring-1 ring-inset", tokenTone(name))}>{children}</span>;
}

/**
 * The text the model gets, put together as the server does (work/workflows/render.ts, agent-ask.ts composePrompt,
 * ai/assist.ts stepSystem): the system prompt (server only), then the resources when the instruction does not place
 * them, the instruction with every placeholder named, the answers, and the line about asking or deciding.
 */
function Sent({
  s,
  runner,
  flow,
  analysis,
  catalog,
  prompting,
}: {
  s: WorkflowStep;
  runner: Runner;
  flow: StepFlow;
  analysis: Analysis;
  catalog: ModelCatalog | null;
  prompting: Prompting | null;
}) {
  const t = useT();
  const stepAt = (name: string) => analysis.keys.indexOf(name.slice("steps.".length));
  const label = (name: string) =>
    name === "task"
      ? t("workflows.bp.fillTask")
      : name === "previous"
        ? flow.previousFrom === null
          ? "—"
          : t("workflows.bp.fillPrevious", { n: flow.previousFrom + 1 })
        : name === "answers"
          ? t("workflows.bp.fillAnswers")
          : name === "resources"
            ? t("workflows.studio.bp.fillResources")
            : name === "inputs"
              ? t("workflows.studio.bp.fillInputs")
              : name.startsWith("steps.") && stepAt(name) >= 0
                ? t("workflows.bp.fillPrevious", { n: stepAt(name) + 1 })
                : name.startsWith("input.") && analysis.inputKeys.includes(name.slice("input.".length))
                  ? t("workflows.studio.bp.fillInput", { name: name.slice("input.".length) })
                  : `{{${name}}}`;
  const known = (name: string) =>
    name.startsWith("steps.") ? flow.reads.includes(stepAt(name)) : name.startsWith("input.") ? analysis.inputKeys.includes(name.slice("input.".length)) : true;
  const role = s.role?.trim();
  const system = runner === "server" && catalog ? [catalog.system, role ? `Your role for this step:\n${role}` : ""].filter(Boolean).join("\n\n") : null;
  const hint = prompting ? (flow.mayAsk ? prompting.hints.ask : prompting.hints.decide) : null;
  const placed = /\{\{\s*resources\s*\}\}/.test(s.prompt ?? "");
  return (
    <details className="group/sent">
      <summary className="text-accent-text w-fit cursor-pointer list-none text-[13px] font-medium hover:underline [&::-webkit-details-marker]:hidden">
        <span className="group-open/sent:hidden">{t("workflows.bp.showSent")}</span>
        <span className="hidden group-open/sent:inline">{t("workflows.bp.hideSent")}</span>
      </summary>
      <div className="mt-2 grid gap-2">
        {system ? (
          <Message who="system">
            {system}
            {s.tools !== false ? (
              <>
                {"\n\n"}
                <span className="text-ink-2">{t("workflows.bp.toolRulesNote")}</span>
                {"\n"}
                <span className="text-ink-2">{catalog!.toolRules}</span>
              </>
            ) : null}
          </Message>
        ) : runner === "local" ? (
          <p className="text-ink-2 m-0 text-xs">{t("workflows.bp.noSystemLocal")}</p>
        ) : null}
        <Message who="user">
          {runner === "local" && role ? `Your role for this step:\n${role}\n\n` : ""}
          {flow.resources && !placed ? (
            <>
              <Token name="resources">{t("workflows.studio.bp.fillResources")}</Token>
              {"\n\n"}
            </>
          ) : null}
          <PromptText text={s.prompt ?? ""} label={label} known={known} />
          {!flow.answers ? (
            <>
              {"\n\n"}
              <span className="text-ink-2">{t("workflows.bp.answersAppended")}</span>
            </>
          ) : null}
          {hint ? (
            <>
              {"\n\n"}
              <span className="text-ink-2">{hint}</span>
            </>
          ) : null}
          {"\n\n"}
          <span className="text-ink-2">{t("workflows.bp.reworkAppended")}</span>
        </Message>
      </div>
    </details>
  );
}

function Message({ who, children }: { who: "system" | "user"; children: React.ReactNode }) {
  return (
    <div className="ring-hairline min-w-0 overflow-hidden rounded-lg ring-1 ring-inset">
      <p className="bg-ground border-hairline text-ink-2 m-0 border-b px-3 py-1 font-mono text-[11px] font-semibold uppercase tracking-[0.08em]">{who}</p>
      <pre className="text-ink-soft m-0 max-h-96 overflow-auto whitespace-pre-wrap break-words px-3.5 py-3 font-mono text-[12px]/5">{children}</pre>
    </div>
  );
}

/** Everything to check, folded in one bar above the steps; a step's finding opens that step. */
function Findings({ findings, steps }: { findings: Finding[]; steps: WorkflowStep[] }) {
  const t = useT();
  const sorted = bySeverity(findings);
  const worst = sorted[0]!.severity;
  const open = (x: Finding) => {
    if (x.step === null) return;
    const el = document.getElementById(`step-${x.step + 1}`);
    el?.setAttribute("open", "");
    el?.scrollIntoView({ block: "start" });
  };
  return (
    <details className={cx("group/fx min-w-0 rounded-xl", SEVERITY[worst])}>
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-[13px] font-medium [&::-webkit-details-marker]:hidden">
        <InfoIcon className="size-4 shrink-0" />
        <span className="flex-1">{t("workflows.bp.findings", { count: findings.length })}</span>
        <ChevronDownIcon className="size-4 shrink-0 transition-transform group-open/fx:rotate-180" />
      </summary>
      <ul className="bg-surface m-0 grid list-none gap-1.5 rounded-b-xl p-2">
        {sorted.map((x, k) => (
          <FindingLine key={k} x={x} steps={steps} {...(x.step !== null ? { onPick: open } : {})} />
        ))}
      </ul>
    </details>
  );
}
