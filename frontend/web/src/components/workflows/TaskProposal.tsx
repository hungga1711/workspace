"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { useFormat, useT } from "@/lib/i18n/client";
import { dueOn, splitDue } from "@/components/work/taskChatText";
import { useDirectory } from "@/lib/people";
import { taskHref } from "@/lib/links";
import { btn, btnPrimary, btnSm, cx, input, textarea } from "@/lib/ui";
import { Picker } from "@/components/ui/Picker";
import { AssigneeSelect } from "@/components/work/TaskFields";
import { CheckIcon, PlayIcon, SparkleIcon } from "@/components/app/icons";
import { CATEGORY } from "./bits";
import type { Category, Runner } from "./types";

interface Proposal {
  title: string;
  description: string;
  workflowId: string | null;
  projectId: string | null;
  workflows: { id: string; name: string; category: Category; runner: Runner }[];
  projects: { id: string; name: string }[];
  /** Who and when, when the request said so (the AI's reading of it). */
  assigneeId?: string | null;
  dueDate?: string | null;
}

/**
 * The AI's proposed task from a chat request, editable before anything exists: title, what "done" means, project,
 * who does it and the agent workflow. "Tạo việc" creates it; "Tạo và chạy" also starts the workflow (a workflow that
 * runs on someone's computer can only be started by that person, so it needs the task assigned to me).
 */
export function TaskProposal({ text, source, onDone }: { text: string; source?: Record<string, string>; onDone?: () => void }) {
  const t = useT();
  const dir = useDirectory();
  const [p, setP] = useState<Proposal | null>(null);
  const [failed, setFailed] = useState(false);
  const [assignee, setAssignee] = useState<string | null>(dir.me);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ id: string; code: string; ran: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // "… by Friday" in the proposed title becomes the due date (as the task's Ask AI subtasks do).
  const [dueAt, setDueAt] = useState<string | null>(null);
  const { longDate } = useFormat();
  useEffect(() => {
    let live = true;
    api<Proposal>("ai/tasks/propose", { method: "POST", body: { text } })
      .then((x) => {
        if (!live) return;
        const d = splitDue(x.title, new Date(), undefined, text);
        setDueAt((x.dueDate ? dueOn(x.dueDate) : null) ?? d.dueAt);
        if (x.assigneeId) setAssignee(x.assigneeId);
        setP({ ...x, title: d.title });
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [text]);

  if (failed)
    return (
      <div role="alert" className="bg-block-wash text-block rounded-xl px-4 py-3 text-sm">
        {t("workflows.propose.failed")}
      </div>
    );
  if (!p)
    return (
      <div className="border-hairline bg-surface flex items-center gap-2.5 rounded-xl border px-4 py-3 text-sm" aria-busy="true">
        <SparkleIcon className="text-accent-text size-4 animate-pulse" />
        <span className="text-ink-2">{t("workflows.propose.thinking")}</span>
      </div>
    );
  if (created)
    return (
      <div className="border-hairline bg-ok-wash text-ok flex flex-wrap items-center gap-2 rounded-xl border px-4 py-3 text-sm">
        <CheckIcon className="size-4" />
        <span className="flex-1">{t(created.ran ? "workflows.propose.createdRan" : "workflows.propose.created", { code: created.code })}</span>
        <Link href={taskHref(created)} className={cx(btn, btnSm, "no-underline")}>
          {t("workflows.propose.open")}
        </Link>
      </div>
    );

  const wf = p.workflows.find((w) => w.id === p.workflowId) ?? null;
  const canRun = !!wf && (wf.runner === "server" || assignee === dir.me);
  const create = async (run: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const task = await api<{ id: string; code: string }>("work/tasks", {
        method: "POST",
        body: {
          title: p.title.trim(),
          description: p.description,
          assigneeId: assignee,
          ...(dueAt ? { dueAt } : {}),
          ...(p.projectId ? { projectId: p.projectId } : {}),
          ...(source ? { source } : {}),
        },
      });
      if (p.workflowId) await api(`work/tasks/${task.id}/workflow`, { method: "PUT", body: { workflowId: p.workflowId } });
      if (run && p.workflowId) await api(`work/tasks/${task.id}/runs`, { method: "POST" });
      setCreated({ ...task, ran: run });
      onDone?.();
    } catch (e) {
      setError((e as { body?: { message?: string } }).body?.message ?? t("common.actionFailed"));
      setBusy(false);
    }
  };
  return (
    <section aria-label={t("workflows.propose.title")} className="border-accent/25 bg-surface shadow-soft grid gap-3 rounded-xl border p-4">
      <header className="flex items-center gap-2">
        <span className="bg-accent-wash text-accent-text grid size-7 place-items-center rounded-lg [&_svg]:size-4" aria-hidden="true">
          <SparkleIcon />
        </span>
        <h3 className="m-0 text-sm font-semibold">{t("workflows.propose.title")}</h3>
      </header>
      <input
        className={cx(input, "font-medium")}
        value={p.title}
        onChange={(e) => setP({ ...p, title: e.target.value })}
        aria-label={t("workflows.propose.taskTitle")}
        maxLength={200}
      />
      {dueAt ? (
        <p className="text-ink-2 -mt-1 flex items-center gap-2 text-xs">
          <span>{t("workflows.propose.due", { date: longDate(dueAt) })}</span>
          <button type="button" className="text-ink hover:text-signal font-medium underline-offset-2 hover:underline" onClick={() => setDueAt(null)}>
            {t("workflows.propose.noDue")}
          </button>
        </p>
      ) : null}
      <textarea
        className={cx(textarea, "min-h-28 text-[13px]")}
        value={p.description}
        onChange={(e) => setP({ ...p, description: e.target.value })}
        aria-label={t("workflows.propose.description")}
      />
      <div className="grid gap-2 sm:grid-cols-3">
        <AssigneeSelect variant="field" label={t("workflows.propose.assignee")} value={assignee} onChange={setAssignee} />
        <Picker
          variant="field"
          label={t("workflows.propose.project")}
          value={p.projectId ?? ""}
          onChange={(v) => setP({ ...p, projectId: v || null })}
          options={[{ value: "", label: t("workflows.propose.noProject") }, ...p.projects.map((x) => ({ value: x.id, label: x.name }))]}
        />
        <Picker
          variant="field"
          label={t("workflows.agent.pick")}
          value={p.workflowId ?? ""}
          onChange={(v) => setP({ ...p, workflowId: v || null })}
          options={[
            { value: "", label: t("workflows.agent.none") },
            ...p.workflows.map((w) => ({ value: w.id, label: w.name, icon: <span className="text-ink-2 [&_svg]:size-4">{CATEGORY[w.category]?.icon}</span> })),
          ]}
        />
      </div>
      {wf && !canRun ? <p className="text-ink-2 m-0 text-xs">{t("workflows.agent.assigneeOnly")}</p> : null}
      {error ? (
        <p role="alert" className="text-block m-0 text-sm">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className={btn} disabled={busy || !p.title.trim()} onClick={() => void create(false)}>
          {t("workflows.propose.create")}
        </button>
        {wf ? (
          <button type="button" className={btnPrimary} disabled={busy || !p.title.trim() || !canRun} onClick={() => void create(true)}>
            <PlayIcon className="size-3.5" />
            {t("workflows.propose.createRun")}
          </button>
        ) : null}
      </div>
    </section>
  );
}
