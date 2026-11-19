"use client";

import { useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n/client";
import { api } from "@/lib/client";
import { budgetMessage } from "@/lib/ai-spend";
import { diffLines } from "@/lib/diff";
import { Markdown } from "@/lib/markdown";
import { btn, btnGhost, btnPrimary, btnSm, cx, input } from "@/lib/ui";
import { IconTile } from "@/components/ui/Bento";
import { Segmented } from "@/components/ui/Segmented";
import { CloseIcon, RefreshIcon, SparkleIcon } from "@/components/app/icons";
import type { WriteMode, WriteProposal } from "@/lib/task-write";

/**
 * The AI's proposal for a task's title and description, next to what is there now: the title before → after, the
 * description as line changes (or rendered, for a first draft), and per-field Use buttons. Nothing is saved until one
 * is pressed; the host saves through the normal task update and offers undo. Loaded on demand (TaskWrite.tsx).
 */
export default function TaskWritePanel({
  mode,
  title,
  description,
  taskRef,
  projectId,
  labels,
  onApply,
  onClose,
}: {
  mode: WriteMode;
  title: string;
  description: string;
  taskRef?: string;
  projectId?: string | null;
  labels?: string[];
  onApply: (patch: { title?: string; description?: string }) => Promise<boolean>;
  onClose: () => void;
}) {
  const tx = useT();
  const [instruction, setInstruction] = useState("");
  const [asked, setAsked] = useState(mode !== "custom");
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [r, setR] = useState<WriteProposal | null>(null);
  // Fields already applied leave the panel; it closes once nothing is left.
  const [done, setDone] = useState<{ title?: boolean; description?: boolean }>({});
  const [view, setView] = useState<"changes" | "preview">("changes");
  const box = useRef<HTMLElement>(null);
  const field = useRef<HTMLInputElement>(null);
  // The text the request was made from: what the changes are shown against.
  const [base, setBase] = useState({ title, description });

  // Reads the title and description as they are when asked (Regenerate after an edit uses the edit).
  const run = async () => {
    if (!title.trim() && !description.trim()) {
      setError(tx("work.taskwrite.needTitle"));
      return;
    }
    setBusy(true);
    setError(null);
    setR(null);
    setDone({});
    setBase({ title, description });
    try {
      const x = await api<WriteProposal>("ai/tasks/write", {
        method: "POST",
        body: {
          mode,
          title,
          description,
          ...(taskRef ? { taskRef } : {}),
          ...(projectId ? { projectId } : {}),
          labels: labels ?? [],
          ...(mode === "custom" ? { instruction } : {}),
        },
      });
      setR(x);
      // A rewrite that keeps little of the text reads better rendered than as a wall of added lines.
      const kept = description.trim() ? diffLines(description, x.description).filter((l) => l.type === "same" && l.text.trim()).length : 0;
      setView(kept >= 2 ? "changes" : "preview");
    } catch (e) {
      const s = (e as { status?: number }).status;
      setError(budgetMessage(tx, e) ?? (s === 429 ? tx("work.taskwrite.busy") : s === 404 ? tx("work.taskwrite.notFound") : tx("work.taskwrite.failed")));
    } finally {
      setBusy(false);
    }
  };

  const ask = () => {
    if (!instruction.trim()) return;
    setAsked(true);
    void run();
  };

  useEffect(() => {
    if (asked) void run();
    else field.current?.focus();
    box.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the panel opens
  }, []);

  const apply = async (patch: { title?: string; description?: string }) => {
    setApplying(true);
    const ok = await onApply(patch);
    setApplying(false);
    if (!ok) return;
    const next = { ...done, ...(patch.title !== undefined ? { title: true } : {}), ...(patch.description !== undefined ? { description: true } : {}) };
    setDone(next);
    const titleLeft = !!r?.title && !next.title;
    const descLeft = !!r && r.description !== base.description && !next.description;
    if (!titleLeft && !descLeft) onClose();
  };

  const newTitle = r?.title && !done.title ? r.title : null;
  const newDesc = r && r.description !== base.description && !done.description ? r.description : null;
  const lines = newDesc !== null && view === "changes" ? diffLines(base.description, newDesc) : null;

  return (
    <section
      ref={box}
      aria-labelledby="task-write-h"
      aria-busy={busy}
      className="bg-surface shadow-card animate-rise my-2 overflow-hidden rounded-xl"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="flex items-center gap-2.5 px-3.5 pb-2 pt-3">
        <IconTile tone="violet" className="size-7 rounded-lg">
          <SparkleIcon />
        </IconTile>
        <h3 id="task-write-h" className="text-ink m-0 min-w-0 flex-1 truncate text-sm font-semibold">
          {tx("work.taskwrite.panel")}
          <span className="text-ink-2 font-normal"> · {tx(`work.taskwrite.${mode}`)}</span>
        </h3>
        <button type="button" className="text-ink-2 hover:bg-hover hover:text-ink grid size-7 place-items-center rounded-md" aria-label={tx("common.close")} onClick={onClose}>
          <CloseIcon className="size-4" />
        </button>
      </header>

      {!asked ? (
        // Not a <form>: the new-task window is one, and Enter here must ask the AI, not create the task.
        <div className="flex gap-2 px-3.5 pb-3.5">
          <input
            ref={field}
            className={cx(input, "min-w-0 flex-1")}
            aria-label={tx("work.taskwrite.custom")}
            placeholder={tx("work.taskwrite.customPh")}
            maxLength={500}
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
              e.preventDefault();
              e.stopPropagation();
              ask();
            }}
          />
          <button type="button" className={cx(btnPrimary, btnSm, "min-h-8")} disabled={!instruction.trim()} onClick={ask}>
            {tx("work.taskwrite.customGo")}
          </button>
        </div>
      ) : busy ? (
        <div className="grid gap-2 px-3.5 pb-4" role="status">
          <span className="text-ink-2 text-xs">{tx("work.taskwrite.working")}</span>
          {["w-[92%]", "w-[70%]", "w-[84%]", "w-[48%]"].map((w) => (
            <span key={w} className={cx("bg-hover block h-3 animate-pulse rounded", w)} />
          ))}
        </div>
      ) : error ? (
        <div className="flex flex-wrap items-center gap-2 px-3.5 pb-3.5">
          <p role="alert" className="text-block m-0 min-w-0 flex-1 text-sm">
            {error}
          </p>
          <button type="button" className={cx(btn, btnSm)} onClick={() => void run()}>
            <RefreshIcon />
            {tx("work.taskwrite.regenerate")}
          </button>
        </div>
      ) : r ? (
        <div className="grid gap-3 px-3.5 pb-3">
          {newTitle ? (
            <div className="grid gap-1">
              <span className="text-ink-2 text-xs font-medium uppercase tracking-[0.08em]">{tx("work.taskwrite.title")}</span>
              {base.title.trim() ? <p className="text-ink-2 m-0 text-sm line-through decoration-1">{base.title}</p> : null}
              <div className="flex flex-wrap items-start gap-2">
                <p className="text-ink bg-ok-wash m-0 min-w-0 flex-1 rounded-md px-2 py-1 text-[15px] font-semibold">{newTitle}</p>
                <button type="button" className={cx(btn, btnSm)} disabled={applying} onClick={() => void apply({ title: newTitle })}>
                  {tx("work.taskwrite.applyTitle")}
                </button>
              </div>
            </div>
          ) : null}
          {newDesc !== null ? (
            <div className="grid gap-1.5">
              <div className="flex items-center gap-2">
                <span className="text-ink-2 flex-1 text-xs font-medium uppercase tracking-[0.08em]">{tx("work.taskwrite.description")}</span>
                {base.description.trim() ? (
                  <Segmented
                    size="sm"
                    label={tx("work.taskwrite.description")}
                    value={view}
                    onChange={setView}
                    options={[
                      { value: "changes", label: tx("work.taskwrite.changes") },
                      { value: "preview", label: tx("work.taskwrite.preview") },
                    ]}
                  />
                ) : null}
              </div>
              <div className="border-hairline max-h-[45vh] overflow-y-auto rounded-lg border max-sm:max-h-[36vh]" tabIndex={0} aria-label={tx("work.taskwrite.description")}>
                {lines ? (
                  <pre className="m-0 whitespace-pre-wrap break-words py-1.5 font-sans text-[13px]/6">
                    {lines.map((l, i) => (
                      <span
                        key={i}
                        className={cx(
                          "block px-2.5",
                          l.type === "add" ? "bg-ok-wash text-ink" : l.type === "del" ? "bg-block-wash text-ink-2 line-through decoration-1" : "text-ink-2",
                        )}
                      >
                        <span aria-hidden="true" className={cx("inline-block w-3.5 select-none", l.type === "add" ? "text-ok" : "text-block")}>
                          {l.type === "add" ? "+" : l.type === "del" ? "−" : ""}
                        </span>
                        <span className="sr-only">{l.type === "add" ? "+" : l.type === "del" ? "−" : ""}</span>
                        {l.text || " "}
                      </span>
                    ))}
                  </pre>
                ) : (
                  <div className="px-3 py-2 text-sm [&>div>:first-child]:mt-0 [&>div>:last-child]:mb-0">
                    <Markdown source={newDesc} />
                  </div>
                )}
              </div>
            </div>
          ) : !newTitle ? (
            <p className="text-ink-2 m-0 text-sm">{tx("work.taskwrite.sameTitle")}</p>
          ) : null}
          {r.added.length ? (
            <p className="bg-warn-wash text-warn m-0 rounded-md px-2.5 py-1.5 text-xs" role="note">
              {tx("work.taskwrite.added", { list: r.added.join(", ") })}
            </p>
          ) : null}
          {r.truncated ? <p className="text-ink-2 m-0 text-xs">{tx("work.taskwrite.truncated")}</p> : null}
          <p className="text-ink-2 m-0 text-xs">{tx("work.taskwrite.hint")}</p>
          <footer className="flex flex-wrap items-center justify-end gap-2">
            <button type="button" className={cx(btnGhost, btnSm, "mr-auto")} onClick={onClose}>
              {tx("work.taskwrite.discard")}
            </button>
            <button type="button" className={cx(btn, btnSm)} disabled={applying} onClick={() => void run()}>
              <RefreshIcon />
              {tx("work.taskwrite.regenerate")}
            </button>
            {newDesc !== null && newTitle ? (
              <>
                <button type="button" className={cx(btn, btnSm)} disabled={applying} onClick={() => void apply({ description: newDesc })}>
                  {tx("work.taskwrite.applyDesc")}
                </button>
                <button type="button" className={cx(btnPrimary, btnSm)} disabled={applying} onClick={() => void apply({ title: newTitle, description: newDesc })}>
                  {tx("work.taskwrite.applyBoth")}
                </button>
              </>
            ) : newDesc !== null ? (
              <button type="button" className={cx(btnPrimary, btnSm)} disabled={applying} onClick={() => void apply({ description: newDesc })}>
                {tx("work.taskwrite.apply")}
              </button>
            ) : null}
          </footer>
        </div>
      ) : null}
    </section>
  );
}
