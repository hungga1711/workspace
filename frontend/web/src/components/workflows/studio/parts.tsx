"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { useT } from "@/lib/i18n/client";
import { cx, input } from "@/lib/ui";
import { CheckIcon, CloseIcon } from "@/components/app/icons";

// The Markdown field (toolbar, preview) loads with the section that shows it, not with the studio's first paint.
export const RichField = dynamic(() => import("../RichField").then((m) => m.RichField), {
  ssr: false,
  loading: () => <div className="border-hairline bg-surface min-h-24 rounded-lg border" />,
});

/** One section of the studio: its number, title, a line of what it is for, then the fields. */
export function SectionCard({ n, title, hint, aside, children }: { n: number; title: string; hint: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="bg-surface shadow-card grid min-w-0 gap-4 rounded-xl p-5 max-sm:p-4" aria-label={title}>
      <header className="flex min-w-0 items-start gap-3">
        <span aria-hidden="true" className="bg-hover text-ink-soft grid size-6 shrink-0 place-items-center rounded-md text-xs font-semibold tabular-nums">
          {n}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-ink m-0 text-base/6 font-semibold">{title}</h2>
          <p className="text-ink-2 m-0 text-[13px]/5">{hint}</p>
        </div>
        {aside}
      </header>
      {children}
    </section>
  );
}

/** A labelled group inside a section. `label` is plain text, not a <label>: the group may hold several controls. */
export function Group({ label, hint, aside, children, className }: { label: string; hint?: string; aside?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={cx("grid min-w-0 content-start gap-1.5", className)}>
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3">
        <span className="text-sm font-medium">{label}</span>
        {aside}
      </div>
      {children}
      {hint ? <p className="text-ink-2 m-0 text-xs">{hint}</p> : null}
    </div>
  );
}

/** A whole number with its unit after it ("60 min"); empty or out of range falls back on blur. */
export function Num({
  label,
  value,
  onChange,
  min,
  max,
  unit,
  step = 1,
  className,
  blank,
}: {
  label: string;
  value: number | undefined;
  onChange: (n: number | undefined) => void;
  min: number;
  max: number;
  unit?: string;
  step?: number;
  className?: string;
  /** Shown while there is no value (an optional number, e.g. "default"). Without it the field always holds a number. */
  blank?: string;
}) {
  const [text, setText] = useState<string | null>(null);
  const commit = (raw: string) => {
    setText(null);
    if (!raw.trim()) return onChange(blank !== undefined ? undefined : min);
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    const rounded = step < 1 ? Math.round(n / step) * step : Math.round(n);
    onChange(Math.min(max, Math.max(min, rounded)));
  };
  return (
    <span className={cx("relative inline-flex min-w-0 items-center", className)}>
      <input
        className={cx(input, "tabular-nums", unit && "pr-12")}
        inputMode={step < 1 ? "decimal" : "numeric"}
        aria-label={label}
        value={text ?? (value === undefined ? "" : String(value))}
        placeholder={blank}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit((e.target as HTMLInputElement).value);
        }}
      />
      {unit ? <span className="text-ink-2 pointer-events-none absolute right-2.5 text-xs">{unit}</span> : null}
    </span>
  );
}

