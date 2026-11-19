"use client";

import { budgetMessage } from "@/lib/ai-spend";
import { useT } from "@/lib/i18n/client";
import { useState } from "react";
import { api } from "@/lib/client";
import { Markdown } from "@/lib/markdown";
import { useDirectory } from "@/lib/people";
import { btn, btnPrimary, btnSm, cx, input } from "@/lib/ui";
import { CheckIcon, CloseIcon, SparkleIcon } from "@/components/app/icons";
import { IconTile } from "@/components/ui/Bento";

type R =
  | { kind: "summarize"; summary: string; keyPoints: string[] }
  | { kind: "ask"; answer: string; quotes: string[] }
  | { kind: "actions"; actions: { title: string; assigneeId: string | null; due: string | null }[] }
  | { kind: "changes"; from: number; to: number; changes: string[] }
  | { kind: "draft"; draft: string };

/** "dd/MM" → end of that day this year (ISO), for tasks created from the document. */
const due = (hint: string | null) => {
  const m = hint?.match(/(\d{1,2})\/(\d{1,2})/);
  return m ? new Date(new Date().getFullYear(), Number(m[2]) - 1, Number(m[1]), 17).toISOString() : null;
};

/**
 * AI on a document: summarize, Q&A, extract actions → tasks linked to the document,
 * what changed since the last version, draft a section. The saved version is what the AI reads.
 */
