"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CloseIcon, ExpandIcon, PlusIcon, ShieldIcon, SparkleIcon } from "@/components/app/icons";
import { aiProblem, budgetMessage } from "@/lib/ai-spend";
import { sensitiveLabel } from "@/lib/ai-labels";
import { mayBeRef, refFromDrop, type AskContextRef } from "@/lib/ask-context";
import { api } from "@/lib/client";
import { useT } from "@/lib/i18n/client";
import type { SensitiveKind } from "@/lib/sensitive";
import { btn, btnSm, cx } from "@/lib/ui";
import AssistantThread, { type Extras, type Msg } from "../AssistantThread";
import { postStream, type StreamHandlers } from "../answerStream";
import type { AskFile, AskRef } from "../AskExtras";
import type { AssistantModel } from "../AssistantView";
import type { PendingCard, Source, ToolChip } from "../mention-types";
import { nextShown } from "../reveal";
import { pageContext, refKey } from "./page-context";

interface Answer {
  conversationId: string;
  answer: string;
  model: string;
  toolCalls?: ToolChip[];
  sources?: Source[];
  pending?: PendingCard;
  stopped?: boolean;
}

/**
 * Hỏi đáp beside the current screen (⌘J): a side panel on desktop, the whole screen on a phone. It sends the screen
 * the person is on as the question's context (a removable "On screen" chip, ids only: the server reads it as them),
 * plus whatever they @-pick, drag or paste in. Conversations are the same as Hỏi đáp's and show in its history.
 */