/** A list of short values typed one at a time (Enter or comma adds, × removes): options of a choice, variable names. */
export function ChipInput({
  label,
  values,
  onChange,
  placeholder,
  max = 20,
  valid,
  mono,
}: {
  label: string;
  values: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  max?: number;
  /** Refuses a value that does not pass (a variable name). */
  valid?: (v: string) => boolean;
  mono?: boolean;
}) {
  const t = useT();
  const [text, setText] = useState("");
  const add = () => {
    const v = text.trim().replace(/,$/, "").trim();
    if (!v || values.includes(v) || values.length >= max || (valid && !valid(v))) return;
    onChange([...values, v]);
    setText("");
  };
  return (
    <div className="border-edge bg-surface focus-within:border-ink-2/60 flex min-h-8 min-w-0 flex-wrap items-center gap-1 rounded-[10px] border px-1.5 py-1 max-md:min-h-10">
      {values.map((v) => (
        <span key={v} className={cx("bg-selected text-ink-soft inline-flex h-6 max-w-full items-center gap-1 rounded-md pl-2 pr-1 text-xs", mono && "font-mono")}>
          <span className="truncate">{v}</span>
          <button
            type="button"
            className="hover:bg-hover hover:text-ink grid size-4 place-items-center rounded"
            onClick={() => onChange(values.filter((x) => x !== v))}
            aria-label={t("workflows.studio.remove", { name: v })}
          >
            <CloseIcon className="size-3" />
          </button>
        </span>
      ))}
      <input
        className={cx("placeholder:text-ink-2 h-6 min-w-24 flex-1 bg-transparent px-1 text-sm outline-none", mono && "font-mono text-[13px]")}
        aria-label={label}
        value={text}
        placeholder={values.length ? "" : placeholder}
        onChange={(e) => setText(e.target.value)}
        onBlur={add}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add();
          } else if (e.key === "Backspace" && !text && values.length) onChange(values.slice(0, -1));
        }}
      />
    </div>
  );
}

/**
 * A large choice among a few (where the workflow runs, how a check decides): the option as a card with its icon, name,
 * one line and what it can do. A radio group.
 */
export function ChoiceCards<V extends string>({
  label,
  value,
  onChange,
  options,
  columns = 3,
}: {
  label: string;
  value: V;
  onChange: (v: V) => void;
  options: { value: V; title: string; text: string; icon: React.ReactNode; ticks?: { on: boolean; text: string }[] }[];
  columns?: 2 | 3;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cx("grid min-w-0 gap-2.5", columns === 3 ? "md:grid-cols-3" : "sm:grid-cols-2")}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={cx(
              "grid min-w-0 content-start gap-2 rounded-xl p-3.5 text-left ring-1 ring-inset transition-shadow",
              on ? "bg-surface ring-ink shadow-card ring-[1.5px]" : "bg-ground ring-hairline hover:bg-surface hover:ring-edge",
            )}
          >
            <span className="flex min-w-0 items-center gap-2.5">
              <span
                aria-hidden="true"
                className={cx("grid size-8 shrink-0 place-items-center rounded-[9px] [&_svg]:size-4", on ? "bg-ink text-on-brand" : "bg-hover text-ink-soft")}
              >
                {o.icon}
              </span>
              <span className="text-ink min-w-0 flex-1 truncate text-sm font-semibold">{o.title}</span>
              <span aria-hidden="true" className={cx("grid size-4 shrink-0 place-items-center rounded-full border", on ? "border-ink bg-ink text-on-brand" : "border-edge")}>
                {on ? <CheckIcon className="size-2.5" /> : null}
              </span>
            </span>
            <span className="text-ink-soft text-[13px]/5">{o.text}</span>
            {o.ticks?.length ? (
              <span className="grid gap-0.5">
                {o.ticks.map((k) => (
                  <span key={k.text} className={cx("flex items-start gap-1.5 text-xs/5", k.on ? "text-ink-soft" : "text-ink-2")}>
                    <span aria-hidden="true" className={cx("mt-1 grid size-3 shrink-0 place-items-center", k.on ? "text-ok" : "text-ink-2")}>
                      {k.on ? <CheckIcon className="size-3" /> : <CloseIcon className="size-3" />}
                    </span>
                    {k.text}
                  </span>
                ))}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/** Rarely needed fields, folded under one line. */
export function Advanced({ label, children, open }: { label: string; children: React.ReactNode; open?: boolean }) {
  return (
    <details className="group/adv min-w-0" open={open}>
      <summary className="text-ink-2 hover:text-ink w-fit cursor-pointer list-none text-[13px] font-medium [&::-webkit-details-marker]:hidden">
        <span aria-hidden="true" className="mr-1 inline-block transition-transform group-open/adv:rotate-90">
          ›
        </span>
        {label}
      </summary>
      <div className="mt-3 grid min-w-0 gap-3.5">{children}</div>
    </details>
  );
}