export function DocAiPanel({
  docId,
  title,
  dirty,
  onInsert,
  onClose,
}: {
  docId: string;
  title: string;
  dirty: boolean;
  onInsert: (markdown: string) => void;
  onClose?: () => void;
}) {
  const tx = useT();
  const dir = useDirectory();
  const [busy, setBusy] = useState<string | null>(null);
  const [r, setR] = useState<R | null>(null);
  const [question, setQuestion] = useState("");
  const [instruction, setInstruction] = useState("");
  const [created, setCreated] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: R["kind"], extra: Record<string, unknown> = {}) => {
    setBusy(action);
    setError(null);
    setR(null);
    setCreated([]);
    try {
      const x = await api<Omit<R, "kind">>(`ai/docs/${docId}/assist`, {
        method: "POST",
        body: { action, people: dir.people.map((p) => ({ id: p.userId, name: p.displayName })), ...extra },
      });
      setR({ kind: action, ...x } as R);
    } catch (e) {
      const s = (e as { status?: number }).status;
      setError(budgetMessage(tx, e) ?? (s === 403 ? tx("work.docaipanel.workspace_chua_bat_ai") : tx("work.docaipanel.ai_chua_tra_loi")));
    } finally {
      setBusy(null);
    }
  };
  const createTask = async (a: { title: string; assigneeId: string | null; due: string | null }) => {
    await api("work/tasks", {
      method: "POST",
      body: {
        title: a.title,
        assigneeId: a.assigneeId,
        dueAt: due(a.due),
        description: tx("work.docaipanel.tu_tai_lieu", { p0: title }),
        source: { type: "document", documentId: docId },
      },
    });
    setCreated((c) => [...c, a.title]);
  };
  const chip = (action: R["kind"], label: string) => (
    <button type="button" className={cx(btn, btnSm)} disabled={!!busy} onClick={() => void run(action)}>
      {busy === action ? tx("work.docaipanel.dang_doc") : label}
    </button>
  );
  return (
    <section aria-labelledby="doc-ai-h" className="bg-surface shadow-card animate-rise mt-6 rounded-xl p-4">
      <div className="mb-3 flex items-center gap-1.5">
        <h2 id="doc-ai-h" className="m-0 flex min-h-8 flex-1 items-center gap-3 text-sm font-semibold tracking-[-0.01em]">
          <IconTile tone="violet">
            <SparkleIcon />
          </IconTile>
          {tx("work.docaipanel.ai_cho_tai_lieu")}
        </h2>
        {onClose ? (
          <button
            type="button"
            aria-label={tx("common.close")}
            title={tx("common.close")}
            onClick={onClose}
            className="text-ink-2 hover:bg-hover hover:text-ink -my-1 -mr-1.5 grid size-7 place-items-center rounded-md transition-colors"
          >
            <CloseIcon className="size-4" />
          </button>
        ) : null}
      </div>
      {dirty ? <p className="text-warn mb-2 text-xs">{tx("work.docaipanel.ai_doc_ban_da")}</p> : null}
      <div className="flex flex-wrap gap-1.5">
        {chip("summarize", tx("work.docaipanel.tom_tat"))}
        {chip("actions", tx("work.docaipanel.trich_viec_can_lam"))}
        {chip("changes", tx("work.docaipanel.co_gi_thay_doi"))}
      </div>
      <form
        className="mt-2 flex gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (question.trim()) void run("ask", { question });
        }}
      >
        <input
          aria-label={tx("work.docaipanel.hoi_ve_tai_lieu")}
          className={cx(input, "h-8 min-h-0 text-sm")}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder={tx("work.docaipanel.hoi_ve_tai_lieu_2")}
        />
        <button type="submit" className={cx(btn, btnSm)} disabled={!question.trim() || !!busy}>
          {busy === "ask" ? tx("work.docaipanel.dang_doc") : tx("work.docaipanel.hoi")}
        </button>
      </form>
      <form
        className="mt-1.5 flex gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (instruction.trim()) void run("draft", { instruction });
        }}
      >
        <input
          aria-label={tx("work.docaipanel.nho_ai_soan")}
          className={cx(input, "h-8 min-h-0 text-sm")}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder={tx("work.docaipanel.nho_ai_soan_vd")}
        />
        <button type="submit" className={cx(btn, btnSm)} disabled={!instruction.trim() || !!busy}>
          {busy === "draft" ? tx("work.docaipanel.dang_doc") : tx("work.docaipanel.soan")}
        </button>
      </form>
      {error ? (
        <p className="text-block mt-2 text-sm" role="alert">
          {error}
        </p>
      ) : null}
      {r ? (
        <div className="bg-accent-wash ring-accent/15 animate-rise mt-3 rounded-xl p-3 text-sm ring-1 ring-inset" aria-label={tx("work.docaipanel.ket_qua_ai")}>
          {r.kind === "summarize" ? (
            <>
              <Markdown source={r.summary} />
              {r.keyPoints.length ? (
                <ul className="mt-1 list-disc pl-5">
                  {r.keyPoints.map((k) => (
                    <li key={k}>{k}</li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : null}
          {r.kind === "ask" ? (
            <>
              {/* Models answer in Markdown (lists, bold): render it, never the raw marks. */}
              <Markdown source={r.answer} />
              {r.quotes.length ? (
                <blockquote className="border-hairline text-ink-2 mt-2 border-l-2 pl-3">
                  {r.quotes.map((q) => (
                    <p key={q}>“{q}”</p>
                  ))}
                </blockquote>
              ) : null}
            </>
          ) : null}
          {r.kind === "actions" ? (
            r.actions.length ? (
              <ul className="m-0 grid list-none gap-1.5 p-0">
                {r.actions.map((a) => (
                  <li key={a.title} className="bg-surface flex flex-wrap items-center gap-2 rounded-sm px-2.5 py-1.5">
                    <span className="min-w-0 flex-1">
                      {a.title}
                      <span className="text-ink-2 text-xs">
                        {a.assigneeId ? ` · ${dir.name(a.assigneeId)}` : ""}
                        {a.due ? tx("work.docaipanel.han", { p0: a.due }) : ""}
                      </span>
                    </span>
                    {created.includes(a.title) ? (
                      <span className="text-ok flex items-center gap-1 text-xs">
                        <CheckIcon className="size-3.5" />
                        {tx("work.docaipanel.da_tao_viec")}
                      </span>
                    ) : (
                      <button type="button" className={cx(btnPrimary, btnSm)} onClick={() => void createTask(a)}>
                        {tx("work.docaipanel.tao_viec")}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p>{tx("work.docaipanel.khong_thay_viec_can")}</p>
            )
          ) : null}
          {r.kind === "changes" ? (
            r.to <= 1 ? (
              <p>{tx("work.docaipanel.day_la_phien_ban")}</p>
            ) : r.changes.length ? (
              <>
                <p className="mb-1">{tx("work.docaipanel.tu_phien_ban_den", { p0: r.from, p1: r.to })}</p>
                <ul className="list-disc pl-5">
                  {r.changes.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              </>
            ) : (
              <p>{tx("work.docaipanel.khong_co_thay_doi", { p0: r.from, p1: r.to })}</p>
            )
          ) : null}
          {r.kind === "draft" ? (
            r.draft ? (
              <>
                <div className="bg-surface max-h-72 overflow-auto rounded-sm p-3">
                  <Markdown source={r.draft} />
                </div>
                <button
                  type="button"
                  className={cx(btnPrimary, btnSm, "mt-2")}
                  onClick={() => {
                    onInsert(r.draft);
                    setR(null);
                    setInstruction("");
                  }}
                >
                  {tx("work.docaipanel.chen_vao_cuoi_tai")}
                </button>
              </>
            ) : (
              <p>{tx("work.docaipanel.draft_unavailable")}</p>
            )
          ) : null}
          <p className="text-ink-2 mt-2 text-xs">{tx("work.docaipanel.ai_note")}</p>
        </div>
      ) : null}
    </section>
  );
}
