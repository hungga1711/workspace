"use client";

import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/client";
import { useT } from "@/lib/i18n/client";
import { cx } from "@/lib/ui";
import { Picker } from "./TaskFields";
import { CloseIcon } from "@/components/app/icons";
import { taskHref } from "@/lib/links";

export interface DepRow {
  linkId: string;
  id: string;
  code: string;
  title: string;
  status: string;
}

/**
 * Gantt links on the task page: what this task waits on (must finish first) and what waits on it.
 * Add from the project's tasks; a link that would make a loop is refused by the server.
 */
export function TaskDependencies({ taskId, projectId, initial }: { taskId: string; projectId: string; initial: { waitingOn: DepRow[]; blocking: DepRow[] } }) {
  const t = useT();
  const [waitingOn, setWaitingOn] = useState(initial.waitingOn);
  const [blocking, setBlocking] = useState(initial.blocking);
  const [options, setOptions] = useState<{ id: string; code: string; title: string }[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = async () => {
    if (options) return;
    const r = await api<{ tasks: { id: string; code: string; title: string; parentId: string | null }[] }>(`work/tasks?projectId=${projectId}`).catch(() => ({ tasks: [] }));
    setOptions(r.tasks.filter((x) => x.id !== taskId && !x.parentId));
  };
  const add = async (predecessorId: string) => {
    if (!predecessorId) return;
    setMsg(null);
    try {
      const d = await api<{ id: string }>(`work/tasks/${taskId}/dependencies`, { method: "POST", body: { predecessorId } });
      const o = options?.find((x) => x.id === predecessorId);
      if (o && !waitingOn.some((w) => w.id === o.id)) setWaitingOn((cur) => [...cur, { linkId: d.id, id: o.id, code: o.code, title: o.title, status: "todo" }]);
    } catch (e) {
      setMsg((e as { body?: { error?: string } }).body?.error === "cycle" ? t("work.gantt.cycle") : t("work.gantt.saveFailed"));
    }
  };
  const remove = async (row: DepRow, list: "waitingOn" | "blocking") => {
    await api(`work/task-dependencies/${row.linkId}`, { method: "DELETE" }).catch(() => undefined);
    if (list === "waitingOn") setWaitingOn((cur) => cur.filter((x) => x.linkId !== row.linkId));
    else setBlocking((cur) => cur.filter((x) => x.linkId !== row.linkId));
  };
  const rows = (list: DepRow[], kind: "waitingOn" | "blocking") =>
    list.map((r) => (
      <li key={r.linkId} className="group flex items-center gap-2 text-sm">
        <Link href={taskHref(r)} className={cx("text-ink min-w-0 flex-1 truncate no-underline hover:underline", r.status === "done" && "text-ink-2 line-through")}>
          {r.title}
        </Link>
        <span className="text-ink-2 text-xs tabular-nums">{r.code}</span>
        <button
          type="button"
          className="text-ink-2 hover:text-ink grid size-6 place-items-center opacity-60 group-hover:opacity-100"
          aria-label={t("work.deps.remove", { code: r.code })}
          onClick={() => void remove(r, kind)}
        >
          <CloseIcon className="size-3.5" />
        </button>
      </li>
    ));
  return (
    <section className="grid gap-2" aria-label={t("work.deps.title")}>
      <p className="text-ink-2 m-0 text-xs font-medium">{t("work.deps.waitingOn")}</p>
      {waitingOn.length ? <ul className="m-0 grid list-none gap-1 p-0">{rows(waitingOn, "waitingOn")}</ul> : null}
      <Picker
        align="right"
        label={t("work.deps.add")}
        value=""
        placeholder={t("work.deps.add")}
        onOpen={() => void load()}
        onChange={(v) => void add(v)}
        options={(options ?? []).filter((o) => !waitingOn.some((w) => w.id === o.id)).map((o) => ({ value: o.id, label: `${o.code} · ${o.title}` }))}
      />
      {blocking.length ? (
        <>
          <p className="text-ink-2 m-0 mt-2 text-xs font-medium">{t("work.deps.blocking")}</p>
          <ul className="m-0 grid list-none gap-1 p-0">{rows(blocking, "blocking")}</ul>
        </>
      ) : null}
      {msg ? (
        <p className="text-block m-0 text-xs" role="alert">
          {msg}
        </p>
      ) : null}
    </section>
  );
}
