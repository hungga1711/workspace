"use client";

import { ProjectBadge } from "@/components/ui/ProjectBadge";
import * as m from "motion/react-m";
import { useT } from "@/lib/i18n/client";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import { btnGhost, btnPrimary, btnSm, cx } from "@/lib/ui";
import { useDialog } from "@/components/app/useDialog";
import { CloseIcon, CollapseIcon, ExpandIcon, ChevronRightIcon, PlusIcon } from "@/components/app/icons";
import { Portal } from "@/components/ui/Portal";
import { Picker } from "@/components/ui/Picker";
import { DateField } from "@/components/ui/DateField";
import { Checkbox } from "@/components/ui/Checkbox";
import { useToast } from "@/components/ui/Toast";
import { useDirectory } from "@/lib/people";
import { PropertyList, PropertyRow } from "@/components/ui/PropertyRow";
import { at } from "./calTime";
import { AssigneeSelect, CustomFieldInputs, LabelsInput, PrioritySelect } from "./TaskFields";
import { REPEAT } from "./recurrence";
import { MarkdownToolbar, continueListOnEnter, markdownShortcut } from "@/components/ui/MarkdownToolbar";
import type { FieldDef, Project } from "./types";
import { taskHref } from "@/lib/links";
import { useAiEnabled } from "@/lib/ai-context";
import { descriptionTemplate, withTemplate } from "@/lib/task-write";
import { useTaskWrite } from "./TaskWrite";
import { useConfirm } from "@/components/ui/Confirm";

/**
 * New task as a compose window: a big title, a borderless description, then one row of property chips
 * (assignee, priority, due, repeat, labels) instead of a form of boxes. ⌘/Ctrl+Enter creates; "Tạo thêm" keeps
 * the window open for the next one. The project sits in the window's breadcrumb, where the task will live.
 * "Mở rộng" turns it into a full form (remembered for next time): a larger description and subtasks on the left,
 * every property on the right (column, start date, parent task, custom fields…), like the task's own page.
 */
