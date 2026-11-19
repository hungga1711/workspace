"use client";

import { useState } from "react";
import { api } from "@/lib/client";
import { useT } from "@/lib/i18n/client";
import { useDirectory } from "@/lib/people";
import { btn, btnPrimary, input } from "@/lib/ui";
import { Modal } from "@/components/ui/Modal";
import { Field } from "@/components/ui/bits";
import { DateField } from "@/components/ui/DateField";
import { AssigneeSelect } from "@/components/work/TaskFields";
import { at } from "@/components/work/calTime";

/**
 * "Giao việc" from a chat message: the message becomes a task (title from its text, the person it
 * mentions or its author as assignee), linked back to the message. From then on it shows in Follow-up
 * with its progress, so "việc sếp giao trong chat" never gets lost.
 */
export function AssignDialog({
  message,
  channelId,
  onClose,
  onDone,
}: {
  message: { id: string; body: string; authorId: string };
  channelId: string;
  onClose: () => void;
  onDone: (code: string) => void;
}) {
  const t = useT();
  const dir = useDirectory();
  const mentioned = [...message.body.matchAll(/<@([A-Za-z0-9_-]{1,64})>/g)].map((m) => m[1]!).find((u) => u !== dir.me);
  const plain = message.body
    .replace(/<@([A-Za-z0-9_-]{1,64})>/g, (_, id: string) => `@${dir.name(id)}`)
    .replace(/[*_~`>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const [title, setTitle] = useState(plain.slice(0, 200));
  const [assignee, setAssignee] = useState<string | null>(mentioned ?? (message.authorId !== dir.me ? message.authorId : null));
  const [due, setDue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const task = await api<{ id: string; code: string }>("work/tasks", {
        method: "POST",
        body: {
          title: title.trim(),
          description: plain.length > 200 ? plain : "",
          assigneeId: assignee,
          dueAt: due ? at(due, 17 * 60).toISOString() : null,
          source: { type: "chat.message", messageId: message.id, channelId },
        },
      });
      onDone(task.code);
    } catch {
      setError(t("chat.assign.failed"));
      setBusy(false);
    }
  };
  return (
    <Modal
      title={t("chat.assign.title")}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btn} onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className={btnPrimary} disabled={!title.trim() || busy} onClick={() => void save()}>
            {t("chat.assign.create")}
          </button>
        </>
      }
    >
      <div className="grid gap-3">
        <Field label={t("chat.assign.task")} error={error}>
          <input className={input} value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <label htmlFor="assign-to" className="text-sm font-medium">
              {t("chat.assign.to")}
            </label>
            <AssigneeSelect id="assign-to" value={assignee} onChange={setAssignee} />
          </div>
          <Field label={t("chat.assign.due")}>
            <DateField label={t("chat.assign.due")} value={due} onChange={setDue} align="right" />
          </Field>
        </div>
        <p className="text-ink-2 m-0 text-xs">{t("chat.assign.hint")}</p>
      </div>
    </Modal>
  );
}
