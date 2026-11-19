"use client";

import { useFormat, useT } from "@/lib/i18n/client";
import { STATUS_KEYS } from "@/lib/format";
import { btn, btnGhost, btnSm, cx, input } from "@/lib/ui";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, TrashIcon } from "@/components/app/icons";
import { Checkbox } from "@/components/ui/Checkbox";
import { Picker } from "@/components/ui/Picker";
import { Segmented } from "@/components/ui/Segmented";
import { LIMITS, type InputField, type InputType } from "../types";
import type { Draft } from "./draft";
import { RunFormPreview } from "./Harness";
import { Advanced, ChipInput, Group, Num, RichField, SectionCard } from "./parts";

export interface SectionProps {
  d: Draft;
  set: (fn: (d: Draft) => Draft) => void;
}

/** 1 · What the workflow is for, in the words of the people who will pick it. */
export function OverviewSection({ d, set }: SectionProps) {
  const t = useT();
  return (
    <SectionCard n={1} title={t("workflows.studio.section.overview")} hint={t("workflows.studio.hint.overview")}>
      <RichField
        label={t("workflows.editor.description")}
        value={d.description}
        onChange={(v) => set((x) => ({ ...x, description: v }))}
        maxLength={1000}
        placeholder={t("workflows.editor.descriptionPh")}
      />
    </SectionCard>
  );
}

const TYPES: InputType[] = ["text", "long", "choice", "number", "date"];

/**
 * A key for a new question, given once and kept: steps refer to a question by it, so it never follows the wording
 * (renaming "Who is it for?" must not break the steps that use the answer).
 */
const freshKey = (fields: InputField[]) => {
  for (let n = fields.length + 1; ; n++) if (!fields.some((f) => f.key === `field-${n}`)) return `field-${n}`;
};

