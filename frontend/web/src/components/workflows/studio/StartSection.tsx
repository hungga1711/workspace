"use client";

import { useFormat, useT } from "@/lib/i18n/client";
import { STATUS_KEYS } from "@/lib/format";
import { btn, btnGhost, btnSm, cx, input } from "@/lib/ui";
import { CalendarIcon, CheckIcon, CloseIcon, InfoIcon, LinkIcon, PlayIcon, SendIcon, TrashIcon, WorkIcon } from "@/components/app/icons";
import { Checkbox } from "@/components/ui/Checkbox";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { Picker } from "@/components/ui/Picker";
import { Segmented } from "@/components/ui/Segmented";
import { useProjects, useWeekdays, type ProjectNames } from "../starts";
import type { Trigger, TriggerKind } from "../types";
import { mayAutoStart } from "./draft";
import { ChipInput, Group, SectionCard } from "./parts";
import type { SectionProps } from "./sections";

const MAX = 6;
const KINDS: { kind: TriggerKind; icon: React.ReactNode }[] = [
  { kind: "task", icon: <WorkIcon /> },
  { kind: "schedule", icon: <CalendarIcon /> },
  { kind: "hook", icon: <SendIcon /> },
  { kind: "linked", icon: <LinkIcon /> },
];
const KIND_ICON = Object.fromEntries(KINDS.map((k) => [k.kind, k.icon])) as Record<TriggerKind, React.ReactNode>;

/** A new way of starting with sensible first values; its id is kept for good (an address is tied to it). */
function blank(kind: TriggerKind, taken: string[]): Trigger {
  let n = taken.length + 1;
  while (taken.includes(`start-${n}`)) n++;
  const id = `start-${n}`;
  if (kind === "task") return { id, kind, on: "status", status: "review", projects: [], labels: [] };
  if (kind === "schedule") return { id, kind, every: "week", days: [1], time: "09:00", projectId: "", title: "" };
  if (kind === "hook") return { id, kind, projectId: "", title: "" };
  return { id, kind, on: "merged", projects: [] };
}

/**
 * 8 · When a run starts. Pressing Run on a task always works; here the workflow is also told to start by
 * itself: when it is put on a task, when a task changes, on a schedule, when another system sends something, when
 * linked work changes. Written for an office manager: plain choices, no schedule syntax, and "webhook" only as the
 * word some people know it by. Not offered where a run needs a person's own computer, and the page says why.
 */
export function StartSection({ d, set }: SectionProps) {
  const t = useT();
  const may = mayAutoStart(d.config.environment);
  const triggers = d.config.triggers ?? [];
  const projects = useProjects(may && triggers.length > 0);
  const put = (next: Trigger[]) => set((x) => ({ ...x, config: { ...x.config, triggers: next } }));
  const change = (i: number, next: Trigger) => put(triggers.map((x, j) => (j === i ? next : x)));
  return (
    <SectionCard n={8} title={t("workflows.studio.section.start")} hint={t("workflows.studio.hint.start")}>
      <p className="text-ink-soft m-0 flex min-w-0 items-center gap-2 text-[13px]">
        <span aria-hidden="true" className="bg-ok-wash text-ok grid size-5 shrink-0 place-items-center rounded-full [&_svg]:size-3">
          <CheckIcon />
        </span>
        {t("workflows.start.always")}
      </p>
      {!may ? (
        // A person's own computer: only that person starts it. Said here, with the way to change it.
        <p className="bg-hover text-ink-soft m-0 flex min-w-0 items-start gap-2 rounded-lg px-3 py-2.5 text-[13px]/5">
          <InfoIcon className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0">{t("workflows.start.off")}</span>
        </p>
      ) : (
        <>
          <Checkbox
            label={t("workflows.studio.out.auto")}
            hint={t("workflows.studio.out.autoHint")}
            checked={d.config.autoStart}
            onChange={(e) => set((x) => ({ ...x, config: { ...x.config, autoStart: e.target.checked } }))}
          />
          {triggers.length ? (
            <ul className="m-0 grid min-w-0 list-none gap-3 p-0">
              {triggers.map((x, i) => (
                <li key={x.id} className="ring-hairline grid min-w-0 gap-3.5 rounded-xl p-3.5 ring-1 ring-inset">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span aria-hidden="true" className="bg-accent-wash text-accent-text grid size-7 shrink-0 place-items-center rounded-lg [&_svg]:size-4">
                      {KIND_ICON[x.kind]}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-ink m-0 text-sm font-semibold">{t(`workflows.start.kind.${x.kind}`)}</p>
                      <p className="text-ink-2 m-0 text-xs">{t(`workflows.start.kindHint.${x.kind}`)}</p>
                    </div>
                    <button
                      type="button"
                      className={cx(btnGhost, btnSm, "shrink-0")}
                      aria-label={t("workflows.start.remove", { name: t(`workflows.start.kind.${x.kind}`) })}
                      title={t("workflows.start.remove", { name: t(`workflows.start.kind.${x.kind}`) })}
                      onClick={() => put(triggers.filter((_, j) => j !== i))}
                    >
                      <TrashIcon />
                    </button>
                  </div>
                  <TriggerFields x={x} onChange={(next) => change(i, next)} projects={projects.projects} />
                </li>
              ))}
            </ul>
          ) : null}
          {projects.failed ? <LoadFailed what={t("workflows.start.projects")} onRetry={projects.retry} /> : null}
          {triggers.length < MAX ? (
            <Group label={t(triggers.length ? "workflows.start.addMore" : "workflows.start.add")}>
              <div className="grid min-w-0 gap-2 sm:grid-cols-2">
                {KINDS.map((k) => (
                  <button
                    key={k.kind}
                    type="button"
                    className="ring-hairline hover:bg-hover flex min-w-0 items-start gap-2.5 rounded-xl px-3 py-2.5 text-left ring-1 ring-inset"
                    onClick={() =>
                      put([
                        ...triggers,
                        blank(
                          k.kind,
                          triggers.map((x) => x.id),
                        ),
                      ])
                    }
                  >
                    <span aria-hidden="true" className="bg-hover text-ink-soft mt-0.5 grid size-6 shrink-0 place-items-center rounded-md [&_svg]:size-3.5">
                      {k.icon}
                    </span>
                    <span className="grid min-w-0">
                      <span className="text-ink text-[13px] font-medium">{t(`workflows.start.kind.${k.kind}`)}</span>
                      <span className="text-ink-2 text-xs">{t(`workflows.start.kindHint.${k.kind}`)}</span>
                    </span>
                  </button>
                ))}
              </div>
            </Group>
          ) : (
            <p className="text-ink-2 m-0 text-xs">{t("workflows.start.max", { n: MAX })}</p>
          )}
          {triggers.length ? (
            <p className="text-ink-2 m-0 flex min-w-0 items-start gap-2 text-xs/5">
              <PlayIcon className="mt-0.5 size-3.5 shrink-0" />
              <span className="min-w-0">{t("workflows.start.rules")}</span>
            </p>
          ) : null}
        </>
      )}
    </SectionCard>
  );
}

