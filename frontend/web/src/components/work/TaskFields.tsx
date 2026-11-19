"use client";

import { useT, useFormat } from "@/lib/i18n/client";
import { useState } from "react";
import { Avatar, useDirectory } from "@/lib/people";
import { cx, input } from "@/lib/ui";
import { CloseIcon, MeIcon } from "@/components/app/icons";
import { Picker } from "@/components/ui/Picker";
import { Checkbox } from "@/components/ui/Checkbox";
import { DateField } from "@/components/ui/DateField";
import type { FieldDef } from "./types";

/** Who does it: a filterable list of people with their avatars (the form version of the assignee property). */
export function AssigneeSelect({
  value,
  onChange,
  id,
  label,
  variant = "field",
  suggested = [],
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  id?: string;
  label?: string;
  variant?: "field" | "button" | "property";
  /** People to list first (those already working in the task's project), in this order. */
  suggested?: string[];
}) {
  const tx = useT();
  const dir = useDirectory();
  const first = new Map(suggested.map((id, i) => [id, i]));
  const people = dir.people
    .filter((p) => p.status !== "disabled")
    .map((p, i) => ({ p, i }))
    // Me first, then the project's people, then everyone else in the directory's order.
    .sort((a, b) => rankOf(a.p.userId) - rankOf(b.p.userId) || a.i - b.i)
    .map((x) => x.p);
  function rankOf(id: string) {
    return id === dir.me ? -1 : (first.get(id) ?? suggested.length + 1);
  }
  return (
    <Picker
      id={id}
      variant={variant}
      label={label ?? tx("work.taskfields.assignee")}
      value={value ?? ""}
      onChange={(v) => onChange(v || null)}
      options={[
        {
          value: "",
          label: tx("work.taskfields.chua_giao"),
          icon: (
            <span className="text-ink-2/70 grid size-5 shrink-0 place-items-center">
              <MeIcon className="size-4" />
            </span>
          ),
        },
        ...people.map((p) => ({
          value: p.userId,
          label: p.displayName + (p.userId === dir.me ? tx("work.taskfields.toi") : ""),
          icon: <Avatar id={p.userId} size="xs" />,
          keywords: p.email,
        })),
      ]}
    />
  );
}

export function PrioritySelect({
  value,
  onChange,
  id,
  label,
  variant = "field",
}: {
  value: string;
  onChange: (v: string) => void;
  id?: string;
  label?: string;
  variant?: "field" | "button" | "property";
}) {
  const tx = useT();
  const { priority } = useFormat();
  return (
    <Picker
      id={id}
      variant={variant}
      label={label ?? tx("work.taskfields.priority")}
      value={value}
      onChange={onChange}
      options={["urgent", "high", "medium", "low"].map((p) => ({ value: p, label: priority(p) ?? p, icon: <PriorityMark priority={p} /> }))}
    />
  );
}

/** Labels as removable chips; Enter or comma adds one. */
export function LabelsInput({ value, onChange, ghost = false }: { value: string[]; onChange: (v: string[]) => void; ghost?: boolean }) {
  const tx = useT();
  const [draft, setDraft] = useState("");
  const add = () => {
    const v = draft.trim().replace(/,$/, "");
    if (v && !value.includes(v)) onChange([...value, v]);
    setDraft("");
  };
  return (
    <div
      className={cx(
        "flex flex-wrap items-center gap-1.5 rounded-md",
        ghost
          ? "hover:bg-ink/5 focus-within:bg-ink/5 -mx-2 min-h-8 px-2 py-1 transition-colors"
          : "border-hairline bg-surface focus-within:border-ink-2 min-h-9 border px-2 py-1.5 focus-within:shadow-[0_0_0_3px_var(--selected)]",
      )}
    >
      {value.map((l) => (
        <span key={l} className="bg-hover inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-xs">
          {l}
          <button type="button" aria-label={tx("work.taskfields.bo_nhan", { p0: l })} onClick={() => onChange(value.filter((x) => x !== l))} className="text-ink-2 hover:text-ink">
            <CloseIcon className="size-3" />
          </button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={add}
        placeholder={value.length ? "" : tx("work.taskfields.them_nhan_2")}
        aria-label={tx("work.taskfields.them_nhan")}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add();
          }
          if (e.key === "Backspace" && !draft && value.length) onChange(value.slice(0, -1));
        }}
        className="min-w-24 flex-1 bg-transparent text-sm outline-none"
      />
    </div>
  );
}