/** 2 · The questions people answer when they start a run; steps use an answer by picking its question from a menu. */
export function InputsSection({ d, set }: SectionProps) {
  const t = useT();
  const fields = d.config.inputs;
  const setFields = (fn: (f: InputField[]) => InputField[]) => set((x) => ({ ...x, config: { ...x.config, inputs: fn(x.config.inputs) } }));
  const patch = (i: number, p: Partial<InputField>) => setFields((f) => f.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const move = (i: number, by: number) =>
    setFields((f) => {
      const next = [...f];
      const [x] = next.splice(i, 1);
      next.splice(i + by, 0, x!);
      return next;
    });
  return (
    <SectionCard n={2} title={t("workflows.studio.section.inputs")} hint={t("workflows.studio.hint.inputs")}>
      <div className={cx("grid min-w-0 gap-4", !!fields.length && "xl:grid-cols-[minmax(0,1fr)_17rem]")}>
        <div className="grid min-w-0 content-start gap-2.5">
          {fields.map((f, i) => {
            return (
              <div key={i} className="bg-ground ring-hairline grid min-w-0 gap-2.5 rounded-xl p-3 ring-1 ring-inset">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <input
                    className={cx(input, "min-w-0 flex-1 basis-40 max-sm:basis-full")}
                    value={f.label}
                    onChange={(e) => patch(i, { label: e.target.value })}
                    placeholder={t("workflows.studio.inputs.labelPh")}
                    aria-label={t("workflows.studio.inputs.label")}
                    maxLength={80}
                  />
                  <Picker
                    variant="button"
                    label={t("workflows.studio.inputs.type")}
                    value={f.type}
                    onChange={(v) => patch(i, { type: v as InputType, ...(v === "choice" ? { options: f.options ?? [] } : {}) })}
                    options={TYPES.map((k) => ({ value: k, label: t(`workflows.studio.inputs.types.${k}`) }))}
                  />
                  <span className="ml-auto flex">
                    <button type="button" className={cx(btnGhost, btnSm, "w-7 px-0")} disabled={!i} onClick={() => move(i, -1)} aria-label={t("workflows.editor.up")}>
                      <ArrowUpIcon className="size-4" />
                    </button>
                    <button
                      type="button"
                      className={cx(btnGhost, btnSm, "w-7 px-0")}
                      disabled={i === fields.length - 1}
                      onClick={() => move(i, 1)}
                      aria-label={t("workflows.editor.down")}
                    >
                      <ArrowDownIcon className="size-4" />
                    </button>
                    <button
                      type="button"
                      className={cx(btnGhost, btnSm, "text-ink-2 w-7 px-0")}
                      onClick={() => setFields((x) => x.filter((_, j) => j !== i))}
                      aria-label={t("common.delete")}
                    >
                      <TrashIcon className="size-4" />
                    </button>
                  </span>
                </div>
                {f.type === "choice" ? (
                  <ChipInput
                    label={t("workflows.studio.inputs.options")}
                    values={f.options ?? []}
                    onChange={(v) => patch(i, { options: v, ...(f.default && !v.includes(f.default) ? { default: undefined } : {}) })}
                    placeholder={t("workflows.studio.inputs.optionsPh")}
                    max={12}
                  />
                ) : null}
                <Checkbox label={t("workflows.studio.inputs.required")} checked={!!f.required} onChange={(e) => patch(i, { required: e.target.checked || undefined })} />
                <Advanced label={t("workflows.studio.inputs.more")} open={!!(f.default || f.placeholder)}>
                  <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                    <Group label={t("workflows.studio.inputs.default")}>
                      {f.type === "choice" ? (
                        <Picker
                          variant="field"
                          label={t("workflows.studio.inputs.default")}
                          value={f.default ?? ""}
                          onChange={(v) => patch(i, { default: v || undefined })}
                          options={[{ value: "", label: t("workflows.studio.inputs.noDefault") }, ...(f.options ?? []).map((o) => ({ value: o, label: o }))]}
                        />
                      ) : (
                        <input
                          className={input}
                          value={f.default ?? ""}
                          onChange={(e) => patch(i, { default: e.target.value || undefined })}
                          aria-label={t("workflows.studio.inputs.default")}
                          type={f.type === "date" ? "date" : "text"}
                          inputMode={f.type === "number" ? "decimal" : undefined}
                        />
                      )}
                    </Group>
                    <Group label={t("workflows.studio.inputs.placeholder")}>
                      <input
                        className={input}
                        value={f.placeholder ?? ""}
                        onChange={(e) => patch(i, { placeholder: e.target.value || undefined })}
                        aria-label={t("workflows.studio.inputs.placeholder")}
                        maxLength={200}
                      />
                    </Group>
                  </div>
                </Advanced>
              </div>
            );
          })}
          {fields.length < LIMITS.inputs ? (
            <button type="button" className={cx(btn, "justify-self-start")} onClick={() => setFields((f) => [...f, { key: freshKey(f), label: "", type: "text" }])}>
              <PlusIcon />
              {t("workflows.studio.inputs.add")}
            </button>
          ) : null}
        </div>
        {fields.length ? (
          <div className="grid min-w-0 content-start gap-1.5">
            <span className="text-ink-2 text-xs font-medium">{t("workflows.studio.inputs.preview")}</span>
            <RunFormPreview fields={fields} />
          </div>
        ) : null}
      </div>
    </SectionCard>
  );
}

/** 6 · The limits a run keeps to, whoever starts it. */
export function GuardrailsSection({ d, set }: SectionProps) {
  const t = useT();
  const g = d.config.guardrails;
  const patch = (p: Partial<typeof g>) => set((x) => ({ ...x, config: { ...x.config, guardrails: { ...x.config.guardrails, ...p } } }));
  const server = d.config.environment.kind === "assistant";
  return (
    <SectionCard n={6} title={t("workflows.studio.section.guardrails")} hint={t("workflows.studio.hint.guardrails")}>
      <div className="grid min-w-0 gap-4 sm:grid-cols-2">
        <Group label={t("workflows.studio.guard.run")} hint={t("workflows.studio.guard.runHint")}>
          <Num
            label={t("workflows.studio.guard.run")}
            value={g.maxMinutes}
            onChange={(n) => patch({ maxMinutes: n ?? 60 })}
            min={1}
            max={LIMITS.maxMinutes}
            unit={t("workflows.studio.min")}
          />
        </Group>
        <Group label={t("workflows.studio.guard.step")} hint={t("workflows.studio.guard.stepHint")}>
          <Num
            label={t("workflows.studio.guard.step")}
            value={g.stepMinutes}
            onChange={(n) => patch({ stepMinutes: n ?? 10 })}
            min={1}
            max={LIMITS.stepMinutes}
            unit={t("workflows.studio.min")}
          />
        </Group>
      </div>
      <Group label={t("workflows.studio.guard.ask")} hint={t(g.ask === "never" ? "workflows.studio.guard.askNever" : "workflows.studio.guard.askAllowed")}>
        <Segmented
          label={t("workflows.studio.guard.ask")}
          value={g.ask}
          onChange={(v) => patch({ ask: v })}
          className="justify-self-start"
          options={[
            { value: "allowed", label: t("workflows.studio.guard.allowed") },
            { value: "never", label: t("workflows.studio.guard.never") },
          ]}
        />
      </Group>
      {/* For long jobs: people see how long each step and the whole run should take, and when to come back. */}
      <Checkbox
        label={t("workflows.studio.guard.estimate")}
        hint={t("workflows.studio.guard.estimateHint")}
        checked={d.config.estimate !== false}
        onChange={(e) => set((x) => ({ ...x, config: { ...x.config, estimate: e.target.checked } }))}
      />
      {server ? (
        <Advanced label={t("workflows.studio.advanced")} open={!!g.maxTokens}>
          <Group label={t("workflows.studio.guard.tokens")} hint={t("workflows.studio.guard.tokensHint")} className="sm:max-w-xs">
            <Num
              label={t("workflows.studio.guard.tokens")}
              value={g.maxTokens || undefined}
              onChange={(n) => patch({ maxTokens: n ?? 0 })}
              min={0}
              max={5_000_000}
              blank={t("workflows.studio.guard.noCap")}
              unit={t("workflows.studio.tokens")}
            />
          </Group>
        </Advanced>
      ) : null}
    </SectionCard>
  );
}

/** 7 · Where the final result goes. When a run starts is section 8 (StartSection.tsx). */
export function OutputSection({ d, set }: SectionProps) {
  const t = useT();
  const f = useFormat();
  const o = d.config.output;
  const patch = (p: Partial<typeof o>) => set((x) => ({ ...x, config: { ...x.config, output: { ...x.config.output, ...p } } }));
  const runner = d.config.environment.kind !== "assistant";
  return (
    <SectionCard n={7} title={t("workflows.studio.section.output")} hint={t("workflows.studio.hint.output")}>
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <Checkbox
          label={t("workflows.studio.out.comment")}
          hint={t("workflows.studio.out.commentHint")}
          checked={o.comment}
          onChange={(e) => patch({ comment: e.target.checked })}
        />
        <Checkbox label={t("workflows.studio.out.doc")} hint={t("workflows.studio.out.docHint")} checked={o.doc} onChange={(e) => patch({ doc: e.target.checked })} />
        <Checkbox
          label={t("workflows.studio.out.subtasks")}
          hint={t("workflows.studio.out.subtasksHint")}
          checked={o.subtasks}
          onChange={(e) => patch({ subtasks: e.target.checked })}
        />
        <Checkbox
          label={t("workflows.studio.out.files")}
          hint={t(runner ? "workflows.studio.out.filesHint" : "workflows.studio.out.filesOff")}
          checked={runner && o.files}
          disabled={!runner}
          onChange={(e) => patch({ files: e.target.checked })}
        />
      </div>
      <div className="grid min-w-0 gap-4 sm:grid-cols-2">
        <Group label={t("workflows.studio.out.status")}>
          <Picker
            variant="field"
            label={t("workflows.studio.out.status")}
            value={o.status}
            onChange={(v) => patch({ status: v })}
            options={[{ value: "", label: t("workflows.studio.out.statusKeep") }, ...STATUS_KEYS.map((k) => ({ value: k as string, label: f.status(k) ?? k }))]}
          />
        </Group>
      </div>
    </SectionCard>
  );
}
