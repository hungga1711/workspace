"use client";

import { useId, useState } from "react";
import { useFormat, useT } from "@/lib/i18n/client";
import { btn, btnPrimary, cx, input, textarea } from "@/lib/ui";
import { Modal } from "@/components/ui/Modal";
import { Picker } from "@/components/ui/Picker";
import { PlayIcon } from "@/components/app/icons";
import { EnvBadge } from "../bits";
import { UsualTime, useWorkflowEstimate } from "./eta";
import type { InputField, RunnerInfo, Workflow, WorkflowConfig } from "../types";
import { RunnerLine } from "./RunEnvironment";

/** What a workflow delivers and its limits, as words for small chips (the run dialog, the card under Start). */
export function useHarnessFacts() {
  const t = useT();
  const { status, number } = useFormat();
  return (c: WorkflowConfig) => {
    const o = c.output;
    const delivers = [
      o.comment ? t("workflows.run.out.comment") : "",
      o.doc ? t("workflows.run.out.doc") : "",
      o.files ? t("workflows.run.out.files") : "",
      o.subtasks ? t("workflows.run.out.subtasks") : "",
      o.status ? t("workflows.run.out.status", { status: status(o.status) ?? o.status }) : "",
    ].filter(Boolean);
    const g = c.guardrails;
    const limits = [
      t("workflows.run.limitTime", { min: g.maxMinutes }),
      g.maxTokens ? t("workflows.run.limitTokens", { count: number(g.maxTokens) }) : "",
      g.ask === "never" ? t("workflows.run.noAsk") : "",
    ].filter(Boolean);
    return { delivers, limits };
  };
}

const chip = "bg-hover text-ink-soft inline-flex h-6 max-w-full items-center rounded-full px-2 text-xs";

/**
 * Starting a run of a workflow that asks for inputs: the form (by each field's type, defaults filled in), then what the
 * run is: where it runs and which computer takes it, what it delivers, its limits. Run sends the values; what the
 * server refuses (a required value, a wrong number) shows above the buttons and the dialog stays.
 */