export function NewTaskDrawer({
  projects,
  fields = [],
  defaultProject = null,
  defaultColumn = null,
  defaultStatus = null,
  defaultAssignee,
  onClose,
}: {
  projects: Project[];
  fields?: FieldDef[];
  defaultProject?: string | null;
  /** Kanban "+" on a column: the task starts in that column (while the project is unchanged). */
  defaultColumn?: string | null;
  /** "+" on a list group (grouped by status): the task starts with that status. */
  defaultStatus?: string | null;
  /** "+" on a list group grouped by person: the task starts assigned to them (null: nobody). */
  defaultAssignee?: string | null;
  onClose: () => void;
}) {
  const tx = useT();
  const router = useRouter();
  const dir = useDirectory();
  const toast = useToast();
  // An unfinished draft comes back when the window opens again for the same place (kept until created or discarded).
  const draftKey = `${DRAFT_KEY}:${defaultProject ?? "me"}`;
  const [draft] = useState<Draft | null>(() => {
    try {
      const d = JSON.parse(localStorage.getItem(draftKey) ?? "null") as Draft | null;
      return d && (d.title || d.description || d.subtasks?.some(Boolean)) ? d : null;
    } catch {
      return null;
    }
  });
  const [title, setTitle] = useState(draft?.title ?? "");
  const [description, setDescription] = useState(draft?.description ?? "");
  const [projectId, setProjectId] = useState<string | null>(draft ? draft.projectId : defaultProject);
  const [assigneeId, setAssigneeId] = useState<string | null>(draft ? draft.assigneeId : defaultAssignee === undefined ? dir.me : defaultAssignee);
  const [priority, setPriority] = useState(draft?.priority ?? "medium");
  const [due, setDue] = useState(draft?.due ?? "");
  const [repeat, setRepeat] = useState(draft?.repeat ?? "");
  const [labels, setLabels] = useState<string[]>(draft?.labels ?? []);
  const [custom, setCustom] = useState<Record<string, unknown>>({});
  const [more, setMore] = useState(false);
  const [expanded, setExpandedRaw] = useState(() => {
    try {
      return localStorage.getItem(EXPANDED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const setExpanded = (v: boolean) => {
    setExpandedRaw(v);
    try {
      localStorage.setItem(EXPANDED_KEY, v ? "1" : "0");
    } catch {
      /* private window: the choice lasts for this window only */
    }
  };
  const [start, setStart] = useState("");
  const [columnId, setColumnId] = useState<string | null>(defaultColumn);
  const [parentId, setParentId] = useState<string | null>(null);
  const [subtasks, setSubtasks] = useState<string[]>(draft?.subtasks ?? []);
  const dirty = !!(title.trim() || description.trim() || subtasks.some((x) => x.trim()));
  // The draft follows every keystroke; a private window simply keeps nothing.
  useEffect(() => {
    try {
      if (dirty) localStorage.setItem(draftKey, JSON.stringify({ title, description, projectId, assigneeId, priority, due, repeat, labels, subtasks } satisfies Draft));
      else localStorage.removeItem(draftKey);
    } catch {
      /* storage blocked: the draft lives as long as the window */
    }
  }, [dirty, draftKey, title, description, projectId, assigneeId, priority, due, repeat, labels, subtasks]);
  const clearDraft = () => {
    try {
      localStorage.removeItem(draftKey);
    } catch {
      /* nothing stored */
    }
  };
  // People already working in the chosen project come first in the assignee picker.
  const [projectPeople, setProjectPeople] = useState<string[]>([]);
  useEffect(() => {
    if (!projectId) {
      setProjectPeople([]);
      return;
    }
    let live = true;
    void api<{ columns: { tasks: { assigneeId?: string | null }[] }[] }>(`work/projects/${projectId}/board`)
      .then((r) => {
        if (!live) return;
        const count = new Map<string, number>();
        for (const t of r.columns.flatMap((c) => c.tasks)) if (t.assigneeId) count.set(t.assigneeId, (count.get(t.assigneeId) ?? 0) + 1);
        setProjectPeople([...count.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id));
      })
      .catch(() => live && setProjectPeople([]));
    return () => {
      live = false;
    };
  }, [projectId]);
  // Templates (task_templates): the workspace's and the chosen project's; listed when the picker opens.
  const [templates, setTemplates] = useState<TemplateDto[] | null>(null);
  useEffect(() => setTemplates(null), [projectId]);
  const loadTemplates = () => {
    if (templates) return;
    void api<TemplateDto[]>(`work/task-templates${projectId ? `?projectId=${projectId}` : ""}`)
      .then(setTemplates)
      .catch(() => setTemplates([]));
  };
  const applyTemplate = (id: string) => {
    const tp = templates?.find((x) => x.id === id)?.payload;
    if (!tp) return;
    setTitle(tp.title.slice(0, 300));
    setDescription(tp.description ?? "");
    setPriority(tp.priority ?? "medium");
    setLabels(tp.labels ?? []);
    if (tp.subtasks?.length) {
      setSubtasks(tp.subtasks);
      setExpanded(true);
    }
    if (tp.recurrence) setRepeat(tp.recurrence);
    requestAnimationFrame(() => titleRef.current?.focus());
  };
  // The project's columns and top-level tasks, for the column and parent pickers (expanded form only).
  const [board, setBoard] = useState<{ columns: { id: string; name: string; tasks: { id: string; code: string; title: string }[] }[] } | null>(null);
  useEffect(() => {
    if (!expanded || !projectId) {
      setBoard(null);
      return;
    }
    let live = true;
    void api<{ columns: { id: string; name: string; tasks: { id: string; code: string; title: string }[] }[] }>(`work/projects/${projectId}/board`)
      .then((r) => live && setBoard(r))
      .catch(() => live && setBoard(null));
    return () => {
      live = false;
    };
  }, [expanded, projectId]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const defs = fields.filter((f) => f.entity === "task");
  // A stable close for the focus trap (it re-runs whenever its callback changes).
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const close = useCallback(() => closeRef.current(), []);
  const { confirm, dialog: confirmDialog } = useConfirm();
  const confirming = useRef(false);
  // Esc that only closes an open picker or menu inside the window must not close the window (and lose the draft):
  // seen in the capture phase, before the popover handles it and its trigger stops being expanded.
  const popoverEsc = useRef(false);
  const ref = useDialog<HTMLDivElement>(() => {
    if (popoverEsc.current || confirming.current) {
      popoverEsc.current = false;
      return;
    }
    void requestClose();
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const open = [...document.querySelectorAll<HTMLElement>('[role="listbox"],[role="menu"]')].some((el) => el.offsetParent !== null);
      popoverEsc.current = !!ref.current?.querySelector('[aria-expanded="true"]') || open;
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [ref]);
  /** Esc and the scrim ask before throwing away what was typed; × keeps the draft for next time. */
  const requestClose = async () => {
    if (!dirtyRef.current) return close();
    confirming.current = true;
    const discard = await confirm({ title: tx("taskActions.discardTitle"), body: tx("taskActions.discardBody"), confirmLabel: tx("taskActions.discard"), danger: true });
    confirming.current = false;
    if (discard) {
      clearDraft();
      close();
    }
  };
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const descRef = useRef<HTMLTextAreaElement>(null);
  // The title gets focus, not the first control (the project picker): the window mounts through a Portal a frame later,
  // and the dialog's own focus-first runs then too, so this waits for both.
  useEffect(() => {
    let frame = 0;
    let tries = 0;
    const focus = () => {
      const el = titleRef.current;
      if (el && tries > 0) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      } else if (tries++ < 10) frame = requestAnimationFrame(focus);
    };
    frame = requestAnimationFrame(focus);
    return () => cancelAnimationFrame(frame);
  }, []);
  // ⌘/Ctrl+Enter creates from anywhere in the window, even after a picker closed and focus went back to the page.
  const submitRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void submitRef.current();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const submit = async () => {
    if (!title.trim()) {
      setError(tx("work.newtaskdrawer.dat_tieu_de_cho"));
      titleRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const t = await api<{ id: string; code: string }>("work/tasks", {
        method: "POST",
        body: {
          title,
          description,
          projectId,
          assigneeId,
          priority,
          labels,
          customFields: custom,
          dueAt: due ? new Date(due).toISOString() : null,
          recurrence: due && repeat ? repeat : null,
          columnId: projectId && columnId && (expanded || projectId === defaultProject) ? columnId : null,
          startAt: expanded && start ? at(start, 9 * 60).toISOString() : null,
          parentId: expanded ? parentId : null,
          ...(defaultStatus && defaultStatus !== "cancelled" && !(projectId && columnId) ? { status: defaultStatus } : {}),
        },
      });
      clearDraft();
      // Subtasks go in after their parent, in the order typed; one that fails does not undo the task.
      const subs = expanded ? subtasks.map((x) => x.trim()).filter(Boolean) : [];
      for (const sub of subs)
        await api("work/tasks", { method: "POST", body: { title: sub, projectId, assigneeId, parentId: t.id } }).catch(() =>
          toast({ message: tx("work.newtask.subFailed", { title: sub }) }),
        );
      if (more) {
        // Keep the window and its properties; clear what is specific to one task.
        toast({ message: tx("work.newtaskdrawer.da_tao", { code: t.code }) });
        setTitle("");
        setDescription("");
        setSubtasks([]);
        setBusy(false);
        router.refresh();
        titleRef.current?.focus();
        return;
      }
      onClose();
      router.push(taskHref(t));
    } catch (e) {
      setError((e as { status?: number }).status === 403 ? tx("work.newtaskdrawer.ban_khong_co_quyen") : tx("work.newtaskdrawer.chua_tao_duoc_viec"));
      setBusy(false);
    }
  };
  submitRef.current = submit;
  const aiOn = useAiEnabled();
  const write = useTaskWrite({
    ai: aiOn,
    compact: true,
    title,
    description,
    projectId,
    labels,
    // Nothing is saved yet: a proposal fills the fields, and undo puts back what was typed.
    onApply: async (patch) => {
      const before = { title, description };
      if (patch.title !== undefined) setTitle(patch.title.slice(0, 300));
      if (patch.description !== undefined) setDescription(patch.description);
      toast({
        message: tx("work.taskwrite.applied"),
        undo: () => {
          if (patch.title !== undefined) setTitle(before.title);
          if (patch.description !== undefined) setDescription(before.description);
        },
      });
      return true;
    },
    onTemplate: () => {
      setDescription((d) => withTemplate(d, descriptionTemplate(tx)));
      requestAnimationFrame(() => descRef.current?.focus());
    },
  });
  const repeatOptions = [{ value: "", label: tx("work.newtaskdrawer.khong_lap_lai") }, ...Object.entries(REPEAT(tx)).map(([k, v]) => ({ value: k, label: v }))];

  const titleInput = (
    <textarea
      ref={titleRef}
      rows={1}
      aria-label={tx("work.newtaskdrawer.tieu_de")}
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? "new-task-error" : undefined}
      value={title}
      maxLength={300}
      onChange={(e) => {
        setTitle(e.target.value.replace(/\n/g, " "));
        if (error) setError(null);
      }}
      onKeyDown={(e) => {
        // Enter in the title creates (like a one-line field); Shift+Enter is not a new line either.
        if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
          e.preventDefault();
          void submit();
        }
      }}
      placeholder={tx("work.newtaskdrawer.ten_viec")}
      className="placeholder:text-ink-2 text-ink field-sizing-content min-h-9 w-full resize-none bg-transparent text-xl/8 font-semibold tracking-tight outline-none"
    />
  );
  // Markdown like the task page: the expanded form shows the formatting toolbar; shortcuts (⌘B, lists…) work in both.
  const descInput = (
    <>
      {expanded ? <MarkdownToolbar target={descRef} value={description} onChange={setDescription} className="-mx-2 rounded-md" /> : null}
      <textarea
        ref={descRef}
        aria-label={tx("work.newtaskdrawer.mo_ta")}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) return;
          if (continueListOnEnter(e, description, setDescription)) return;
          markdownShortcut(e, description, setDescription);
        }}
        placeholder={tx("work.newtaskdrawer.them_mo_ta")}
        rows={3}
        className="placeholder:text-ink-2 text-ink field-sizing-content min-h-20 w-full resize-none bg-transparent text-sm/6 outline-none"
      />
    </>
  );
  const errorNote = error ? (
    <p id="new-task-error" role="alert" className="text-block m-0 text-sm">
      {error}
    </p>
  ) : null;

  return (
    <Portal>
      <m.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.15 }}
        className={cx("fixed inset-0 z-50 grid items-start justify-items-center overflow-y-auto bg-black/50 p-4 max-sm:p-0 max-sm:pt-0", expanded ? "pt-[5vh]" : "pt-[12vh]")}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) void requestClose();
        }}
      >
        <m.div
          ref={ref}
          initial={{ opacity: 0, y: 8, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.16, ease: [0.2, 0.7, 0.2, 1] }}
          role="dialog"
          aria-modal="true"
          aria-label={tx("work.newtaskdrawer.viec_moi")}
          className={cx(
            "bg-surface shadow-float border-hairline flex w-full flex-col rounded-xl border max-sm:min-h-dvh max-sm:rounded-none max-sm:border-0",
            expanded ? "max-w-[1040px] md:h-[min(780px,calc(100dvh-10vh))]" : "max-w-[640px]",
          )}
        >
          <form
            className="flex flex-1 flex-col"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            {/* Breadcrumb: where the task will live (the project, or my own to-dos). */}
            <header className="flex items-center gap-1.5 px-4 pt-3">
              <Picker
                variant="button"
                label={tx("work.newtaskdrawer.du_an")}
                value={projectId ?? ""}
                onChange={(v) => {
                  setProjectId(v || null);
                  // Columns and parents belong to a project: a new project starts from its own.
                  setColumnId(null);
                  setParentId(null);
                }}
                // An outlined pill, not ghost text: the project a new task lands in must be easy to see and change.
                className="min-w-0 [&>button]:h-7 [&>button]:px-2.5 [&>button]:text-xs"
                options={[
                  { value: "", label: tx("work.newtaskdrawer.viec_ca_nhan") },
                  ...projects.map((p) => ({ value: p.id, label: p.name, icon: <ProjectBadge id={p.id} name={p.name} size="sm" /> })),
                ]}
              />
              <ChevronRightIcon className="text-ink-2/60 size-3.5 shrink-0" aria-hidden="true" />
              <span className="text-ink shrink-0 whitespace-nowrap text-xs font-medium">{tx("work.newtaskdrawer.viec_moi")}</span>
              <span className="ml-auto" />
              <Picker
                variant="button"
                label={tx("taskActions.templates")}
                value=""
                placeholder={tx("taskActions.templates")}
                onOpen={loadTemplates}
                onChange={applyTemplate}
                className="max-sm:hidden [&>button]:h-7 [&>button]:px-2.5 [&>button]:text-xs"
                options={
                  templates === null
                    ? [{ value: "__loading", label: tx("taskActions.loading") }]
                    : templates.length
                      ? templates.map((x) => ({ value: x.id, label: x.name, keywords: x.payload.title }))
                      : [{ value: "__none", label: tx("taskActions.noTemplates") }]
                }
              />
              {write.menu}
              <button
                type="button"
                onClick={() => setExpanded(!expanded)}
                aria-pressed={expanded}
                aria-label={tx(expanded ? "work.newtask.collapse" : "work.newtask.expand")}
                title={tx(expanded ? "work.newtask.collapse" : "work.newtask.expand")}
                className="text-ink-2 hover:bg-hover hover:text-ink grid size-8 place-items-center rounded-md"
              >
                {expanded ? <CollapseIcon /> : <ExpandIcon />}
              </button>
              <button
                type="button"
                onClick={onClose}
                aria-label={tx("work.newtaskdrawer.huy")}
                className="text-ink-2 hover:bg-hover hover:text-ink grid size-8 place-items-center rounded-md"
              >
                <CloseIcon />
              </button>
            </header>

            {expanded ? (
              <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto md:grid-cols-[minmax(0,1fr)_320px] md:overflow-hidden">
                <div className="grid min-h-0 content-start gap-1 px-5 pb-4 pt-2 md:overflow-y-auto [&_textarea:nth-of-type(2)]:min-h-48">
                  {titleInput}
                  {descInput}
                  {write.panel}
                  {errorNote}
                  <section aria-labelledby="new-subtasks-h" className="border-divider mt-3 grid gap-1.5 border-t pt-4">
                    <h3 id="new-subtasks-h" className="text-ink-2 m-0 text-xs font-semibold">
                      {tx("work.newtask.subtasks")}
                    </h3>
                    {subtasks.map((sub, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <span className="border-ink-2/40 size-3.5 shrink-0 rounded-full border" aria-hidden="true" />
                        <input
                          className="placeholder:text-ink-2 min-w-0 flex-1 bg-transparent py-1 text-sm outline-none"
                          aria-label={tx("work.newtask.subtaskN", { n: i + 1 })}
                          value={sub}
                          autoFocus={i === subtasks.length - 1 && sub === ""}
                          maxLength={300}
                          placeholder={tx("work.newtask.subtaskPh")}
                          onChange={(e) => setSubtasks((l) => l.map((x, j) => (j === i ? e.target.value : x)))}
                          onKeyDown={(e) => {
                            // Enter adds the next line (as in a checklist); Backspace on an empty line removes it.
                            if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
                              e.preventDefault();
                              setSubtasks((l) => [...l.slice(0, i + 1), "", ...l.slice(i + 1)]);
                            } else if (e.key === "Backspace" && sub === "") {
                              e.preventDefault();
                              setSubtasks((l) => l.filter((_, j) => j !== i));
                            }
                          }}
                        />
                        <button
                          type="button"
                          className="text-ink-2 hover:bg-hover hover:text-ink grid size-7 place-items-center rounded-md"
                          aria-label={tx("work.newtask.removeSubtask")}
                          onClick={() => setSubtasks((l) => l.filter((_, j) => j !== i))}
                        >
                          <CloseIcon className="size-3.5" />
                        </button>
                      </div>
                    ))}
                    <button type="button" className={cx(btnGhost, btnSm, "text-ink-2 -ml-1.5 w-fit gap-1.5 px-1.5")} onClick={() => setSubtasks((l) => [...l, ""])}>
                      <PlusIcon className="size-4" />
                      {tx("work.newtask.addSubtask")}
                    </button>
                  </section>
                </div>

                {/* Every property, labelled, like the task page's panel. */}
                <aside aria-label={tx("work.newtask.properties")} className="border-divider bg-ground/40 min-h-0 border-t px-4 py-4 md:overflow-y-auto md:border-l md:border-t-0">
                  <PropertyList label={tx("work.newtask.properties")}>
                    {projectId && board?.columns.length ? (
                      <PropertyRow label={tx("work.newtask.column")}>
                        <Picker
                          align="right"
                          label={tx("work.newtask.column")}
                          value={columnId ?? board.columns[0]!.id}
                          onChange={setColumnId}
                          options={board.columns.map((c) => ({ value: c.id, label: c.name }))}
                        />
                      </PropertyRow>
                    ) : null}
                    <PropertyRow label={tx("work.newtaskdrawer.nguoi_lam")}>
                      <AssigneeSelect variant="property" label={tx("work.newtaskdrawer.nguoi_lam")} value={assigneeId} onChange={setAssigneeId} suggested={projectPeople} />
                    </PropertyRow>
                    <PropertyRow label={tx("work.newtaskdrawer.uu_tien")}>
                      <PrioritySelect variant="property" label={tx("work.newtaskdrawer.uu_tien")} value={priority} onChange={setPriority} />
                    </PropertyRow>
                    <PropertyRow label={tx("work.deps.start")}>
                      <DateField variant="property" label={tx("work.deps.start")} placeholder="—" value={start} onChange={setStart} />
                    </PropertyRow>
                    <PropertyRow label={tx("work.newtaskdrawer.han_chot")}>
                      <DateField variant="property" withTime label={tx("work.newtaskdrawer.han_chot")} placeholder="—" value={due} onChange={setDue} />
                    </PropertyRow>
                    <PropertyRow label={tx("work.newtaskdrawer.lap_lai")}>
                      <Picker align="right" label={tx("work.newtaskdrawer.lap_lai")} value={repeat} onChange={setRepeat} options={repeatOptions} disabled={!due} />
                    </PropertyRow>
                    {projectId && board ? (
                      <PropertyRow label={tx("work.newtask.parent")}>
                        <Picker
                          align="right"
                          label={tx("work.newtask.parent")}
                          value={parentId ?? ""}
                          onChange={(v) => setParentId(v || null)}
                          options={[
                            { value: "", label: tx("work.newtask.noParent") },
                            ...board.columns.flatMap((c) => c.tasks).map((x) => ({ value: x.id, label: `${x.code} · ${x.title}` })),
                          ]}
                        />
                      </PropertyRow>
                    ) : null}
                  </PropertyList>
                  <div className="mt-3 grid gap-3">
                    <LabelsInput value={labels} onChange={setLabels} ghost />
                    {defs.length ? <CustomFieldInputs defs={defs} value={custom} onChange={setCustom} ghost /> : null}
                  </div>
                </aside>
              </div>
            ) : (
              <>
                <div className="grid gap-1 px-5 pb-3 pt-2">
                  {titleInput}
                  {descInput}
                  {write.panel}
                  {errorNote}
                </div>

                {/* Properties as chips: each opens its own picker. */}
                <div className="flex flex-wrap items-center gap-1.5 px-4 pb-3" role="group" aria-label={tx("work.newtaskdrawer.viec_moi")}>
                  <span className={chip}>
                    <AssigneeSelect variant="button" label={tx("work.newtaskdrawer.nguoi_lam")} value={assigneeId} onChange={setAssigneeId} suggested={projectPeople} />
                  </span>
                  <span className={chip}>
                    <PrioritySelect variant="button" label={tx("work.newtaskdrawer.uu_tien")} value={priority} onChange={setPriority} />
                  </span>
                  <span className={chip}>
                    <DateField variant="button" withTime label={tx("work.newtaskdrawer.han_chot")} placeholder={tx("work.newtaskdrawer.khong_han")} value={due} onChange={setDue} />
                  </span>
                  {due ? (
                    <span className={chip}>
                      <Picker variant="button" label={tx("work.newtaskdrawer.lap_lai")} value={repeat} onChange={setRepeat} options={repeatOptions} />
                    </span>
                  ) : null}
                  <div className="min-w-40 flex-1">
                    <LabelsInput value={labels} onChange={setLabels} ghost />
                  </div>
                </div>
                {defs.length ? (
                  <div className="border-hairline grid gap-3 border-t px-5 py-3">
                    <CustomFieldInputs defs={defs} value={custom} onChange={setCustom} ghost />
                  </div>
                ) : null}
              </>
            )}

            <footer className="border-hairline mt-auto flex items-center gap-3 border-t px-4 py-3">
              {draft ? (
                <span className="text-ink-2 flex min-w-0 items-center gap-2 text-xs">
                  <span className="truncate">{tx("taskActions.draftRestored")}</span>
                  <button
                    type="button"
                    className="text-ink-2 hover:text-ink underline underline-offset-2"
                    onClick={() => {
                      clearDraft();
                      setTitle("");
                      setDescription("");
                      setSubtasks([]);
                      setLabels([]);
                      titleRef.current?.focus();
                    }}
                  >
                    {tx("taskActions.discard")}
                  </button>
                </span>
              ) : null}
              <span className="ml-auto flex items-center gap-3">
                <Checkbox label={tx("work.newtaskdrawer.tao_them")} checked={more} onChange={(e) => setMore(e.target.checked)} className="text-ink-2 text-xs" />
                <button type="submit" className={cx(btnPrimary, "gap-2")} disabled={busy}>
                  {busy ? tx("work.newtaskdrawer.dang_tao") : tx("work.newtaskdrawer.tao_viec")}
                  <kbd className="text-on-brand/60 font-sans text-xs max-sm:hidden" aria-hidden="true">
                    ⌘↵
                  </kbd>
                </button>
              </span>
            </footer>
          </form>
        </m.div>
      </m.div>
      {confirmDialog}
    </Portal>
  );
}

const EXPANDED_KEY = "wx.newTask.expanded";
const DRAFT_KEY = "wx.newTask.draft";

interface Draft {
  title: string;
  description: string;
  projectId: string | null;
  assigneeId: string | null;
  priority: string;
  due: string;
  repeat: string;
  labels: string[];
  subtasks: string[];
}
interface TemplateDto {
  id: string;
  name: string;
  projectId: string | null;
  payload: { title: string; description: string; priority: string; labels: string[]; subtasks: string[]; recurrence?: string | null };
}

/** Property chips share the toolbar button's look, a size smaller. */
const chip = "[&>div>button]:h-8 [&>div>button]:rounded-sm [&>div>button]:px-3 [&>div>button]:text-xs";
