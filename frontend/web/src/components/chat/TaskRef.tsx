"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useFormat } from "@/lib/i18n/client";
import { Avatar } from "@/lib/people";
import { lookupTask, type TaskBrief } from "@/lib/task-refs";

/**
 * A task code in a message ("T-041") as a compact chip: status, code, title, assignee. It opens the task over the
 * conversation (the peek). A code the reader cannot see, or that does not exist, stays plain text: the chip never
 * reveals a title someone could not open.
 */
export function TaskRef({ code }: { code: string }) {
  const { status } = useFormat();
  const [task, setTask] = useState<TaskBrief | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void lookupTask(code).then((t) => live && setTask(t));
    return () => {
      live = false;
    };
  }, [code]);

  if (task === null) return <>{code}</>;
  const label = task ? `${task.code} · ${task.title}` : code;
  return (
    <Link
      href={`/app/work/tasks/${encodeURIComponent(task?.code ?? code)}`}
      title={task ? `${label} · ${status(task.status) ?? task.status}` : code}
      className="border-hairline bg-surface hover:bg-hover hover:border-ink/20 mx-0.5 inline-flex max-w-[min(100%,26rem)] items-center gap-1.5 rounded-md border px-1.5 py-px align-[-3px] text-[13px]/5 no-underline transition-colors"
    >
      <span className="text-ink-2 shrink-0 font-mono text-xs">{task?.code ?? code}</span>
      {task ? <span className="text-ink min-w-0 truncate font-medium">{task.title}</span> : null}
      {task?.assigneeId ? <Avatar id={task.assigneeId} size="xs" className="shrink-0" /> : null}
    </Link>
  );
}
