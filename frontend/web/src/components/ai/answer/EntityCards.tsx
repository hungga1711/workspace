"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { CheckCircleIcon, DownloadIcon, FileIcon, VideoIcon } from "@/components/app/icons";
import { DateField } from "@/components/ui/DateField";
import { Picker } from "@/components/ui/Picker";
import { fromZonedInput, zonedInput } from "@/components/work/calTime";
import { statusTone } from "@/components/work/TaskStatusPill";
import type { Task } from "@/components/work/types";
import { api } from "@/lib/client";
import { STATUS_KEYS } from "@/lib/format";
import { useFormat } from "@/lib/i18n/client";
import { Avatar, useDirectory } from "@/lib/people";
import { cx, mono, skeleton } from "@/lib/ui";
import type { Source } from "../mention-types";

/**
 * The tasks, people, pages and meetings an answer names, as small cards. A task card reads the task
 * itself (as the person: what they may not open falls back to a plain link) and changes its status, assignee or due
 * date in place through the same API as the task page, so the same permissions and version checks apply. No AI call.
 */
export function EntityCards({ items }: { items: Source[] }) {
  if (!items.length) return null;
  return (
    <ul className="m-0 mt-3 grid min-w-0 list-none grid-cols-1 gap-2 p-0 sm:grid-cols-2" data-testid="answer-cards">
      {items.map((x) => (
        <li key={`${x.type}:${x.id}`} className="min-w-0">
          {x.type === "task" ? <TaskCard source={x} /> : x.type === "employee" ? <PersonCard source={x} /> : x.type === "file" ? <FileCard source={x} /> : <ItemCard source={x} />}
        </li>
      ))}
    </ul>
  );
}

const card = "border-hairline bg-surface flex min-w-0 items-center gap-2.5 rounded-xl border px-3 py-2";
const inApp = (url: string) => (url.startsWith("/") ? url : "#");

function ItemCard({ source }: { source: Source }) {
  return (
    <Link href={inApp(source.url)} className={cx(card, "hover:bg-hover text-ink no-underline")}>
      <span className="text-ink-2 shrink-0 [&_svg]:size-4" aria-hidden="true">
        {source.type === "meeting" ? <VideoIcon /> : <FileIcon />}
      </span>
      <span className="min-w-0 truncate text-[13px]">{source.title}</span>
    </Link>
  );
}

/** A file (one the answer made, or one it read): its kind, its name and a download, a plain link (the address redirects to storage). */
function FileCard({ source }: { source: Source }) {
  const { t } = useFormat();
  const ext = /\.([a-z0-9]{2,5})$/i.exec(source.title)?.[1]?.toUpperCase() ?? "";
  const href = source.url.startsWith("/app/files/") ? source.url : null;
  const body = (
    <>
      <span
        className="bg-accent-wash text-accent-text grid h-8 min-w-8 shrink-0 place-items-center rounded-md px-1 font-mono text-[10px] font-semibold"
        aria-label={ext ? t("aiw.answer.fileKind", { kind: ext }) : undefined}
      >
        {ext || <FileIcon />}
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px]">{source.title}</span>
      {href ? (
        <span className="text-ink-2 inline-flex shrink-0 items-center gap-1 text-xs [&_svg]:size-3.5">
          <DownloadIcon />
          <span className="max-sm:sr-only">{t("aiw.answer.download")}</span>
        </span>
      ) : null}
    </>
  );
  return href ? (
    <a href={href} download className={cx(card, "hover:bg-hover text-ink no-underline")} data-testid="answer-file">
      {body}
    </a>
  ) : (
    <span className={card}>{body}</span>
  );
}

function PersonCard({ source }: { source: Source }) {
  const { name } = useDirectory();
  const shown = name(source.id) || source.title;
  return (
    <Link href={inApp(source.url)} className={cx(card, "hover:bg-hover text-ink no-underline")}>
      <Avatar id={source.id} name={shown} size="sm" />
      <span className="min-w-0 truncate text-[13px]">{shown}</span>
    </Link>
  );
}