export function RunDialog({
  workflow,
  runners,
  onClose,
  onRun,
}: {
  workflow: Workflow;
  runners: RunnerInfo[] | undefined;
  onClose: () => void;
  /** Starts the run; rejects with the API's error (`body.message`) when refused. */
  onRun: (inputs: Record<string, string>) => Promise<void>;
}) {
  const t = useT();
  const uid = useId();
  const facts = useHarnessFacts()(workflow.config);
  const usual = useWorkflowEstimate(workflow.id, workflow.config.estimate !== false);
  const fields = workflow.config.inputs;
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.key, f.default ?? ""])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const set = (key: string, v: string) => {
    setValues((x) => ({ ...x, [key]: v }));
    if (missing === key) setMissing(null);
  };
  const run = async () => {
    const lack = fields.find((f) => f.required && !values[f.key]?.trim());
    if (lack) {
      setMissing(lack.key);
      setError(t("workflows.run.fillRequired", { label: lack.label }));
      document.getElementById(`${uid}-${lack.key}`)?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onRun(Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim())));
    } catch (e) {
      setError((e as { body?: { message?: string } }).body?.message ?? t("common.actionFailed"));
      setBusy(false);
    }
  };
  return (
    <Modal
      wide
      title={t("workflows.run.dialogTitle", { name: workflow.name })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btn} onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" form={`${uid}-form`} className={btnPrimary} disabled={busy}>
            <PlayIcon />
            {busy ? t("workflows.run.starting") : t("workflows.run.go")}
          </button>
        </>
      }
    >
      <form
        id={`${uid}-form`}
        className="grid min-w-0 gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <div className="grid min-w-0 gap-4">
          {fields.map((f, i) => (
            <InputControl
              key={f.key}
              id={`${uid}-${f.key}`}
              field={f}
              value={values[f.key] ?? ""}
              invalid={missing === f.key}
              autoFocus={i === 0}
              onChange={(v) => set(f.key, v)}
            />
          ))}
        </div>
        {/* What pressing Run sets off: where, what comes back, and the limits it runs under. */}
        <dl className="border-hairline m-0 grid min-w-0 gap-2.5 border-t pt-4 text-xs">
          <div className="grid min-w-0 gap-1.5 sm:grid-cols-[5.5rem_minmax(0,1fr)] sm:items-start">
            <dt className="text-ink-2 sm:pt-1">{t("workflows.run.where")}</dt>
            <dd className="m-0 grid min-w-0 justify-items-start gap-1.5">
              <EnvBadge env={workflow.config.environment} />
              <RunnerLine workflow={workflow} runners={runners} />
            </dd>
          </div>
          {facts.delivers.length ? (
            <div className="grid min-w-0 gap-1.5 sm:grid-cols-[5.5rem_minmax(0,1fr)] sm:items-start">
              <dt className="text-ink-2 sm:pt-1">{t("workflows.run.delivers")}</dt>
              <dd className="m-0 flex min-w-0 flex-wrap gap-1">
                {facts.delivers.map((x) => (
                  <span key={x} className={chip}>
                    <span className="truncate">{x}</span>
                  </span>
                ))}
              </dd>
            </div>
          ) : null}
          {usual && usual.totalSec > 0 ? (
            <div className="grid min-w-0 gap-1.5 sm:grid-cols-[5.5rem_minmax(0,1fr)] sm:items-start">
              <dt className="text-ink-2 sm:pt-1">{t("workflows.run.eta.label")}</dt>
              <dd className="m-0 min-w-0 sm:pt-1">
                <UsualTime estimate={usual} className="text-ink-soft" />
              </dd>
            </div>
          ) : null}
          <div className="grid min-w-0 gap-1.5 sm:grid-cols-[5.5rem_minmax(0,1fr)] sm:items-start">
            <dt className="text-ink-2 sm:pt-1">{t("workflows.run.limits")}</dt>
            <dd className="m-0 flex min-w-0 flex-wrap gap-1">
              {facts.limits.map((x) => (
                <span key={x} className={cx(chip, "tabular-nums")}>
                  {x}
                </span>
              ))}
            </dd>
          </div>
        </dl>
        {error ? (
          <p role="alert" className="bg-block-wash text-block m-0 rounded-lg px-3 py-2 text-sm">
            {error}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}

function InputControl({
  id,
  field: f,
  value,
  invalid,
  autoFocus,
  onChange,
}: {
  id: string;
  field: InputField;
  value: string;
  invalid: boolean;
  autoFocus: boolean;
  onChange: (v: string) => void;
}) {
  const t = useT();
  const common = { id, "aria-invalid": invalid || undefined, "aria-required": f.required || undefined, autoFocus, placeholder: f.placeholder };
  return (
    <div className="grid min-w-0 gap-1.5">
      <label htmlFor={id} className="text-ink flex min-w-0 items-baseline gap-1.5 text-sm font-medium">
        <span className="min-w-0 break-words">{f.label}</span>
        {f.required ? (
          <span className="text-block shrink-0" title={t("workflows.run.required")}>
            <span aria-hidden="true">*</span>
            <span className="sr-only">{t("workflows.run.required")}</span>
          </span>
        ) : null}
      </label>
      {f.type === "long" ? (
        <textarea {...common} className={cx(textarea, "min-h-24")} value={value} maxLength={8000} onChange={(e) => onChange(e.target.value)} />
      ) : f.type === "choice" ? (
        <Picker
          variant="field"
          label={f.label}
          placeholder={f.placeholder || t("workflows.run.pick")}
          value={value}
          onChange={onChange}
          options={[...(f.required ? [] : [{ value: "", label: t("workflows.run.noValue") }]), ...(f.options ?? []).map((o) => ({ value: o, label: o }))]}
        />
      ) : (
        <input
          {...common}
          className={cx(input, f.type !== "text" && "sm:max-w-56")}
          type={f.type === "number" ? "number" : f.type === "date" ? "date" : "text"}
          inputMode={f.type === "number" ? "decimal" : undefined}
          value={value}
          maxLength={f.type === "text" ? 500 : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  );
}