/** Workspace-defined custom fields, rendered from their definitions; `ghost` = property rows (task page). */
export function CustomFieldInputs({
  defs,
  value,
  onChange,
  ghost = false,
}: {
  defs: FieldDef[];
  value: Record<string, unknown>;
  onChange: (v: Record<string, unknown>) => void;
  ghost?: boolean;
}) {
  const set = (k: string, v: unknown) => onChange({ ...value, [k]: v });
  return (
    <>
      {defs.map((d) => {
        const label = `${d.label}${d.required ? " *" : ""}`;
        const control =
          d.type === "select" ? (
            ghost ? (
              <Picker
                label={d.label}
                value={String(value[d.key] ?? "")}
                onChange={(v) => set(d.key, v || null)}
                options={[{ value: "", label: "—" }, ...d.options.map((o) => ({ value: o, label: o }))]}
              />
            ) : (
              <Picker
                variant="field"
                label={d.label}
                value={String(value[d.key] ?? "")}
                onChange={(v) => set(d.key, v || null)}
                options={[{ value: "", label: "—" }, ...d.options.map((o) => ({ value: o, label: o }))]}
              />
            )
          ) : d.type === "boolean" ? (
            <Checkbox checked={Boolean(value[d.key])} onChange={(e) => set(d.key, e.target.checked)} aria-label={d.label} />
          ) : d.type === "date" ? (
            <DateField variant={ghost ? "property" : "field"} label={d.label} value={String(value[d.key] ?? "").slice(0, 10)} onChange={(v) => set(d.key, v || null)} />
          ) : (
            <input
              className={ghost ? ghostInput : input}
              aria-label={ghost ? d.label : undefined}
              type={d.type === "number" ? "number" : "text"}
              value={String(value[d.key] ?? "")}
              onChange={(e) => set(d.key, d.type === "number" ? (e.target.value === "" ? null : Number(e.target.value)) : e.target.value)}
            />
          );
        return ghost ? (
          <div key={d.key} className="grid min-h-8 grid-cols-[112px_minmax(0,1fr)] items-center gap-2">
            <span className="text-ink-2 truncate text-sm">{label}</span>
            <div className="min-w-0">{control}</div>
          </div>
        ) : (
          <label key={d.key} className="grid grid-cols-1 gap-1.5">
            <span className="text-sm font-medium">{label}</span>
            {control}
          </label>
        );
      })}
    </>
  );
}

// The Picker moved to components/ui (shared); re-exported here for existing imports.
export { Picker, type PickerOption } from "@/components/ui/Picker";

/** Priority as signal bars; urgent is the one red mark. */
export function PriorityMark({ priority, className }: { priority: string; className?: string }) {
  if (priority === "urgent")
    return (
      <span aria-hidden="true" className={cx("bg-block grid size-4 shrink-0 place-items-center rounded-[4px] text-[11px] font-bold leading-none text-white", className)}>
        !
      </span>
    );
  const on = priority === "high" ? 3 : priority === "medium" ? 2 : 1;
  return (
    <svg aria-hidden="true" viewBox="0 0 14 14" className={cx("size-3.5 shrink-0", className)}>
      {[0, 1, 2].map((i) => (
        <rect key={i} x={1 + i * 4.5} y={10 - i * 3.5} width="3" height={3 + i * 3.5} rx="1" className={i < on ? "fill-ink" : "fill-ink/20"} />
      ))}
    </svg>
  );
}

/** A date or date-time input that reads as a property value until focused. */
const ghostInput =
  "-mx-2 h-8 w-[calc(100%+1rem)] min-w-0 rounded-md bg-transparent px-2 text-sm text-ink outline-none transition-colors hover:bg-ink/5 focus:bg-ink/5 disabled:opacity-50";