/** Projects as chips with a picker to add one; none chosen means any project. */
function ProjectChips({ label, value, onChange, projects }: { label: string; value: string[]; onChange: (v: string[]) => void; projects: ProjectNames | null }) {
  const t = useT();
  const name = (id: string) => projects?.find((p) => p.id === id)?.name ?? t("workflows.start.text.aProject");
  const rest = (projects ?? []).filter((p) => !value.includes(p.id));
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      {value.length ? (
        value.map((id) => (
          <span key={id} className="bg-selected text-ink-soft inline-flex h-7 max-w-full items-center gap-1 rounded-md pl-2 pr-1 text-[13px]">
            <span className="truncate">{name(id)}</span>
            <button
              type="button"
              className="hover:bg-hover hover:text-ink grid size-5 place-items-center rounded"
              onClick={() => onChange(value.filter((x) => x !== id))}
              aria-label={t("workflows.studio.remove", { name: name(id) })}
            >
              <CloseIcon className="size-3" />
            </button>
          </span>
        ))
      ) : (
        <span className="text-ink-2 text-[13px]">{t("workflows.start.projectsAny")}</span>
      )}
      {rest.length && value.length < 20 ? (
        <Picker
          variant="button"
          label={label}
          value=""
          placeholder={t("workflows.start.addProject")}
          onChange={(v) => v && onChange([...value, v])}
          options={rest.map((p) => ({ value: p.id, label: p.name }))}
        />
      ) : null}
    </div>
  );
}

/** Where the task a schedule or another system's message makes goes, and what it is called. */
function NewTask({ x, onChange, projects }: { x: Extract<Trigger, { kind: "schedule" | "hook" }>; onChange: (next: Trigger) => void; projects: ProjectNames | null }) {
  const t = useT();
  return (
    <div className="grid min-w-0 gap-3.5 sm:grid-cols-2">
      <Group label={t("workflows.start.newTask.title")} hint={t("workflows.start.newTask.titleHint", { token: "{date}" })}>
        <input
          className={input}
          aria-label={t("workflows.start.newTask.title")}
          value={x.title}
          maxLength={200}
          placeholder={t("workflows.start.newTask.titlePlaceholder", { token: "{date}" })}
          onChange={(e) => onChange({ ...x, title: e.target.value })}
        />
      </Group>
      <Group label={t("workflows.start.newTask.project")}>
        <Picker
          variant="field"
          label={t("workflows.start.newTask.project")}
          value={x.projectId}
          onChange={(v) => onChange({ ...x, projectId: v })}
          options={[
            { value: "", label: t("workflows.start.newTask.personal") },
            ...(projects ?? []).map((p) => ({ value: p.id, label: p.name })),
            // A project chosen earlier that the list no longer has (or could not be read) stays chosen.
            ...(x.projectId && !(projects ?? []).some((p) => p.id === x.projectId) ? [{ value: x.projectId, label: t("workflows.start.text.aProject") }] : []),
          ]}
        />
      </Group>
    </div>
  );
}