function TaskCard({ source }: { source: Source }) {
  const fmt = useFormat();
  const { t } = fmt;
  const dir = useDirectory();
  const [task, setTask] = useState<Task | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "plain">("loading");
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let live = true;
    api<{ task: Task }>(`work/tasks/${encodeURIComponent(source.id)}`)
      .then((r) => {
        if (!live) return;
        setTask(r.task);
        setState(r.task ? "ready" : "plain");
      })
      // Gone, or not the person's to open: the card stays a link with the answer's title.
      .catch(() => live && setState("plain"));
    return () => {
      live = false;
    };
  }, [source.id]);

  const save = async (patch: Partial<Pick<Task, "status" | "assigneeId" | "dueAt">>) => {
    if (!task || saving) return;
    setSaving(true);
    setProblem(null);
    try {
      setTask(await api<Task>(`work/tasks/${task.id}`, { method: "PATCH", body: { expectedVersion: task.version, ...patch } }));
    } catch (e) {
      const status = (e as { status?: number }).status;
      // Changed meanwhile: show what it is now; refused: say so, the card keeps its values.
      if (status === 409)
        await api<{ task: Task }>(`work/tasks/${task.id}`)
          .then((r) => setTask(r.task))
          .catch(() => undefined);
      setProblem(status === 409 ? t("aiw.answer.changedMeanwhile") : status === 403 ? t("aiw.answer.notAllowed") : t("aiw.answer.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const head = (code: string, title: string) => (
    <Link href={inApp(source.url)} className="text-ink flex min-w-0 items-center gap-1.5 text-[13px] no-underline hover:underline">
      <span className="text-ink-2 shrink-0 [&_svg]:size-4" aria-hidden="true">
        <CheckCircleIcon />
      </span>
      {code ? <span className={cx(mono, "text-ink-2 shrink-0 text-xs")}>{code}</span> : null}
      <span className="min-w-0 truncate font-medium">{title}</span>
    </Link>
  );

  if (state !== "ready" || !task)
    return (
      <div className={cx(card, "flex-col items-stretch gap-1")}>
        {head("", source.title)}
        {state === "loading" ? <span className={cx(skeleton, "h-5 w-3/5")} aria-hidden="true" /> : null}
      </div>
    );

  const due = fmt.dueLabel(task.dueAt);
  const closed = task.status === "done" || task.status === "cancelled";
  return (
    <div className={cx(card, "flex-col items-stretch gap-1.5")} aria-busy={saving || undefined}>
      {head(task.code, task.title)}
      <div className="-ml-1.5 flex min-w-0 flex-wrap items-center gap-1">
        <Picker
          variant="property"
          label={t("aiw.answer.status")}
          value={task.status}
          disabled={saving}
          onChange={(v) => v !== task.status && void save({ status: v })}
          options={STATUS_KEYS.map((k) => ({ value: k, label: fmt.status(k) }))}
          triggerClassName={cx("flex h-6 items-center gap-1 rounded-md px-1.5 text-xs font-medium", statusTone(task.status))}
          className="w-auto"
        />
        <Picker
          variant="property"
          label={t("aiw.answer.assignee")}
          value={task.assigneeId ?? ""}
          disabled={saving}
          placeholder={t("aiw.answer.unassigned")}
          onChange={(v) => (v || null) !== task.assigneeId && void save({ assigneeId: v || null })}
          options={[
            { value: "", label: t("aiw.answer.unassigned") },
            ...dir.people.map((p) => ({ value: p.userId, label: p.displayName, ...(p.email ? { keywords: p.email } : {}) })),
          ]}
          triggerClassName="text-ink-soft hover:bg-hover flex h-6 max-w-full items-center gap-1 rounded-md px-1.5 text-xs"
          className="w-auto min-w-0 max-w-[11rem]"
        />
        <DateField
          variant="property"
          withTime
          label={t("aiw.answer.due")}
          placeholder={t("aiw.answer.noDue")}
          value={task.dueAt ? zonedInput(task.dueAt) : ""}
          display={due?.text}
          disabled={saving}
          onChange={(v) => void save({ dueAt: v ? fromZonedInput(v).toISOString() : null })}
          className={cx("w-auto shrink-0", due?.overdue && !closed && "[&>button]:text-block [&>button]:font-medium")}
          triggerClassName="!mx-0 h-6 min-h-6 px-1.5 text-xs"
        />
      </div>
      {problem ? (
        <p className="text-block m-0 text-xs" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