export default function AskPanel({ open, onClose, incoming }: { open: boolean; onClose: () => void; incoming: { refs: AskContextRef[]; n: number } | null }) {
  const t = useT();
  const path = usePathname();
  const root = useRef<HTMLDivElement>(null);
  const [models, setModels] = useState<AssistantModel[]>([]);
  const [route, setRouteState] = useState("");
  const [loadFailed, setLoadFailed] = useState(false);
  const [myTasks, setMyTasks] = useState<Extras["myTasks"]>([]);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [conv, setConv] = useState<string | null>(null);
  const [error, setError] = useState<{ text: string; retry: string | null } | null>(null);
  const [warn, setWarn] = useState<{ kinds: SensitiveKind[]; text: string } | null>(null);
  const [draft, setDraft] = useState<{ text: string; n: number } | null>(null);
  const [files, setFiles] = useState<AskFile[]>([]);
  const [refs, setRefs] = useState<AskRef[]>([]);
  const busy = messages.some((m) => m.pending);

  // What the screen shows, read when the panel opens and after each navigation (the tab title names it).
  const [page, setPage] = useState<AskRef | null>(null);
  // The screen's chip once removed, or once sent with a question: it comes back only for another screen.
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    const read = () => setPage(pageContext());
    read();
    // Next.js sets the new title just after the page renders.
    const timer = setTimeout(read, 250);
    return () => clearTimeout(timer);
  }, [open, path]);
  const onScreen = page && refKey(page) !== dismissed ? page : null;

  const load = useCallback(() => {
    setLoadFailed(false);
    void api<{ models: AssistantModel[] }>("ai/assistant/models")
      .then((r) => {
        setModels(r.models);
        let saved: string | null = null;
        try {
          saved = localStorage.getItem("wx.ai.model");
        } catch {}
        setRouteState(saved && r.models.some((m) => m.route === saved) ? saved : (r.models[0]?.route ?? ""));
      })
      .catch(() => setLoadFailed(true));
    // The @ picker offers the person's open tasks first; without them it still searches.
    void api<{ open?: { id: string; code?: string | null; title: string }[] }>("work/me/summary")
      .then((r) => setMyTasks((r.open ?? []).slice(0, 3).map(({ id, code, title }) => ({ id, code: code ?? null, title }))))
      .catch(() => undefined);
  }, []);
  useEffect(load, [load]);
  const setRoute = useCallback((r: string) => {
    setRouteState(r);
    try {
      localStorage.setItem("wx.ai.model", r);
    } catch {}
  }, []);

  const addRef = useCallback(
    (r: AskRef) => {
      // The screen itself is already there (or was just removed on purpose).
      if (page && refKey(r) === refKey(page) && !r.page) {
        setDismissed(null);
        return;
      }
      setRefs((list) => (list.some((x) => x.kind === r.kind && x.id === r.id) ? list : [...list, { ...r, page: false }]));
    },
    [page],
  );
  useEffect(() => {
    if (incoming) for (const r of incoming.refs) addRef(r);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming]);

  const filesRef = useRef(files);
  filesRef.current = files;
  const addFiles = useCallback(
    (list: File[]) => {
      void import("../AskExtras").then(async ({ prepareFiles }) => {
        const r = await prepareFiles(list, filesRef.current);
        if (r.files.length) setFiles((f) => [...f, ...r.files]);
        if (r.refused) setError({ text: t(`aiw.chat.extras.refused.${r.refused}`), retry: null });
      });
    },
    [t],
  );
  const shown = useMemo(() => (onScreen ? [{ ...onScreen, page: true }, ...refs] : refs), [onScreen, refs]);
  const extras: Extras = {
    files,
    refs: shown,
    addFiles,
    removeFile: (key) => setFiles((f) => f.filter((x) => x.key !== key)),
    addRef,
    removeRef: (r) => (r.page ? setDismissed(refKey(r)) : setRefs((list) => list.filter((x) => !(x.kind === r.kind && x.id === r.id)))),
    myTasks,
  };

  // The answer as it is written: shown at a steady pace (reveal.ts), stoppable.
  const live = useRef<{ id: string | null; abort: AbortController; text: string; shown: number; carry: number; frame: number; wake: () => void; done: (() => void) | null } | null>(
    null,
  );
  const [streaming, setStreaming] = useState(false);
  useEffect(() => () => live.current?.abort.abort(), []);
  const begin = (msgId: string): { handlers: StreamHandlers; signal: AbortSignal } => {
    const l = { id: null as string | null, abort: new AbortController(), text: "", shown: 0, carry: 0, frame: 0, wake: () => undefined, done: null as (() => void) | null };
    live.current = l;
    setStreaming(true);
    const instant = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let last = 0;
    const tick = (now: number) => {
      l.frame = 0;
      if (live.current !== l) return;
      const before = l.shown;
      if (instant) l.shown = l.text.length;
      else ({ shown: l.shown, carry: l.carry } = nextShown(l.text, l.shown, last ? now - last : 16, l.carry));
      last = now;
      if (l.shown !== before) setMessages((m) => m.map((x) => (x.id === msgId ? { ...x, content: l.text.slice(0, l.shown) } : x)));
      if (l.shown < l.text.length) l.frame = requestAnimationFrame(tick);
      else {
        last = 0;
        l.done?.();
      }
    };
    l.wake = () => {
      if (!l.frame) l.frame = requestAnimationFrame(tick);
    };
    return {
      signal: l.abort.signal,
      handlers: {
        start: (id) => (l.id = id),
        delta: (piece) => {
          l.text += piece;
          l.wake();
        },
        reset: () => {
          l.text = "";
          l.shown = 0;
          l.carry = 0;
          l.wake();
        },
      },
    };
  };
  const end = () => {
    if (live.current?.frame) cancelAnimationFrame(live.current.frame);
    live.current = null;
    setStreaming(false);
  };
  const finish = async (answer: string, stopped: boolean) => {
    const l = live.current;
    if (l && !stopped && answer.startsWith(l.text.slice(0, l.shown)) && answer.length > l.shown) {
      l.text = answer;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 700);
        l.done = () => {
          clearTimeout(timer);
          resolve();
        };
        l.wake();
      });
    }
    end();
  };
  const stop = () => {
    const l = live.current;
    if (!l) return;
    if (l.id) void api(`ai/assistant/streams/${l.id}/stop`, { method: "POST" }).catch(() => l.abort.abort());
    else l.abort.abort();
  };
  const stoppedEmpty = (r: Answer | null, signal: AbortSignal) => (r ? !!r.stopped && !r.answer : signal.aborted);
  /** A reply as a bubble; anything else the server adds to an answer (tables, charts) rides along as it came. */
  const answerMsg = (id: string, r: Answer): Msg => {
    const { conversationId: _c, answer, model, toolCalls, pending, sources, stopped: _s, ...rest } = r;
    return {
      ...(rest as Partial<Msg>),
      id,
      role: "assistant",
      content: answer,
      at: new Date().toISOString(),
      offline: models.some((m) => m.vendor !== "local") && !!model && model.startsWith("local"),
      ...(toolCalls?.length ? { tools: toolCalls } : {}),
      ...(pending ? { confirm: pending } : {}),
      ...(sources?.length ? { sources } : {}),
    };
  };

  const post = async (content: string) => {
    setError(null);
    const sentFiles = files;
    const sentRefs = shown;
    setFiles([]);
    setRefs([]);
    if (onScreen) setDismissed(refKey(onScreen));
    const mine: Msg = {
      id: `u${Date.now()}`,
      role: "user",
      content,
      at: new Date().toISOString(),
      ...(sentFiles.length ? { files: sentFiles.map(({ data: _, ...f }) => f) } : {}),
      ...(sentRefs.length ? { refs: sentRefs } : {}),
    };
    const wait: Msg = { id: `a${Date.now()}`, role: "assistant", content: "", pending: true };
    setMessages((m) => [...m, mine, wait]);
    const putBack = () => {
      setMessages((m) => m.filter((x) => x.id !== mine.id && x.id !== wait.id));
      setDraft((d) => ({ text: content, n: (d?.n ?? 0) + 1 }));
      setFiles((f) => [...sentFiles, ...f]);
      setRefs((list) => [...sentRefs.filter((r) => !r.page), ...list]);
      if (sentRefs.some((r) => r.page)) setDismissed(null);
    };
    const { handlers, signal } = begin(wait.id);
    try {
      const r = await postStream<Answer>(
        "ai/assistant/messages/stream",
        {
          content,
          ...(conv ? { conversationId: conv } : {}),
          ...(route ? { route } : {}),
          ...(sentFiles.length ? { attachments: sentFiles.map((f) => ({ name: f.name, contentType: f.contentType, data: f.data ?? "" })) } : {}),
          ...(sentRefs.length
            ? {
                refs: sentRefs.map(({ kind, id, label, page, thread }) => ({
                  kind,
                  id,
                  label: label.slice(0, 200),
                  ...(page ? { page: true } : {}),
                  ...(thread ? { thread } : {}),
                })),
              }
            : {}),
        },
        handlers,
        signal,
      );
      await finish(r.answer, !!r.stopped);
      if (stoppedEmpty(r, signal)) return putBack();
      setMessages((m) => m.map((x) => (x.id === wait.id ? answerMsg(wait.id, r) : x)));
      if (!conv && r.conversationId) setConv(r.conversationId);
    } catch (e) {
      end();
      putBack();
      if (stoppedEmpty(null, signal)) return;
      const hit = aiProblem(t, e);
      const code = (e as { body?: { error?: string } }).body?.error;
      const fileError = code === "images_unsupported" || code === "file_unsupported" || code === "file_unreadable" || code === "files_too_large" ? code : null;
      const down = !budgetMessage(t, e) && !!hit;
      setError(
        hit && !down
          ? { text: hit, retry: null }
          : fileError
            ? { text: t(`aiw.chat.extras.error.${fileError}`), retry: null }
            : { text: hit ?? t("aiw.chat.failed"), retry: content },
      );
    }
  };
  const decide = async (msgId: string, approve: boolean) => {
    const msg = messages.find((x) => x.id === msgId);
    if (!msg?.confirm) return;
    setError(null);
    setMessages((m) => m.map((x) => (x.id === msgId ? { ...x, pending: true } : x)));
    try {
      const r = await api<Answer>(`ai/assistant/pending/${msg.confirm.id}`, { method: "POST", body: { approve } });
      setMessages((m) => m.map((x) => (x.id === msgId ? answerMsg(msgId, r) : x)));
    } catch (e) {
      const gone = (e as { status?: number }).status === 404;
      setMessages((m) => m.map((x) => (x.id === msgId ? (gone ? { id: msgId, role: "assistant", content: t("mcpClient.chat.expired") } : { ...msg, pending: false }) : x)));
      setError({ text: aiProblem(t, e) ?? t("aiw.chat.failed"), retry: null });
    }
  };
  const regenerate = async () => {
    const old = messages.at(-1);
    if (!conv || busy || old?.role !== "assistant") return;
    setError(null);
    setMessages((m) => m.map((x) => (x.id === old.id ? { ...x, content: "", pending: true } : x)));
    const { handlers, signal } = begin(old.id);
    try {
      const r = await postStream<Answer>(`ai/assistant/conversations/${conv}/regenerate/stream`, route ? { route } : {}, handlers, signal);
      await finish(r.answer, !!r.stopped);
      setMessages((m) => m.map((x) => (x.id === old.id ? (stoppedEmpty(r, signal) ? old : answerMsg(old.id, r)) : x)));
    } catch (e) {
      end();
      setMessages((m) => m.map((x) => (x.id === old.id ? old : x)));
      if (!stoppedEmpty(null, signal)) setError({ text: aiProblem(t, e) ?? t("aiw.chat.regenFailed"), retry: null });
    }
  };
  const onSend = async (content: string) => {
    if (busy) return false;
    const { detectSensitive } = await import("@/lib/sensitive");
    const kinds = detectSensitive(content);
    if (kinds.length) {
      setWarn({ kinds, text: content });
      return false;
    }
    setWarn(null);
    void post(content);
    return true;
  };
  const onDraftChange = useCallback((text: string) => setWarn((w) => (w && text && text !== w.text ? null : w)), []);
  const restart = () => {
    if (busy) return;
    setMessages([]);
    setConv(null);
    setError(null);
    setDismissed(null);
  };

  // Focus moves into the panel when it opens and back to where it was when it closes.
  const before = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open) {
      before.current = document.activeElement as HTMLElement | null;
      requestAnimationFrame(() => root.current?.querySelector<HTMLTextAreaElement>("[data-ask-input]")?.focus());
    } else before.current?.focus?.();
  }, [open]);

  const iconBtn = "text-ink-2 hover:bg-hover hover:text-ink grid size-8 shrink-0 place-items-center rounded-md transition-colors no-underline [&_svg]:size-4";
  const hosted = models.some((m) => m.vendor !== "local");
  return (
    <div
      ref={root}
      role="dialog"
      aria-modal="false"
      aria-label={t("aiw.panel.title")}
      hidden={!open}
      className={cx("bg-surface fixed inset-0 z-[75] flex-col print:hidden", "md:shadow-drawer md:border-hairline md:left-auto md:w-[440px] md:border-l", open ? "flex" : "hidden")}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented) {
          e.preventDefault();
          onClose();
        }
      }}
      // Dropped anywhere on the panel: a task, page, message or person to ask about (the composer takes files itself).
      onDragOver={(e) => {
        if (mayBeRef(e.dataTransfer.types)) e.preventDefault();
      }}
      onDrop={(e) => {
        if (e.defaultPrevented) return;
        const ref = refFromDrop(e.dataTransfer, window.location.origin);
        if (!ref) return;
        e.preventDefault();
        addRef(ref);
      }}
    >
      <header className="border-hairline flex h-12 shrink-0 items-center gap-1 border-b pl-4 pr-2 max-md:h-14">
        <SparkleIcon className="text-brand-text size-4 shrink-0" aria-hidden="true" />
        <h2 className="text-ink m-0 min-w-0 flex-1 truncate pl-1 text-[14px] font-semibold">{t("aiw.panel.title")}</h2>
        <button
          type="button"
          className={iconBtn}
          aria-label={t("aiw.panel.addContext")}
          title={t("aiw.panel.addContext")}
          onClick={() => root.current?.querySelector<HTMLButtonElement>("[data-ask-mention]")?.click()}
        >
          <span className="text-[15px] font-semibold leading-none">@</span>
        </button>
        <button type="button" className={iconBtn} aria-label={t("aiw.panel.new")} title={t("aiw.panel.new")} onClick={restart} disabled={busy}>
          <PlusIcon />
        </button>
        <Link href={conv ? `/app/ai/ask?c=${conv}` : "/app/ai/ask"} className={iconBtn} aria-label={t("aiw.panel.openFull")} title={t("aiw.panel.openFull")} onClick={onClose}>
          <ExpandIcon />
        </Link>
        <button type="button" className={iconBtn} aria-label={t("aiw.panel.close")} title={`${t("aiw.panel.close")} (Esc)`} onClick={onClose}>
          <CloseIcon />
        </button>
      </header>
      {loadFailed ? (
        <div role="alert" className="grid flex-1 content-center justify-items-center gap-3 p-6 text-center text-sm">
          <p className="text-ink-2 m-0">{t("aiw.panel.loadFailed")}</p>
          <button type="button" className={cx(btn, btnSm)} onClick={load}>
            {t("aiw.panel.retry")}
          </button>
        </div>
      ) : (
        <AssistantThread
          messages={messages}
          busy={busy}
          onSend={onSend}
          models={models}
          route={route}
          setRoute={setRoute}
          draft={draft}
          onDraftChange={onDraftChange}
          onRegenerate={conv && hosted && messages.at(-1)?.role === "assistant" && !messages.at(-1)?.confirm ? () => void regenerate() : undefined}
          onDecide={(id, approve) => decide(id, approve)}
          builtIn={!hosted}
          onStop={streaming ? stop : undefined}
          extras={extras}
          welcome={(composer) => (
            <div className="grid gap-4">
              <p className="text-ink m-0 text-base font-semibold">{t("aiw.panel.greeting")}</p>
              {composer}
            </div>
          )}
          above={
            <>
              {error ? (
                <div role="alert" className="text-block mb-2 flex flex-wrap items-center gap-2 text-sm">
                  <span className="min-w-0 flex-1">{error.text}</span>
                  {error.retry ? (
                    <button
                      type="button"
                      className={cx(btn, btnSm)}
                      onClick={() => {
                        const text = error.retry!;
                        setDraft((d) => ({ text: "", n: (d?.n ?? 0) + 1 }));
                        void post(text);
                      }}
                    >
                      {t("aiw.chat.retry")}
                    </button>
                  ) : null}
                </div>
              ) : null}
              {warn ? (
                <div role="alert" className="bg-warn-wash text-warn border-warn/20 mb-2 flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm">
                  <ShieldIcon className="size-4 shrink-0" />
                  <span className="min-w-0 flex-1">{t("aiw.chat.sensitive", { kinds: warn.kinds.map((k) => sensitiveLabel(t, k)).join(", ") })}</span>
                  <button type="button" className={cx(btn, btnSm)} onClick={() => setWarn(null)}>
                    {t("aiw.chat.edit")}
                  </button>
                  <button
                    type="button"
                    className={cx(btn, btnSm)}
                    onClick={() => {
                      const text = warn.text;
                      setWarn(null);
                      setDraft((d) => ({ text: "", n: (d?.n ?? 0) + 1 }));
                      void post(text);
                    }}
                  >
                    {t("aiw.chat.sendAnyway")}
                  </button>
                </div>
              ) : null}
            </>
          }
          footer={null}
        />
      )}
    </div>
  );
}
