"use client";

import { useFormat, useT } from "@/lib/i18n/client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/client";
import { detectSignals, rankByMessage } from "@/lib/signals";
import { cx } from "@/lib/ui";
import { CheckIcon, ClockIcon, LockIcon } from "@/components/app/icons";
import { Modal } from "@/components/ui/Modal";
import type { Task } from "@/components/work/types";

const chip = "inline-flex h-6 items-center gap-1 rounded-sm border border-ink/15 bg-brand-wash px-2 text-xs text-ink hover:bg-brand-wash/70";

/**
 * Suggested actions under a message that concerns the reader: a deadline becomes a task
 * with that due date, a decision goes to the decision log, a blocker is attached to one of my tasks.
 * Everything links back to the message.
 */
export function SignalChips({
  messageId,
  channelId,
  text,
  assigneeId,
  mine = false,
}: {
  messageId: string;
  channelId: string;
  text: string;
  assigneeId: string | null;
  /** The reader wrote the message: only then is "I finished X" offered as closing one of their tasks. */
  mine?: boolean;
}) {
  const t = useT();
  const { shortDate } = useFormat();
  const s = useMemo(() => detectSignals(text), [text]);
  const [done, setDone] = useState<Record<string, string>>({});
  const [blockerOpen, setBlockerOpen] = useState(false);
  const [doneOpen, setDoneOpen] = useState(false);
  const finished = mine && s.done;
  if (!s.deadline && !s.blocker && !finished) return null;
  const source = { type: "chat.message", messageId, channelId };
  const plain = text.replace(/<@[\w:-]+>\s*/g, "").trim();
  const title = plain.length > 120 ? `${plain.slice(0, 117)}…` : plain;
  const mkTask = async () => {
    const t = await api<{ id: string; code: string }>("work/tasks", { method: "POST", body: { title, dueAt: s.deadline!.iso, assigneeId, source } });
    setDone((d) => ({ ...d, task: `/app/work/tasks/${t.id}` }));
  };
  return (
    <div className="mt-1 flex flex-wrap gap-1.5" aria-label={t("chat.signals.region")}>
      {s.deadline ? (
        done.task ? (
          <Link href={done.task} className={cx(chip, "no-underline")}>
            <CheckIcon className="size-3" />
            {t("chat.signals.taskCreated")}
          </Link>
        ) : (
          <button type="button" className={chip} onClick={() => void mkTask()}>
            <ClockIcon className="size-3" />
            {t("chat.signals.createTask", {
              date: s.deadline.rel === 0 ? t("format.today").toLowerCase() : s.deadline.rel === 1 ? t("format.tomorrow").toLowerCase() : shortDate(s.deadline.iso),
            })}
          </button>
        )
      ) : null}
      {s.blocker ? (
        done.blocker ? (
          <span className={chip}>
            <CheckIcon className="size-3" />
            {done.blocker}
          </span>
        ) : (
          <button type="button" className={chip} onClick={() => setBlockerOpen(true)}>
            <LockIcon className="size-3" />
            {t("chat.signals.markBlocked")}
          </button>
        )
      ) : null}
      {finished ? (
        done.finished ? (
          <Link href={done.finished} className={cx(chip, "no-underline")}>
            <CheckIcon className="size-3" />
            {t("chat.signals.markedDone")}
          </Link>
        ) : (
          <button type="button" className={chip} onClick={() => setDoneOpen(true)}>
            <CheckIcon className="size-3" />
            {t("chat.signals.markDone")}
          </button>
        )
      ) : null}
      {doneOpen ? (
        <DoneModal
          message={plain}
          onClose={() => setDoneOpen(false)}
          onDone={(task) => {
            setDoneOpen(false);
            setDone((d) => ({ ...d, finished: `/app/work/tasks/${task}` }));
          }}
        />
      ) : null}
      {blockerOpen ? (
        <BlockerModal
          reason={plain.slice(0, 480)}
          onClose={() => setBlockerOpen(false)}
          onDone={(code) => {
            setBlockerOpen(false);
            setDone((d) => ({ ...d, blocker: t("chat.signals.isBlocked", { code }) }));
          }}
        />
      ) : null}
    </div>
  );
}

function BlockerModal({ reason, onClose, onDone }: { reason: string; onClose: () => void; onDone: (code: string) => void }) {
  const t = useT();
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void api<{ tasks: Task[] }>("work/tasks?scope=assigned")
      .then((r) => setTasks(r.tasks.filter((t) => !["done", "cancelled"].includes(t.status))))
      .catch(() => setTasks([]));
  }, []);
  const mark = async (task: Task) => {
    try {
      await api(`work/tasks/${task.id}`, { method: "PATCH", body: { expectedVersion: task.version, blockedReason: reason } });
      onDone(task.code);
    } catch {
      setError(t("chat.signals.blockFailed"));
    }
  };
  return (
    <Modal title={t("chat.signals.whichTask")} onClose={onClose}>
      <p className="text-ink-2 mb-3 text-sm">{t("chat.signals.reasonNote", { reason })}</p>
      {error ? (
        <p className="text-block mb-2 text-sm" role="alert">
          {error}
        </p>
      ) : null}
      {tasks === null ? (
        <p className="text-ink-2">{t("chat.signals.loadingTasks")}</p>
      ) : tasks.length === 0 ? (
        <p className="text-ink-2">{t("chat.signals.noOpenTasks")}</p>
      ) : (
        <ul className="m-0 grid max-h-80 list-none gap-1 overflow-auto p-0">
          {tasks.map((t) => (
            <li key={t.id}>
              <button type="button" className="hover:bg-hover flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm" onClick={() => void mark(t)}>
                <span className="text-ink-2 font-mono text-xs">{t.code}</span>
                <span className="truncate">{t.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

/** "Xong phần API rồi": pick which of my open tasks that was; the likeliest match is first. */
function DoneModal({ message, onClose, onDone }: { message: string; onClose: () => void; onDone: (taskId: string) => void }) {
  const t = useT();
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void api<{ tasks: Task[] }>("work/tasks?scope=assigned")
      .then((r) =>
        setTasks(
          rankByMessage(
            message,
            r.tasks.filter((x) => !["done", "cancelled"].includes(x.status)),
          ),
        ),
      )
      .catch(() => setTasks([]));
  }, [message]);
  const finish = async (task: Task) => {
    try {
      await api(`work/tasks/${task.id}`, { method: "PATCH", body: { expectedVersion: task.version, status: "done" } });
      onDone(task.id);
    } catch {
      setError(t("chat.signals.blockFailed"));
    }
  };
  return (
    <Modal title={t("chat.signals.whichDone")} onClose={onClose}>
      <p className="text-ink-2 mb-3 text-sm">{t("chat.signals.doneNote")}</p>
      {error ? (
        <p className="text-block mb-2 text-sm" role="alert">
          {error}
        </p>
      ) : null}
      {tasks === null ? (
        <p className="text-ink-2">{t("chat.signals.loadingTasks")}</p>
      ) : tasks.length === 0 ? (
        <p className="text-ink-2">{t("chat.signals.noOpenTasks")}</p>
      ) : (
        <ul className="m-0 grid max-h-80 list-none gap-1 overflow-auto p-0">
          {tasks.map((x, i) => (
            <li key={x.id}>
              <button
                type="button"
                className={cx("hover:bg-hover flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm", i === 0 && "bg-accent-wash")}
                onClick={() => void finish(x)}
              >
                <span className="text-ink-2 font-mono text-xs">{x.code}</span>
                <span className="truncate">{x.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
