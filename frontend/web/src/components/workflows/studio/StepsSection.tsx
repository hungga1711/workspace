"use client";

import { useMemo, useState } from "react";
import { useFormat, useT } from "@/lib/i18n/client";
import { STATUS_KEYS } from "@/lib/format";
import { useDirectory } from "@/lib/people";
import { btnGhost, btnSm, cx, input, textarea } from "@/lib/ui";
import { ArrowDownIcon, ArrowUpIcon, ChevronDownIcon, InfoIcon, PlusIcon, TrashIcon } from "@/components/app/icons";
import { Checkbox } from "@/components/ui/Checkbox";
import { Picker, type PickerOption } from "@/components/ui/Picker";
import { Segmented } from "@/components/ui/Segmented";
import { StepNode } from "../bits";
import { describeModel, type Analysis, type Finding } from "../analyze";
import { PromptEditor, plainPrompt, type Token } from "./PromptEditor";
import { LIMITS, type Approver, type ModelCatalog, type Runner, type StepKind, type WorkflowStep } from "../types";
import { insertables, runnerOf, type Draft } from "./draft";
import { FindingLine, SEVERITY } from "./Harness";
import { Advanced, Group, Num, RichField, SectionCard } from "./parts";
import type { SectionProps } from "./sections";

const KINDS: StepKind[] = ["ai", "check", "approval", "command", "status"];
const APPROVERS: Approver[] = ["editors", "owner", "assignee", "starter", "person"];

/** Every kind-specific field, unset: a step that changes kind starts clean. */
const CLEARED: Partial<WorkflowStep> = {
  prompt: undefined,
  command: undefined,
  status: undefined,
  model: undefined,
  role: undefined,
  tools: undefined,
  resources: undefined,
  ask: undefined,
  maxOutput: undefined,
  timeoutMin: undefined,
  retries: undefined,
  criteria: undefined,
  attempts: undefined,
  onFail: undefined,
  approver: undefined,
  approverId: undefined,
};

/** A new step of a kind, with what that kind needs to be valid once its text is typed. */
const blank = (kind: StepKind, title: string): WorkflowStep =>
  kind === "ai"
    ? { key: "", title, kind, prompt: "" }
    : kind === "check"
      ? { key: "", title, kind, criteria: "", attempts: 2, onFail: "stop" }
      : kind === "status"
        ? { key: "", title, kind, status: "review" }
        : kind === "command"
          ? { key: "", title, kind, command: "" }
          : { key: "", title, kind };

/**
 * 5 · The pipeline: a vertical track of steps, one open at a time. Closed, a step is one line (what it is and the
 * model or command it uses, with its issue count); open, it shows what its kind needs and the rest under "Advanced".
 */