function TriggerFields({ x, onChange, projects }: { x: Trigger; onChange: (next: Trigger) => void; projects: ProjectNames | null }) {
  const t = useT();
  const f = useFormat();
  const days = useWeekdays();
  if (x.kind === "task")
    return (
      <>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="text-ink-soft text-[13px]">{t("workflows.start.task.when")}</span>
          <Segmented
            size="sm"
            label={t("workflows.start.task.when")}
            value={x.on}
            onChange={(on) => onChange(on === "created" ? { id: x.id, kind: "task", on, projects: x.projects, labels: x.labels } : { ...x, on, status: x.status ?? "review" })}
            options={[
              { value: "status", label: t("workflows.start.task.moves") },
              { value: "created", label: t("workflows.start.task.created") },
            ]}
          />
          {x.on === "status" ? (
            <Picker
              variant="button"
              label={t("workflows.start.task.status")}
              value={x.status ?? "review"}
              onChange={(status) => onChange({ ...x, status })}
              options={STATUS_KEYS.map((k) => ({ value: k as string, label: f.status(k) ?? k }))}
            />
          ) : null}
        </div>
        <Group label={t("workflows.start.projects")}>
          <ProjectChips label={t("workflows.start.projects")} value={x.projects} onChange={(v) => onChange({ ...x, projects: v })} projects={projects} />
        </Group>
        <Group label={t("workflows.start.labels")} hint={t("workflows.start.labelsHint")}>
          <ChipInput label={t("workflows.start.labels")} values={x.labels} onChange={(labels) => onChange({ ...x, labels })} placeholder={t("workflows.start.labelsPlaceholder")} />
        </Group>
      </>
    );
  if (x.kind === "schedule")
    return (
      <>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Segmented
            size="sm"
            label={t("workflows.start.schedule.how")}
            value={x.every}
            onChange={(every) => onChange({ ...x, every, days: every === "week" ? (x.days.length ? x.days : [1]) : [] })}
            options={[
              { value: "week", label: t("workflows.start.schedule.week") },
              { value: "day", label: t("workflows.start.schedule.day") },
            ]}
          />
          <label className="text-ink-soft flex items-center gap-2 text-[13px]">
            {t("workflows.start.schedule.at")}
            <input type="time" className={cx(input, "w-28")} value={x.time} onChange={(e) => e.target.value && onChange({ ...x, time: e.target.value })} />
          </label>
        </div>
        {x.every === "week" ? (
          <div role="group" aria-label={t("workflows.start.schedule.days")} className="flex min-w-0 flex-wrap gap-1.5">
            {/* Monday first, as a working week reads. */}
            {[1, 2, 3, 4, 5, 6, 0].map((day) => {
              const on = x.days.includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  aria-pressed={on}
                  // The last day cannot be switched off: a week with no day is no schedule.
                  onClick={() => (on && x.days.length === 1 ? undefined : onChange({ ...x, days: on ? x.days.filter((v) => v !== day) : [...x.days, day].sort() }))}
                  className={cx("h-8 min-w-11 rounded-lg px-2.5 text-[13px] font-medium", on ? "bg-ink text-surface" : cx(btn, "h-8"))}
                >
                  {days[day]}
                </button>
              );
            })}
          </div>
        ) : null}
        <p className="text-ink-2 m-0 text-xs">{t("workflows.start.schedule.zone")}</p>
        <NewTask x={x} onChange={onChange} projects={projects} />
      </>
    );
  if (x.kind === "hook")
    return (
      <>
        <NewTask x={x} onChange={onChange} projects={projects} />
        <p className="bg-hover text-ink-soft m-0 flex min-w-0 items-start gap-2 rounded-lg px-3 py-2 text-[13px]/5">
          <InfoIcon className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0">{t("workflows.start.hook.later")}</span>
        </p>
      </>
    );
  return (
    <>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="text-ink-soft text-[13px]">{t("workflows.start.linked.when")}</span>
        <Segmented
          size="sm"
          label={t("workflows.start.linked.when")}
          value={x.on}
          onChange={(on) => onChange({ ...x, on })}
          options={[
            { value: "merged", label: t("workflows.start.linked.merged") },
            { value: "opened", label: t("workflows.start.linked.opened") },
          ]}
        />
      </div>
      <Group label={t("workflows.start.projects")}>
        <ProjectChips label={t("workflows.start.projects")} value={x.projects} onChange={(v) => onChange({ ...x, projects: v })} projects={projects} />
      </Group>
      <p className="text-ink-2 m-0 text-xs">{t("workflows.start.linked.needs")}</p>
    </>
  );
}
