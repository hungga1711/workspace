"use client";

import { useT } from "@/lib/i18n/client";
import type { MessageKey } from "@/lib/i18n/core";
import { cx } from "@/lib/ui";
import { SearchIcon } from "@/components/app/icons";
import { searchPill } from "@/lib/ui";
import { STEP_ICON, STEP_TONE } from "../bits";
import { TONE } from "@/components/ui/Bento";
import { CATEGORIES, defaultConfig, type Category, type RunnerInfo, type StepKind, type WorkflowConfig, type WorkflowStep } from "../types";

type Sub<P extends string> = MessageKey extends infer K ? (K extends `${P}${infer R}` ? R : never) : never;
/** The library's own strings by short key: `k("fig.running")` is `workflows.library.fig.running`. */
export type LibraryKey = Sub<"workflows.library.">;
export type FactKey = Sub<"workflows.library.facts.">;

/** A workflow's config with every part present: rows read from an older server (no `config`) still draw. */
export function configOf(w: { config?: WorkflowConfig | null; runner?: "server" | "local" }): WorkflowConfig {
  const base = defaultConfig(w.runner === "local" ? "computer" : "assistant");
  const c = w.config;
  if (!c) return base;
  return {
    inputs: c.inputs ?? [],
    environment: c.environment ?? base.environment,
    resources: { ...base.resources, ...c.resources },
    guardrails: { ...base.guardrails, ...c.guardrails },
    output: { ...base.output, ...c.output },
    autoStart: !!c.autoStart,
    estimate: c.estimate !== false,
  };
}

/** Whether something can take this workflow's runs now. null: nothing is missing. */
export function missingFor(c: WorkflowConfig, aiOn: boolean, runners: RunnerInfo[]): "ai" | "runner" | "companyRunner" | "docker" | null {
  const e = c.environment;
  if (e.kind === "assistant") return aiOn ? null : "ai";
  const live = runners.filter((r) => r.online);
  if (e.kind === "sandbox" && e.host === "company") {
    const shared = live.filter((r) => r.shared);
    if (!shared.length) return "companyRunner";
    return e.isolation === "container" && !shared.some((r) => r.docker) ? "docker" : null;
  }
  // A person's own computer: the reader's, as far as this page can tell (the assignee's is checked at Run).
  const mine = live.filter((r) => r.mine);
  if (!mine.length) return "runner";
  return e.kind === "sandbox" && e.isolation === "container" && !mine.some((r) => r.docker) ? "docker" : null;
}

/** Department order as the server lists it; unknown ones last. */
export const categoryRank = (c: Category) => {
  const i = (CATEGORIES as readonly string[]).indexOf(c);
  return i < 0 ? CATEGORIES.length : i;
};

/**
 * The department filter: "All" then each department present, with counts. One row that scrolls sideways on a phone
 * (padding keeps the focus ring inside the scroller).
 */
export function CategoryChips({
  counts,
  total,
  value,
  onChange,
  label,
}: {
  counts: Map<Category, number>;
  total: number;
  value: Category | "all";
  onChange: (v: Category | "all") => void;
  label: string;
}) {
  const t = useT();
  const cats = [...counts.keys()].sort((a, b) => categoryRank(a) - categoryRank(b));
  return (
    <div role="group" aria-label={label} className="-mx-1 flex min-w-0 gap-1.5 overflow-x-auto px-1 py-1 [scrollbar-width:none]">
      <FilterChip active={value === "all"} onClick={() => onChange("all")} n={total}>
        {t("workflows.library.all")}
      </FilterChip>
      {cats.map((c) => (
        <FilterChip key={c} active={value === c} onClick={() => onChange(c)} n={counts.get(c) ?? 0}>
          {t(`workflows.category.${c}`)}
        </FilterChip>
      ))}
    </div>
  );
}

export function FilterChip({ active, onClick, n, children }: { active: boolean; onClick: () => void; n?: number; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cx(
        "focus-visible:outline-accent inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-[13px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 max-md:h-8",
        active ? "bg-brand text-on-brand" : "bg-surface text-ink-soft ring-hairline hover:bg-hover hover:text-ink ring-1 ring-inset",
      )}
    >
      {children}
      {n !== undefined ? <span className={cx("text-xs tabular-nums", active ? "opacity-70" : "text-ink-2")}>{n}</span> : null}
    </button>
  );
}

export function SearchField({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return (
    <label className={cx(searchPill, "w-full sm:w-64")}>
      <SearchIcon className="size-4 shrink-0" />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={label}
        aria-label={label}
        className="text-ink placeholder:text-ink-2 min-w-0 flex-1 border-0 bg-transparent p-0 outline-none"
      />
    </label>
  );
}

const count = (steps: Pick<WorkflowStep, "kind">[], kind: StepKind) => steps.filter((s) => s.kind === kind).length;

/**
 * The pipeline at a glance: a tinted dot per step (its kind's icon) and one line of figures:
 * "6 steps · 1 check · 1 approval". Every step is named to assistive tech; the eye gets the shape.
 */
export function StepStrip({ steps }: { steps: Pick<WorkflowStep, "kind" | "title">[] }) {
  const t = useT();
  const checks = count(steps, "check");
  const approvals = count(steps, "approval");
  const shown = steps.slice(0, 12);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
      <ol className="m-0 flex list-none items-center p-0" aria-label={t("workflows.steps")}>
        {shown.map((s, i) => (
          <li key={i} className="flex items-center">
            {i ? <span aria-hidden="true" className="bg-edge h-px w-1.5" /> : null}
            <span
              title={s.title}
              className={cx("ring-current/15 grid size-5 place-items-center rounded-full ring-1 ring-inset [&_svg]:size-2.5", TONE[STEP_TONE[s.kind]] ?? "bg-hover text-ink-2")}
            >
              <span aria-hidden="true" className="contents">
                {STEP_ICON[s.kind]}
              </span>
              <span className="sr-only">{s.title}</span>
            </span>
          </li>
        ))}
        {steps.length > shown.length ? <li className="text-ink-2 pl-1 text-xs tabular-nums">+{steps.length - shown.length}</li> : null}
      </ol>
      <span className="text-ink-2 text-xs">
        {[
          t("workflows.library.nSteps", { count: steps.length }),
          checks ? t("workflows.library.nChecks", { count: checks }) : "",
          approvals ? t("workflows.library.nApprovals", { count: approvals }) : "",
        ]
          .filter(Boolean)
          .join(" · ")}
      </span>
    </div>
  );
}