export function StepsSection({
  d,
  set,
  catalog,
  analysis,
  open,
  setOpen,
}: SectionProps & { catalog: ModelCatalog | null; analysis: Analysis; open: number | null; setOpen: (i: number | null) => void }) {
  const t = useT();
  const runner = runnerOf(d.config.environment);
  const setStep = (i: number, patch: Partial<WorkflowStep>) => set((x) => ({ ...x, steps: x.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));
  const move = (i: number, by: number) => {
    set((x) => {
      const steps = [...x.steps];
      const [s] = steps.splice(i, 1);
      steps.splice(i + by, 0, s!);
      return { ...x, steps };
    });
    setOpen(i + by);
  };
  const add = (kind: StepKind) => {
    set((x) => {
      // A name of its own from the start, never derived from the title again: renaming the step later does not break
      // the steps that use its result.
      const taken = new Set(x.steps.map((s) => s.key));
      let n = x.steps.length + 1;
      while (taken.has(`step-${n}`)) n++;
      const title = kind === "ai" ? t("workflows.editor.newStep", { n: x.steps.length + 1 }) : t(`workflows.studio.steps.new.${kind}`);
      return { ...x, steps: [...x.steps, { ...blank(kind, title), key: `step-${n}` }] };
    });
    setOpen(d.steps.length);
  };
  const kinds = KINDS.filter((k) => k !== "command" || runner === "local");
  return (
    <SectionCard
      n={5}
      title={t("workflows.studio.section.steps")}
      hint={t("workflows.studio.hint.steps")}
      aside={<span className="text-ink-2 shrink-0 text-xs tabular-nums">{t("workflows.studio.steps.count", { n: d.steps.length, max: LIMITS.steps })}</span>}
    >
      <ol className="m-0 grid min-w-0 list-none p-0">
        {d.steps.map((s, i) => (
          <li key={i} id={`studio-step-${i}`} className="grid min-w-0 scroll-mt-24 grid-cols-[2.25rem_minmax(0,1fr)] gap-x-3 max-sm:grid-cols-1">
            {/* Phones drop the node column: the card's controls need the width. */}
            <span className="flex flex-col items-center max-sm:hidden">
              <StepNode kind={s.kind} className="mt-1.5" />
              <span aria-hidden="true" className="bg-edge mt-1 w-px flex-1" />
            </span>
            <StepCard
              d={d}
              s={s}
              i={i}
              runner={runner}
              catalog={catalog}
              kinds={kinds}
              findings={analysis.findings.filter((x) => x.step === i)}
              open={open === i}
              onToggle={() => setOpen(open === i ? null : i)}
              onChange={(patch) => setStep(i, patch)}
              onMove={(by) => move(i, by)}
              onRemove={() => {
                set((x) => ({ ...x, steps: x.steps.filter((_, j) => j !== i) }));
                setOpen(null);
              }}
            />
          </li>
        ))}
      </ol>
      {d.steps.length < LIMITS.steps ? (
        <div className="grid min-w-0 gap-2">
          <span className="text-ink-2 text-xs font-medium">{t("workflows.editor.addStep")}</span>
          <div className="grid min-w-0 gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {kinds.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => add(k)}
                className="bg-ground ring-hairline hover:bg-surface hover:ring-edge flex min-w-0 items-start gap-2.5 rounded-xl p-2.5 text-left ring-1 ring-inset"
              >
                <StepNode kind={k} size="sm" className="mt-0.5" />
                <span className="min-w-0 flex-1">
                  <span className="text-ink flex items-center gap-1 text-[13px] font-medium">
                    <PlusIcon className="text-ink-2 size-3.5" />
                    {t(`workflows.kind.${k}`)}
                  </span>
                  <span className="text-ink-2 block text-xs/[1.45]">{t(`workflows.studio.steps.what.${k}`)}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </SectionCard>
  );
}

function StepCard({
  d,
  s,
  i,
  runner,
  catalog,
  kinds,
  findings,
  open,
  onToggle,
  onChange,
  onMove,
  onRemove,
}: {
  d: Draft;
  s: WorkflowStep;
  i: number;
  runner: Runner;
  catalog: ModelCatalog | null;
  kinds: StepKind[];
  findings: Finding[];
  open: boolean;
  onToggle: () => void;
  onChange: (patch: Partial<WorkflowStep>) => void;
  onMove: (by: number) => void;
  onRemove: () => void;
}) {
  const t = useT();
  const f = useFormat();
  const dir = useDirectory();
  const worst = findings.some((x) => x.severity === "error") ? "error" : findings.some((x) => x.severity === "warn") ? "warn" : findings.length ? "info" : null;
  const byCommand = s.kind === "check" && runner === "local" && s.command !== undefined;
  const model = describeModel(s.kind === "check" && !s.model && runner === "server" ? { model: "fast" } : s, runner, catalog);
  const modelName = model.kind === "agentDefault" ? t("workflows.model.agentDefault") : model.kind === "none" ? t("workflows.model.none") : (model.model ?? model.label ?? "");
  const tokens = useTokens(d, i);
  const missing = t("workflows.studio.mention.missing");
  const line =
    s.kind === "ai"
      ? // The two placeholders the menu does not offer still read as words here, never as braces.
        plainPrompt(
          s.prompt ?? "",
          [
            ...tokens,
            { name: "previous", label: t("workflows.studio.mention.previous"), group: "step", heading: "" },
            { name: "answers", label: t("workflows.studio.mention.answers"), group: "more", heading: "" },
          ],
          missing,
        ) || modelName
      : s.kind === "command" || byCommand
        ? `$ ${s.command ?? ""}`
        : s.kind === "check"
          ? (s.criteria ?? "").split("\n").filter((x) => x.trim()).length
            ? t("workflows.studio.steps.requirements", { count: (s.criteria ?? "").split("\n").filter((x) => x.trim()).length })
            : ""
          : s.kind === "approval"
            ? s.approver === "person"
              ? s.approverId
                ? dir.name(s.approverId)
                : ""
              : t(`workflows.studio.approver.${s.approver ?? "editors"}`)
            : (f.status(s.status ?? "review") ?? "");
  return (
    <div className={cx("bg-ground ring-hairline mb-2.5 min-w-0 rounded-xl ring-1 ring-inset", open && "bg-surface ring-edge shadow-card")}>
      <div className="flex min-w-0 items-center gap-1 pr-1.5">
        <button type="button" aria-expanded={open} onClick={onToggle} className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5 rounded-xl px-3 py-2 text-left">
          <span className="text-ink-2 w-4 shrink-0 text-xs tabular-nums">{i + 1}</span>
          <StepNode kind={s.kind} size="sm" className="sm:hidden" />
          <span className="min-w-0 flex-1">
            <span className="text-ink block truncate text-sm font-medium">{s.title || t("workflows.editor.stepTitle")}</span>
            <span className="text-ink-2 flex min-w-0 items-baseline gap-1.5 text-xs">
              <span className="shrink-0">{t(`workflows.kind.${s.kind}`)}</span>
              {line ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span className={cx("truncate", (s.kind === "command" || byCommand) && "font-mono")}>{line}</span>
                </>
              ) : null}
            </span>
          </span>
          {worst ? (
            <span className={cx("inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-1.5 text-xs font-medium tabular-nums", SEVERITY[worst])}>
              <InfoIcon className="size-3" />
              {findings.length}
            </span>
          ) : null}
          <ChevronDownIcon className={cx("text-ink-2 size-4 shrink-0 transition-transform", open && "rotate-180")} />
        </button>
      </div>

      {open ? (
        <div className="border-divider-soft grid min-w-0 gap-3.5 border-t px-3 py-3.5">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <input
              className={cx(input, "min-w-0 flex-1 basis-48")}
              value={s.title}
              onChange={(e) => onChange({ title: e.target.value })}
              placeholder={t("workflows.editor.stepTitle")}
              aria-label={t("workflows.editor.stepTitle")}
              maxLength={120}
            />
            <Picker
              variant="button"
              label={t("workflows.editor.stepKind")}
              value={s.kind}
              onChange={(v) =>
                // Another kind keeps the name and key only: what the old kind needed would otherwise linger on the step.
                onChange({ ...CLEARED, ...blank(v as StepKind, s.title), key: s.key })
              }
              options={kinds.map((k) => ({ value: k, label: t(`workflows.kind.${k}`), icon: <StepNode kind={k} size="sm" /> }))}
            />
            <span className="ml-auto flex">
              <button type="button" className={cx(btnGhost, btnSm, "w-7 px-0")} disabled={!i} onClick={() => onMove(-1)} aria-label={t("workflows.editor.up")}>
                <ArrowUpIcon className="size-4" />
              </button>
              <button
                type="button"
                className={cx(btnGhost, btnSm, "w-7 px-0")}
                disabled={i === d.steps.length - 1}
                onClick={() => onMove(1)}
                aria-label={t("workflows.editor.down")}
              >
                <ArrowDownIcon className="size-4" />
              </button>
              <button type="button" className={cx(btnGhost, btnSm, "text-ink-2 w-7 px-0")} onClick={onRemove} aria-label={t("common.delete")}>
                <TrashIcon className="size-4" />
              </button>
            </span>
          </div>

          {s.kind === "ai" ? (
            <AiFields d={d} s={s} tokens={tokens} runner={runner} catalog={catalog} onChange={onChange} />
          ) : s.kind === "command" ? (
            <>
              <CommandInput value={s.command ?? ""} onChange={(v) => onChange({ command: v })} />
              <Advanced label={t("workflows.studio.advanced")} open={!!(s.timeoutMin || s.retries)}>
                <Limits s={s} d={d} onChange={onChange} retries />
              </Advanced>
            </>
          ) : s.kind === "check" ? (
            <CheckFields d={d} s={s} runner={runner} catalog={catalog} byCommand={byCommand} onChange={onChange} />
          ) : s.kind === "approval" ? (
            <div className="grid min-w-0 gap-3 sm:grid-cols-2">
              <Group label={t("workflows.bp.who")} hint={t("workflows.editor.approvalHint")} className="sm:col-span-2">
                <div className="grid min-w-0 gap-2 sm:grid-cols-2">
                  <Picker
                    variant="field"
                    label={t("workflows.bp.who")}
                    value={s.approver ?? "editors"}
                    onChange={(v) => onChange({ approver: v as Approver, ...(v === "person" ? {} : { approverId: undefined }) })}
                    options={APPROVERS.map((a) => ({ value: a, label: t(`workflows.studio.approver.${a}`) }))}
                  />
                  {s.approver === "person" ? (
                    <Picker
                      variant="field"
                      label={t("workflows.studio.approver.pick")}
                      placeholder={t("workflows.studio.approver.pick")}
                      value={s.approverId ?? ""}
                      onChange={(v) => onChange({ approverId: v })}
                      options={[...new Map(dir.people.filter((p) => p.status !== "disabled").map((p) => [p.userId, p])).values()].map((p) => ({
                        value: p.userId,
                        label: p.displayName,
                        keywords: p.email ?? "",
                      }))}
                    />
                  ) : null}
                </div>
              </Group>
            </div>
          ) : (
            <Group label={t("workflows.editor.moveTo")}>
              <Picker
                variant="field"
                label={t("workflows.editor.moveTo")}
                value={s.status ?? "review"}
                onChange={(v) => onChange({ status: v })}
                options={STATUS_KEYS.map((k) => ({ value: k as string, label: f.status(k) ?? k }))}
              />
            </Group>
          )}

          {findings.length ? (
            <ul className="m-0 grid list-none gap-1.5 p-0">
              {findings.map((x, k) => (
                <FindingLine key={k} x={x} />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function CommandInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const t = useT();
  return (
    <span className="relative flex min-w-0 items-center">
      <span aria-hidden="true" className="text-ink-2 pointer-events-none absolute left-2.5 font-mono text-[13px]">
        $
      </span>
      <input
        className={cx(input, "pl-6 font-mono text-[13px]")}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="npm test"
        aria-label={t("workflows.editor.command")}
        spellCheck={false}
        maxLength={2000}
      />
    </span>
  );
}

/** Time limit (and retries) of one step: empty keeps the workflow's own step limit. */
function Limits({ s, d, onChange, retries }: { s: WorkflowStep; d: Draft; onChange: (patch: Partial<WorkflowStep>) => void; retries?: boolean }) {
  const t = useT();
  return (
    <div className="grid min-w-0 gap-3.5 sm:grid-cols-2">
      <Group label={t("workflows.studio.steps.timeout")}>
        <Num
          label={t("workflows.studio.steps.timeout")}
          value={s.timeoutMin}
          onChange={(n) => onChange({ timeoutMin: n })}
          min={1}
          max={LIMITS.stepMinutes}
          unit={t("workflows.studio.min")}
          blank={t("workflows.studio.steps.timeoutDefault", { n: d.config.guardrails.stepMinutes })}
        />
      </Group>
      {retries ? (
        <Group label={t("workflows.studio.steps.retries")} hint={t("workflows.studio.steps.retriesHint")}>
          <Segmented
            label={t("workflows.studio.steps.retries")}
            value={String(s.retries ?? 0)}
            onChange={(v) => onChange({ retries: Number(v) || undefined })}
            className="justify-self-start"
            options={["0", "1", "2", "3"].map((n) => ({ value: n, label: n }))}
          />
        </Group>
      ) : null}
    </div>
  );
}

const OUTPUTS = [1000, 2000, 4000, 8000] as const;

/**
 * What an instruction may refer to at step `i`, in the words people see: the task, each earlier result by the step's
 * number and name, each question asked at the start by its label.
 */
function useTokens(d: Draft, i: number): Token[] {
  const t = useT();
  return useMemo(
    () =>
      // The menu's order: the task, what earlier steps made, what was answered at the start, then the rest.
      insertables(d, i)
        .map((x, at) => ({ x, at, rank: x.name === "task" ? 0 : x.group === "step" ? 1 : x.group === "input" ? 2 : 3 }))
        .sort((a, b) => a.rank - b.rank || a.at - b.at)
        .map((o) => o.x)
        .flatMap((x): Token[] => {
          if (x.group === "step")
            return [{ name: x.name, label: t("workflows.studio.mention.step", { step: x.label ?? "" }), group: "step", heading: t("workflows.studio.mention.steps") }];
          if (x.group === "input")
            return [{ name: x.name, label: t("workflows.studio.mention.input", { label: x.label ?? "" }), group: "input", heading: t("workflows.studio.mention.inputs") }];
          if (x.name === "task") return [{ name: x.name, label: t("workflows.studio.mention.task"), group: "task", heading: t("workflows.studio.mention.work") }];
          // "The previous step's result" is one of the earlier results already listed by name; {{answers}} is placed by
          // the engine. Both still draw as chips in workflows that use them (the labels below), neither is offered.
          if (x.name === "previous" || x.name === "answers") return [];
          return [{ name: x.name, label: t(`workflows.studio.mention.${x.name as "resources" | "inputs"}`), group: "more", heading: t("workflows.studio.mention.more") }];
        }),
    [d, i, t],
  );
}

/**
 * An AI step, top to bottom the way someone briefs a colleague: what to do (with the things it refers to as chips),
 * who the AI is for this step, which model. Everything else is under "More options".
 */
function AiFields({
  d,
  s,
  tokens,
  runner,
  catalog,
  onChange,
}: {
  d: Draft;
  s: WorkflowStep;
  tokens: Token[];
  runner: Runner;
  catalog: ModelCatalog | null;
  onChange: (patch: Partial<WorkflowStep>) => void;
}) {
  const t = useT();
  const server = runner === "server";
  // Offered in the menu, plus the two the engine knows that are only drawn when a workflow already uses them.
  const known = useMemo<Token[]>(
    () => [
      ...tokens,
      { name: "previous", label: t("workflows.studio.mention.previous"), group: "step", heading: "" },
      { name: "answers", label: t("workflows.studio.mention.answers"), group: "more", heading: "" },
    ],
    [tokens, t],
  );
  const offered = tokens.length;
  return (
    <div className="grid min-w-0 gap-4">
      <Group label={t("workflows.studio.steps.prompt")}>
        <PromptEditor
          value={s.prompt ?? ""}
          onChange={(v) => onChange({ prompt: v })}
          tokens={known.slice(0, offered)}
          drawn={known}
          label={t("workflows.studio.steps.prompt")}
          placeholder={t("workflows.studio.steps.promptPh")}
          maxLength={LIMITS.prompt}
          missing={t("workflows.studio.mention.missing")}
          insertLabel={t("workflows.studio.mention.insert")}
          hint={t("workflows.studio.mention.hint")}
        />
      </Group>
      <Group label={t("workflows.studio.steps.role")} hint={t("workflows.studio.steps.roleHint")}>
        <RichField
          label={t("workflows.studio.steps.role")}
          value={s.role ?? ""}
          onChange={(v) => onChange({ role: v })}
          maxLength={4000}
          placeholder={t("workflows.editor.rolePh")}
          minRows="min-h-16"
        />
      </Group>
      <div className="grid min-w-0 sm:max-w-md">
        <ModelPicker value={s.model ?? ""} runner={runner} catalog={catalog} onChange={(v) => onChange({ model: v })} />
      </div>
      <Advanced label={t("workflows.studio.steps.more")} open={!!(s.timeoutMin || s.retries || s.maxOutput || s.resources === false || s.ask === false || s.tools === false)}>
        {server ? (
          <Group label={t("workflows.studio.steps.maxOutput")}>
            <Segmented
              label={t("workflows.studio.steps.maxOutput")}
              value={String(s.maxOutput ?? 2000)}
              onChange={(v) => onChange({ maxOutput: Number(v) === 2000 ? undefined : Number(v) })}
              className="justify-self-start"
              phoneGrid={2}
              options={OUTPUTS.map((n) => ({ value: String(n), label: t(`workflows.studio.steps.length.${n}`) }))}
            />
          </Group>
        ) : null}
        <Limits s={s} d={d} onChange={onChange} retries />
        <div className="grid min-w-0 gap-2.5 sm:grid-cols-2">
          <Checkbox
            label={t("workflows.studio.steps.useResources")}
            checked={s.resources !== false}
            onChange={(e) => onChange({ resources: e.target.checked ? undefined : false })}
          />
          <Checkbox
            label={t("workflows.studio.steps.mayAsk")}
            checked={s.ask !== false && d.config.guardrails.ask !== "never"}
            disabled={d.config.guardrails.ask === "never"}
            onChange={(e) => onChange({ ask: e.target.checked ? undefined : false })}
          />
          {server ? <Checkbox label={t("workflows.editor.tools")} checked={s.tools !== false} onChange={(e) => onChange({ tools: e.target.checked ? undefined : false })} /> : null}
        </div>
      </Advanced>
    </div>
  );
}

/** A check: an AI judges the result against requirements, or (on a runner) a command's exit code decides. */
function CheckFields({
  d,
  s,
  runner,
  catalog,
  byCommand,
  onChange,
}: {
  d: Draft;
  s: WorkflowStep;
  runner: Runner;
  catalog: ModelCatalog | null;
  byCommand: boolean;
  onChange: (patch: Partial<WorkflowStep>) => void;
}) {
  const t = useT();
  const attempts = s.attempts ?? 2;
  return (
    <div className="grid min-w-0 gap-3.5">
      {runner === "local" ? (
        <Segmented
          label={t("workflows.studio.check.how")}
          value={byCommand ? "command" : "ai"}
          onChange={(v) => onChange(v === "command" ? { command: s.command ?? "" } : { command: undefined })}
          className="justify-self-start"
          options={[
            { value: "ai", label: t("workflows.studio.check.ai") },
            { value: "command", label: t("workflows.studio.check.command") },
          ]}
        />
      ) : null}
      {byCommand ? (
        <Group label={t("workflows.editor.command")} hint={t("workflows.studio.check.commandHint")}>
          <CommandInput value={s.command ?? ""} onChange={(v) => onChange({ command: v })} />
        </Group>
      ) : (
        <>
          <Group label={t("workflows.studio.check.criteria")} hint={t("workflows.studio.check.criteriaHint")}>
            <textarea
              className={cx(textarea, "min-h-24 text-[13px]")}
              value={s.criteria ?? ""}
              onChange={(e) => onChange({ criteria: e.target.value })}
              placeholder={t("workflows.studio.check.criteriaPh")}
              aria-label={t("workflows.studio.check.criteria")}
              maxLength={4000}
            />
          </Group>
          <ModelPicker value={s.model ?? ""} runner={runner} catalog={catalog} onChange={(v) => onChange({ model: v })} check />
        </>
      )}
      <div className="grid min-w-0 gap-3.5 sm:grid-cols-2">
        <Group label={t("workflows.studio.check.attempts")} hint={t(attempts ? "workflows.studio.check.attemptsHint" : "workflows.studio.check.attemptsNone")}>
          <Segmented
            label={t("workflows.studio.check.attempts")}
            value={String(attempts)}
            onChange={(v) => onChange({ attempts: Number(v) })}
            className="justify-self-start"
            options={["0", "1", "2", "3", "4", "5"].map((n) => ({ value: n, label: n }))}
          />
        </Group>
        <Group label={t("workflows.studio.check.onFail")} hint={t(s.onFail === "continue" ? "workflows.studio.check.continueHint" : "workflows.studio.check.stopHint")}>
          <Segmented
            label={t("workflows.studio.check.onFail")}
            value={s.onFail ?? "stop"}
            onChange={(v) => onChange({ onFail: v })}
            className="justify-self-start"
            options={[
              { value: "stop", label: t("workflows.studio.check.stop") },
              { value: "continue", label: t("workflows.studio.check.continue") },
            ]}
          />
        </Group>
      </div>
      <Advanced label={t("workflows.studio.advanced")} open={!!s.timeoutMin}>
        <Limits s={s} d={d} onChange={onChange} />
      </Advanced>
    </div>
  );
}

/**
 * Which model an AI step asks: a listbox grouped as the company's own choices (its main and fast model, named) then
 * each connection's models; on a runner, the agent's default, the usual Claude Code names, or any name typed at the
 * foot (passed as --model). A check's default on the server is the company's fast model.
 */
function ModelPicker({ value, runner, catalog, onChange, check }: { value: string; runner: Runner; catalog: ModelCatalog | null; onChange: (v: string) => void; check?: boolean }) {
  const t = useT();
  const [custom, setCustom] = useState("");
  const hint = new Map<string, string>();
  const add = (o: PickerOption, h: string) => {
    hint.set(o.value, h);
    return o;
  };
  const c = catalog?.defaults;
  const company = t("workflows.model.company");
  const smart = (v: string) =>
    add(
      { value: v, label: c?.smart.model ?? t("workflows.model.default"), group: company },
      c ? `${t("workflows.model.default")} · ${c.smart.label}` : t("workflows.model.how.none"),
    );
  const fast = (v: string) =>
    add({ value: v, label: c?.fast.model ?? t("workflows.model.fast"), group: company }, c ? `${t("workflows.model.fast")} · ${c.fast.label}` : t("workflows.model.how.none"));
  const options: PickerOption[] =
    runner === "server"
      ? [
          // A check with no model of its own is judged by the fast one; an AI step by the main one.
          ...(check ? [fast("")] : [smart(""), fast("fast")]),
          ...(catalog?.models ?? []).map((m) =>
            add(
              { value: m.route, label: m.model, group: m.label, keywords: `${m.vendor} ${m.label}` },
              t(m.tier === "fast" ? "workflows.model.tierFast" : "workflows.model.tierSmart"),
            ),
          ),
        ]
      : [
          add({ value: "", label: t("workflows.model.agentDefault"), group: t("workflows.model.agentGroup") }, t("workflows.model.how.agentDefault")),
          ...["opus", "sonnet", "haiku"].map((m) => add({ value: m, label: m, group: t("workflows.model.agentGroup") }, t("workflows.model.how.agent"))),
        ];
  if (value && !options.some((o) => o.value === value))
    options.push(
      runner === "server"
        ? add({ value, label: value.slice(value.indexOf(":") + 1), group: t("workflows.model.pick") }, t("workflows.model.how.missing"))
        : add({ value, label: value, group: t("workflows.model.agentGroup") }, t("workflows.model.how.agent")),
    );
  return (
    <div className="grid min-w-0 content-start gap-1.5">
      <span className="text-sm font-medium">{t("workflows.bp.model")}</span>
      <Picker
        variant="field"
        label={t("workflows.bp.model")}
        value={value}
        onChange={onChange}
        options={options}
        menuClassName="w-full min-w-64"
        renderOption={(o) => (
          <span className="grid min-w-0 leading-tight">
            <span className={cx("truncate", runner === "local" && o.value ? "font-mono text-[13px]" : "font-medium")}>{o.label}</span>
            <span className="text-ink-2 truncate text-xs">{hint.get(o.value)}</span>
          </span>
        )}
        footer={
          runner === "local" ? (
            <input
              className={cx(input, "h-8 font-mono text-[13px]")}
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => {
                // The listbox's own keys (Enter picks, arrows move) must not see what is typed here.
                e.stopPropagation();
                if (e.key === "Enter" && custom.trim()) {
                  e.preventDefault();
                  onChange(custom.trim());
                  setCustom("");
                }
              }}
              placeholder={t("workflows.model.custom")}
              aria-label={t("workflows.model.custom")}
            />
          ) : null
        }
      />
      <p className="text-ink-2 m-0 text-xs">{hint.get(value)}</p>
    </div>
  );
}
