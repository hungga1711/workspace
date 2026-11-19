"use client";

import { useState, type RefObject } from "react";
import { api } from "@/lib/client";
import { budgetMessage } from "@/lib/ai-spend";
import { useT } from "@/lib/i18n/client";
import { Markdown } from "@/lib/markdown";
import { btn, btnPrimary, btnSm, cx, input } from "@/lib/ui";
import { drawerTool } from "@/components/ui/Drawer";
import { useToast } from "@/components/ui/Toast";
import { SparkleIcon, CloseIcon } from "@/components/app/icons";
import type { BoardController } from "./controller";

type Result = { kind: "summarize"; summary: string } | { kind: "cluster"; groups: { title: string; elementIds: string[] }[] } | { kind: "ideas"; ideas: string[] };

/** Markdown as plain lines for a note on the board (the canvas has no rich text). */
const plain = (md: string) =>
  md
    .split("\n")
    .map((l) =>
      l
        .replace(/^#{1,6}\s+/, "")
        .replace(/^\s*[-*]\s+/, "• ")
        .replace(/\*\*(.+?)\*\*/g, "$1")
        .replace(/`([^`]+)`/g, "$1"),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/**
 * AI on a whiteboard (only offered when the company's AI is on): summarize the board, group its stickies by theme,
 * suggest new stickies. Each answer applies with one click. The AI reads the saved board, so it is saved first.
 */
export function AiPanel({ boardId, controller, onClose, canEdit }: { boardId: string; controller: RefObject<BoardController | null>; onClose: () => void; canEdit: boolean }) {
  const t = useT();
  const toast = useToast();
  const [busy, setBusy] = useState<Result["kind"] | null>(null);
  const [r, setR] = useState<Result | null>(null);
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const run = async (kind: Result["kind"]) => {
    setBusy(kind);
    setError(null);
    setR(null);
    try {
      await controller.current?.save().catch(() => undefined);
      const body = { whiteboardId: boardId, ...(kind === "ideas" && prompt.trim() ? { prompt: prompt.trim() } : {}) };
      const x = await api<Omit<Result, "kind">>(`ai/whiteboard/${kind}`, { method: "POST", body });
      setR({ kind, ...x } as Result);
    } catch (e) {
      const s = (e as { status?: number }).status;
      setError(budgetMessage(t, e) ?? (s === 403 || s === 503 ? t("whiteboard.aiOff") : t("whiteboard.aiFailed")));
    } finally {
      setBusy(null);
    }
  };
  const done = () => toast({ message: t("whiteboard.aiAdded") });
  const action = (kind: Result["kind"], label: string) => (
    <button type="button" className={cx(btn, btnSm)} disabled={!!busy} aria-busy={busy === kind} onClick={() => void run(kind)}>
      {busy === kind ? t("whiteboard.aiWorking") : label}
    </button>
  );
  return (
    <aside
      aria-labelledby="wb-ai-h"
      className="bg-surface border-hairline shadow-popover absolute bottom-3 right-3 top-3 z-20 flex w-[360px] flex-col overflow-hidden rounded-xl border max-md:inset-x-2 max-md:bottom-2 max-md:top-auto max-md:max-h-[70%] max-md:w-auto"
    >
      <header className="border-divider flex items-center gap-2 border-b px-4 py-3">
        <SparkleIcon className="text-ink-2 size-4" />
        <h2 id="wb-ai-h" className="m-0 flex-1 text-[14px]/6 font-semibold">
          {t("whiteboard.aiTitle")}
        </h2>
        <button type="button" className={drawerTool} aria-label={t("common.close")} onClick={onClose}>
          <CloseIcon />
        </button>
      </header>
      <div className="grid gap-3 overflow-auto p-4">
        <div className="flex flex-wrap gap-1.5">
          {action("summarize", t("whiteboard.aiSummarize"))}
          {action("cluster", t("whiteboard.aiCluster"))}
        </div>
        <form
          className="flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void run("ideas");
          }}
        >
          <input
            aria-label={t("whiteboard.aiPrompt")}
            className={cx(input, "min-h-8 text-sm")}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={t("whiteboard.aiPromptHint")}
          />
          <button type="submit" className={cx(btn, btnSm, "shrink-0")} disabled={!!busy}>
            {busy === "ideas" ? t("whiteboard.aiWorking") : t("whiteboard.aiIdeas")}
          </button>
        </form>
        {error ? (
          <p role="alert" className="text-block m-0 text-sm">
            {error}
          </p>
        ) : null}
        {r ? (
          <section aria-live="polite" className="border-hairline grid gap-3 rounded-lg border p-3 text-sm">
            {r.kind === "summarize" ? (
              <>
                <div className="[&_p]:my-1 [&_ul]:my-1 [&_ul]:pl-5">
                  <Markdown source={r.summary} />
                </div>
                {canEdit ? (
                  <button
                    type="button"
                    className={cx(btnPrimary, btnSm, "justify-self-start")}
                    onClick={() => {
                      controller.current?.addNote(plain(r.summary));
                      done();
                    }}
                  >
                    {t("whiteboard.aiAddSummary")}
                  </button>
                ) : null}
              </>
            ) : r.kind === "cluster" ? (
              r.groups.length ? (
                <>
                  <ul className="m-0 grid list-none gap-1.5 p-0">
                    {r.groups.map((g) => (
                      <li key={g.title} className="flex items-baseline justify-between gap-2">
                        <span className="min-w-0 truncate font-medium">{g.title}</span>
                        <span className="text-ink-2 shrink-0 text-xs tabular-nums">{t("whiteboard.aiStickies", { count: g.elementIds.length })}</span>
                      </li>
                    ))}
                  </ul>
                  {canEdit ? (
                    <button
                      type="button"
                      className={cx(btnPrimary, btnSm, "justify-self-start")}
                      onClick={() => {
                        controller.current?.arrange(r.groups);
                        done();
                      }}
                    >
                      {t("whiteboard.aiApplyGroups")}
                    </button>
                  ) : null}
                </>
              ) : (
                <p className="m-0">{t("whiteboard.aiNoGroups")}</p>
              )
            ) : r.ideas.length ? (
              <>
                <ul className="m-0 grid list-disc gap-1 pl-5">
                  {r.ideas.map((i) => (
                    <li key={i}>{i}</li>
                  ))}
                </ul>
                {canEdit ? (
                  <button
                    type="button"
                    className={cx(btnPrimary, btnSm, "justify-self-start")}
                    onClick={() => {
                      controller.current?.addStickies(r.ideas);
                      done();
                    }}
                  >
                    {t("whiteboard.aiAddIdeas")}
                  </button>
                ) : null}
              </>
            ) : (
              <p className="m-0">{t("whiteboard.aiNoIdeas")}</p>
            )}
          </section>
        ) : null}
      </div>
    </aside>
  );
}
