"use client";

import { TASK_INTENT } from "@/components/workflows/intent";
import { aiProblem, budgetMessage } from "@/lib/ai-spend";
import { sensitiveLabel, topicLabel } from "@/lib/ai-labels";
import type { SensitiveKind } from "@/lib/sensitive";
import Link from "next/link";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/client";
import { useFormat, useT } from "@/lib/i18n/client";
import { btn, btnSm, cx } from "@/lib/ui";
import { MoreIcon, PanelIcon, PencilIcon, PlusIcon, SearchIcon, ShieldIcon, TrashIcon } from "@/components/app/icons";
import { useConfirm } from "@/components/ui/Confirm";
import { groupByDay, matches } from "./chatHistory";
import { postStream, type StreamHandlers } from "./answerStream";
import { nextShown } from "./reveal";
import { TopicIcon } from "./TopicIcon";
import type { Extras, Msg } from "./AssistantThread";
import type { AskFile, AskRef } from "./AskExtras";
import type { PendingCard, Source, ToolChip } from "./mention-types";
import { readBlocks } from "./answer/types";
import type { AnswerStep } from "./AnswerProgress";
import type { WelcomeServer, WelcomeTask, WelcomeWorkflow } from "./AskWelcome";
import { NoAiNotice } from "./NoAiNotice";
// The proposal card (and its pickers) loads when someone asks for a task.
const TaskProposal = dynamic(() => import("@/components/workflows/TaskProposal").then((m) => m.TaskProposal), { ssr: false });

// The history popover (phones, and desktop with the rail folded) loads after paint, in its place.
const HistoryPopover = dynamic(() => import("./HistoryPopover").then((m) => m.HistoryPopover), { ssr: false, loading: () => <span className="h-8 min-w-0 flex-1" /> });
// The empty screen shows inside the thread, which loads after paint anyway: its own chunk, fetched alongside.
const AskWelcome = dynamic(() => import(/* webpackChunkName: "ask-extras" */ "./AskWelcome").then((m) => m.AskWelcome), { ssr: false });
// assistant-ui (thread, composer, action bar) only loads on this page, after the history list has painted.
const loadThread = () => import("./AssistantThread");
const AssistantThread = dynamic(loadThread, { ssr: false, loading: () => <ThreadPlaceholder /> });
// The same, for a thread that opens empty: the composer's place is in the middle (AskWelcome puts it there).
const EmptyThread = dynamic(loadThread, { ssr: false, loading: () => <ThreadPlaceholder empty /> });
// Fetched as soon as this module runs (in parallel with hydration), not once the page has rendered and asks for it.
if (typeof window !== "undefined") void loadThread();
// The "…" menus and the motion library that animates them load after the page paints (route JS budget).
const Menu = dynamic(() => import("@/components/ui/Menu").then((m) => m.Menu), { ssr: false });

export interface AssistantModel {
  route: string;
  vendor: string;
  label: string;
  model: string;
}
export interface ConversationRow {
  id: string;
  title: string;
  model: string;
  topic: string;
  lastAt: string;
  messages: number;
}
/**
 * Trợ lý AI: the company's own AI chat. People pick GPT, Claude or Gemini (whichever the company has a
 * key for) and work as they would on chatgpt.com, but on the company's account, so the company knows
 * what AI is used for. A line under the composer says so; the details are in Của tôi › AI.
 */
export function AssistantView({
  models,
  conversations: listed,
  current,
  initial,
  policy,
  prefill,
  autoSend,
  taskId,
  myTasks = [],
  workflows = [],
  servers = [],
  name,
  lead = false,
  noAi,
}: {
  /** No hosted AI, only the built-in lookups: a banner says so and who can connect one (NoAiNotice). */
  noAi?: { admin: boolean } | undefined;
  models: AssistantModel[];
  conversations: ConversationRow[];
  current: string | null;
  initial: Msg[];
  policy: "topic" | "summary";
  /** Text put in the composer on arrival (Áp dụng AI's "Thử trong Hỏi đáp"); sent at once only with `autoSend`. */
  prefill?: string;
  /** Áp dụng AI's "Làm cùng AI": the prompt was written for one task, so it goes out at once. */
  autoSend?: boolean;
  /** The task the new conversation is about: linked to it, so the person's AI use counts against that work. */
  taskId?: string;
  /** The empty screen's "your work" (a few open tasks, late first) and the agent workflows to hand a task to. */
  myTasks?: WelcomeTask[];
  workflows?: WelcomeWorkflow[];
  /** Outside tools (MCP servers) this person's AI can use, shown on the empty screen. */
  servers?: WelcomeServer[];
  /** The person's given name, for the empty screen's greeting. */
  name?: string | undefined;
  /** They see others' progress: the empty screen suggests questions about their people. */
  lead?: boolean;
}) {
  const t = useT();
  const { ago } = useFormat();
  const router = useRouter();
  const { confirm, dialog } = useConfirm();
  // Deleted conversations leave the lists at once; the server's list catches up on the next refresh.
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());
  const conversations = useMemo(() => (gone.size ? listed.filter((c) => !gone.has(c.id)) : listed), [listed, gone]);
  const [messages, setMessages] = useState<Msg[]>(initial);
  const [conv, setConv] = useState<string | null>(current);
  const [route, setRouteState] = useState(models[0]?.route ?? "");
  // The model picked last time, while the company still offers it.
  useEffect(() => {
    try {
      const saved = localStorage.getItem("wx.ai.model");
      if (saved && models.some((m) => m.route === saved)) setRouteState(saved);
    } catch {}
  }, [models]);
  const setRoute = useCallback((r: string) => {
    setRouteState(r);
    try {
      localStorage.setItem("wx.ai.model", r);
    } catch {}
  }, []);
  const [error, setError] = useState<{ text: string; retry: string | null } | null>(null);
  // Sensitive data spotted in a message: held back and shown above the composer until the person edits or confirms.
  const [warn, setWarn] = useState<{ kinds: SensitiveKind[]; text: string } | null>(null);
  // Text put back into the composer (held back or failed); `n` makes the same text count as a new request.
  const [draft, setDraft] = useState<{ text: string; n: number } | null>(prefill && !autoSend ? { text: prefill, n: 0 } : null);
  // From 80% of a monthly AI budget (theirs, their department's or the company's), the person is told before it runs out.
  // A task the AI drafted from "tạo task …", shown above the composer until it is created or dismissed.
  const [proposal, setProposal] = useState<{ text: string; n: number } | null>(null);
  const [budget, setBudget] = useState<{ scope: "person" | "department" | "workspace"; percent: number } | null>(null);
  const busy = messages.some((m) => m.pending);
  // Images, files and @ references for the next question; sent with it, put back if it fails.
  const [files, setFiles] = useState<AskFile[]>([]);
  const [refs, setRefs] = useState<AskRef[]>([]);
  const addFiles = useCallback(
    (list: File[]) => {
      void import("./AskExtras").then(async ({ prepareFiles }) => {
        const r = await prepareFiles(list, filesRef.current);
        if (r.files.length) setFiles((f) => [...f, ...r.files]);
        if (r.refused) setError({ text: t(`aiw.chat.extras.refused.${r.refused}`), retry: null });
      });
    },
    [t],
  );
  const filesRef = useRef(files);
  filesRef.current = files;
  const extras: Extras = {
    files,
    refs,
    addFiles,
    removeFile: (key) => setFiles((f) => f.filter((x) => x.key !== key)),
    addRef: (r) => setRefs((list) => (list.some((x) => x.kind === r.kind && x.id === r.id) ? list : [...list, r])),
    removeRef: (r) => setRefs((list) => list.filter((x) => !(x.kind === r.kind && x.id === r.id))),
    myTasks,
  };
  // A hosted model is connected. Without one the built-in model is the company's AI: its answers are not a fallback
  // ("overloaded, shorter answer"), and asking again would only repeat the same answer.
  const hosted = models.some((m) => m.vendor !== "local");
  useEffect(() => {
    if (busy) return;
    void api<{ budget: typeof budget }>("ai/spend/me")
      .then((r) => setBudget(r.budget))
      .catch(() => undefined);
  }, [busy]);
  useEffect(() => {
    // A confirm card exists only in this page until the person decides (the server stores the answer after), so the
    // refresh that follows the question must not drop it: keep it when the server's thread ends with that question.
    setMessages((local) => {
      const card = local.at(-1);
      const asked = local.at(-2);
      const keep = card?.role === "assistant" && !!card.confirm && !card.pending && initial.length === local.length - 1 && initial.at(-1)?.content === asked?.content;
      return keep ? [...initial, card] : initial;
    });
    setConv(current);
  }, [current, initial]);
  // The welcome screen's chunk starts loading with the page, alongside the thread's.
  useEffect(() => {
    if (!current) void import(/* webpackChunkName: "ask-extras" */ "./AskWelcome");
  }, [current]);

  // The answer being written: its stream (the stop button), the text received, and how much of it is shown. The text
  // is revealed at a steady pace a little each frame (reveal.ts), not in the bursts it arrives in.
  const live = useRef<{
    id: string | null;
    abort: AbortController;
    text: string;
    shown: number;
    carry: number;
    frame: number;
    wake: () => void;
    done: (() => void) | null;
  } | null>(null);
  const [streaming, setStreaming] = useState(false);
  // Leaving the page drops the request; the server keeps what was written by then.
  useEffect(() => () => live.current?.abort.abort(), []);
  const begin = (msgId: string): { handlers: StreamHandlers; signal: AbortSignal } => {
    const l = {
      id: null as string | null,
      abort: new AbortController(),
      text: "",
      shown: 0,
      carry: 0,
      frame: 0,
      wake: (() => undefined) as () => void,
      done: null as (() => void) | null,
    };
    live.current = l;
    setStreaming(true);
    // Reduced motion: what arrived shows at once, once a frame.
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
    const wake = () => {
      if (!l.frame) l.frame = requestAnimationFrame(tick);
    };
    l.wake = wake;
    return {
      signal: l.abort.signal,
      handlers: {
        start: (id) => (l.id = id),
        delta: (piece) => {
          l.text += piece;
          wake();
        },
        reset: () => {
          l.text = "";
          l.shown = 0;
          l.carry = 0;
          wake();
        },
        // What the AI is doing, shown above the answer as it happens; the same step updates in place.
        step: (st) =>
          setMessages((m) =>
            m.map((x) => (x.id === msgId ? { ...x, steps: x.steps?.some((y) => y.id === st.id) ? x.steps.map((y) => (y.id === st.id ? st : y)) : [...(x.steps ?? []), st] } : x)),
          ),
      },
    };
  };
  /**
   * The answer is complete: what is still held back is revealed quickly (a fraction of a second at most) before the
   * finished answer takes its place, so it does not land in one jump. Stopped: shown at once.
   */
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
  const end = () => {
    if (live.current?.frame) cancelAnimationFrame(live.current.frame);
    live.current = null;
    setStreaming(false);
  };
  /** The stop button: the server ends the answer where it is and keeps that; before it said which stream, the request is dropped. */
  const stop = () => {
    const l = live.current;
    if (!l) return;
    if (l.id) void api(`ai/assistant/streams/${l.id}/stop`, { method: "POST" }).catch(() => l.abort.abort());
    else l.abort.abort();
  };
  /** Stopped before a word was written, or dropped: as if not sent, the question back in the composer. */
  const stoppedEmpty = (r: Answer | null, signal: AbortSignal) => (r ? !!r.stopped && !r.answer : signal.aborted);

  const post = async (content: string) => {
    setError(null);
    const sentFiles = files;
    const sentRefs = refs;
    setFiles([]);
    setRefs([]);
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
      setRefs((list) => [...sentRefs, ...list.filter((x) => !sentRefs.some((y) => y.kind === x.kind && y.id === x.id))]);
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
          ...(sentRefs.length ? { refs: sentRefs.map(({ kind, id, label }) => ({ kind, id, label })) } : {}),
        },
        handlers,
        signal,
      );
      await finish(r.answer, !!r.stopped);
      if (stoppedEmpty(r, signal)) return putBack();
      setMessages((m) => m.map((x) => (x.id === wait.id ? answerMsg(wait.id, r) : x)));
      if (!conv) {
        setConv(r.conversationId);
        if (taskId) void api(`ai/oversight/me/conversations/${r.conversationId}/task`, { method: "PUT", body: { taskId, via: "manual" } }).catch(() => undefined);
        router.replace(`/app/ai/ask?c=${r.conversationId}`, { scroll: false });
      }
      router.refresh();
    } catch (e) {
      end();
      putBack();
      if (stoppedEmpty(null, signal)) return;
      const budgetHit = aiProblem(t, e);
      // A model that cannot read images, or a file the server cannot read: say which, the question stays in the composer.
      const code = (e as { body?: { error?: string } }).body?.error;
      const fileError = code === "images_unsupported" || code === "file_unsupported" || code === "file_unreadable" || code === "files_too_large" ? code : null;
      // Out of budget, trying again cannot help; anything else gets one-tap "Thử lại" (the text is also back in the composer).
      // The AI not answering is worth another try: the retry stays.
      const down = !budgetMessage(t, e) && !!budgetHit;
      setError(
        budgetHit && !down
          ? { text: budgetHit, retry: null }
          : fileError
            ? { text: t(`aiw.chat.extras.error.${fileError}`), retry: null }
            : { text: budgetHit ?? t("aiw.chat.failed"), retry: content },
      );
    }
  };
  /** The confirm card's answer: the tool runs (or not) and the answer carries on in the same bubble. */
  const decide = async (msgId: string, approve: boolean) => {
    const msg = messages.find((x) => x.id === msgId);
    if (!msg?.confirm) return;
    setError(null);
    setMessages((m) => m.map((x) => (x.id === msgId ? { ...x, pending: true } : x)));
    try {
      const r = await api<Answer>(`ai/assistant/pending/${msg.confirm.id}`, { method: "POST", body: { approve } });
      setMessages((m) => m.map((x) => (x.id === msgId ? answerMsg(msgId, r) : x)));
      router.refresh();
    } catch (e) {
      const gone = (e as { status?: number }).status === 404;
      setMessages((m) => m.map((x) => (x.id === msgId ? (gone ? { id: msgId, role: "assistant", content: t("mcpClient.chat.expired") } : { ...msg, pending: false }) : x)));
      setError({ text: aiProblem(t, e) ?? t("aiw.chat.failed"), retry: null });
    }
  };
  /** A reply as a bubble: the text, the outside tools it used, and a confirm card when one waits. */
  const answerMsg = (id: string, r: Answer): Msg => ({
    id,
    role: "assistant",
    content: r.answer,
    at: new Date().toISOString(),
    offline: hosted && !!r.model && r.model.startsWith("local"),
    ...(r.toolCalls?.length ? { tools: r.toolCalls } : {}),
    ...(r.pending ? { confirm: r.pending } : {}),
    ...(r.sources?.length ? { sources: r.sources } : {}),
    ...(readBlocks(r.blocks).length ? { blocks: readBlocks(r.blocks) } : {}),
    ...(r.steps?.length ? { steps: r.steps } : {}),
    ...(r.notes?.length ? { notes: r.notes } : {}),
    ...(r.followUps?.length ? { followUps: r.followUps } : {}),
  });

  // Once per arrival (React runs effects twice in development).
  const sent = useRef(false);
  useEffect(() => {
    if (!autoSend || !prefill || sent.current || current) return;
    sent.current = true;
    void post(prefill);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** "Trả lời lại": the last answer, written again (the server replaces it in place). */
  const regenerate = async () => {
    if (!conv || busy) return;
    const old = messages.at(-1);
    if (old?.role !== "assistant") return;
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

  /** From the composer: held back (false) when it looks like it carries a password, key or personal data. */
  const onSend = async (content: string) => {
    if (busy) return false;
    // The rule table is a few KB the route does not need until the first send.
    const { detectSensitive } = await import("@/lib/sensitive");
    const kinds = detectSensitive(content);
    if (kinds.length) {
      setWarn({ kinds, text: content });
      return false;
    }
    setWarn(null);
    // "Tạo task …": the AI drafts the task (and its agent workflow) for the person to check, instead of a chat answer.
    if (TASK_INTENT.test(content)) {
      const at = new Date().toISOString();
      setMessages((m) => [...m, { id: `u${Date.now()}`, role: "user", content, at }, { id: `a${Date.now()}`, role: "assistant", content: t("workflows.propose.intro"), at }]);
      setProposal({ text: content, n: Date.now() });
      return true;
    }
    void post(content);
    return true;
  };
  // Editing the held-back text dismisses the warning (the composer empties for a moment while it is put back).
  const onDraftChange = useCallback((text: string) => setWarn((w) => (w && text && text !== w.text ? null : w)), []);

  // The history rail shows as soon as there is one conversation, open or not: hiding it while the only one is open made
  // the page change shape between that conversation and "New" (a bare title bar, then the rail). It can be folded away.
  const hasHistory = conversations.length > 0;
  const [folded, setFolded] = useState(false);
  useEffect(() => {
    try {
      setFolded(localStorage.getItem("wx.ai.rail") === "0");
    } catch {}
  }, []);
  const fold = (v: boolean) => {
    setFolded(v);
    try {
      localStorage.setItem("wx.ai.rail", v ? "0" : "1");
    } catch {}
  };
  const rail = hasHistory && !folded;
  // Renamed titles show at once; the server's list catches up on the next refresh.
  const [renamed, setRenamed] = useState<Record<string, string>>({});
  const [renaming, setRenaming] = useState<string | null>(null);
  const titleOf = (c: ConversationRow) => renamed[c.id] ?? c.title;
  const rename = async (id: string, value: string) => {
    setRenaming(null);
    const before = renamed[id] ?? conversations.find((c) => c.id === id)?.title ?? "";
    const next = value.trim();
    if (!next || next === before) return;
    setRenamed((r) => ({ ...r, [id]: next }));
    try {
      const r = await api<{ title: string }>(`ai/assistant/conversations/${id}`, { method: "PATCH", body: { title: next } });
      setRenamed((m) => ({ ...m, [id]: r.title }));
      router.refresh();
    } catch {
      setRenamed((m) => ({ ...m, [id]: before }));
      setError({ text: t("aiw.chat.renameFailed"), retry: null });
    }
  };
  const remove = async (id: string) => {
    const ok = await confirm({ title: t("aiw.chat.deleteTitle"), body: t("aiw.chat.deleteBody"), confirmLabel: t("aiw.chat.delete"), danger: true });
    if (!ok) return;
    setGone((g) => new Set(g).add(id));
    try {
      await api(`ai/assistant/conversations/${id}`, { method: "DELETE" });
      // The open conversation is gone: start a new one in its place.
      if (id === conv) {
        setConv(null);
        setMessages([]);
        router.replace("/app/ai/ask", { scroll: false });
      }
      router.refresh();
    } catch {
      setGone((g) => {
        const n = new Set(g);
        n.delete(id);
        return n;
      });
      setError({ text: t("aiw.chat.deleteFailed"), retry: null });
    }
  };
  const [q, setQ] = useState("");
  const groups = useMemo(() => groupByDay(conversations.filter((c) => matches(renamed[c.id] ?? c.title ?? "", q))), [conversations, renamed, q]);
  const current_ = conversations.find((c) => c.id === conv);
  const rows = useMemo(() => conversations.map((c) => ({ ...c, title: renamed[c.id] ?? c.title })), [conversations, renamed]);
  const title = current_ ? titleOf(current_) : undefined;
  // Which placeholder holds the thread's place while its code loads; decided once, by how the page opened.
  const [Thread] = useState(() => (initial.length || (autoSend && prefill) ? AssistantThread : EmptyThread));
  const iconBtn = "text-ink-2 hover:bg-hover hover:text-ink grid size-8 shrink-0 place-items-center rounded-md transition-colors no-underline [&_svg]:size-4";

  return (
    <div className={cx("grid min-h-0 flex-1 grid-cols-1", rail && "lg:grid-cols-[240px_minmax(0,1fr)]")}>
      {rail ? (
        <aside className="border-hairline bg-ground hidden min-h-0 flex-col border-r lg:flex" aria-label={t("aiw.chat.history")}>
          {/* A compact search and a square "new" button on top, then 28px rows with the topic's icon. */}
          <div className="flex h-12 shrink-0 items-center gap-1.5 px-2">
            <label className="bg-surface ring-hairline focus-within:ring-edge flex h-7 min-w-0 flex-1 cursor-text items-center gap-1.5 rounded-md px-2 ring-1 transition-shadow">
              <SearchIcon className="text-ink-2 size-3.5 shrink-0" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t("aiw.chat.search")}
                aria-label={t("aiw.chat.search")}
                className="text-ink placeholder:text-ink-2 min-w-0 flex-1 bg-transparent text-[13px] outline-none"
              />
            </label>
            <Link
              href="/app/ai/ask"
              className="bg-surface ring-hairline text-ink-soft hover:text-ink hover:bg-hover grid size-7 shrink-0 place-items-center rounded-md ring-1 transition-colors [&_svg]:size-3.5"
              aria-label={t("aiw.chat.new")}
              title={t("aiw.chat.new")}
            >
              <PlusIcon />
            </Link>
            <button type="button" className={cx(iconBtn, "size-7")} aria-label={t("aiw.chat.hideHistory")} title={t("aiw.chat.hideHistory")} onClick={() => fold(true)}>
              <PanelIcon />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {groups.length ? null : <p className="text-ink-2 m-0 px-2 py-2 text-[13px]">{t("aiw.chat.noMatch")}</p>}
            {groups.map(([group, rows]) => (
              <section key={group} aria-label={t(`aiw.chat.group.${group}`)}>
                <h3 className="text-ink-2 m-0 px-2 pb-1 pt-3 text-xs font-medium">{t(`aiw.chat.group.${group}`)}</h3>
                <ul className="m-0 flex list-none flex-col gap-px p-0">
                  {rows.map((c) =>
                    renaming === c.id ? (
                      <li key={c.id}>
                        <RenameInput label={t("aiw.chat.renameLabel")} value={titleOf(c)} onDone={(v) => void rename(c.id, v)} onCancel={() => setRenaming(null)} />
                      </li>
                    ) : (
                      <li key={c.id} className="group/row relative">
                        <Link
                          href={`/app/ai/ask?c=${c.id}`}
                          aria-current={c.id === conv ? "page" : undefined}
                          title={`${titleOf(c) || t("aiw.chat.untitled")}\n${topicLabel(t, c.topic)} · ${ago(c.lastAt)}`}
                          className={cx(
                            "flex h-7 items-center gap-2 rounded-md px-2 text-[13px] no-underline transition-colors group-focus-within/row:pr-8 group-hover/row:pr-8",
                            c.id === conv ? "bg-selected text-ink pr-8 font-medium" : "text-ink-soft hover:bg-hover hover:text-ink",
                          )}
                        >
                          <TopicIcon topic={c.topic} className={cx("size-3.5 shrink-0", c.id === conv ? "text-ink" : "text-ink-2")} />
                          <span className="truncate">{titleOf(c) || t("aiw.chat.untitled")}</span>
                        </Link>
                        {/* The "…" takes room only on hover, keyboard focus and for the open conversation. */}
                        <span
                          className={cx(
                            // Above the rows after it, so its open menu is not covered by them.
                            "absolute right-1 top-1/2 z-10 -translate-y-1/2 opacity-0 transition-opacity focus-within:z-20 focus-within:opacity-100 group-hover/row:opacity-100",
                            c.id === conv && "opacity-100",
                          )}
                        >
                          <Menu
                            align="right"
                            label={t("aiw.chat.more")}
                            items={[
                              { label: t("aiw.chat.rename"), icon: <PencilIcon />, onSelect: () => setRenaming(c.id) },
                              { label: t("aiw.chat.delete"), icon: <TrashIcon />, danger: true, onSelect: () => void remove(c.id) },
                            ]}
                            trigger={
                              <span className="text-ink-2 hover:bg-hover hover:text-ink grid size-6 place-items-center rounded-md [&_svg]:size-3.5">
                                <MoreIcon />
                              </span>
                            }
                          />
                        </span>
                      </li>
                    ),
                  )}
                </ul>
              </section>
            ))}
          </div>
        </aside>
      ) : null}

      <section className="flex min-h-0 flex-col" aria-label={t("aiw.chat.title")}>
        {noAi ? <NoAiNotice mode="builtIn" admin={noAi.admin} className="mx-auto mt-3 w-[calc(100%-2rem)] max-w-[720px] shrink-0" /> : null}
        {/* One thin bar: fold/unfold the history (desktop), the conversation on phones, and a new chat. */}
        {conversations.length || conv ? (
          <div className={cx("relative flex h-12 items-center gap-1 px-2 max-lg:pl-4", (rail || (!hasHistory && !conv)) && "lg:hidden")}>
            {hasHistory ? (
              <button type="button" className={cx(iconBtn, "hidden lg:grid")} aria-label={t("aiw.chat.showHistory")} title={t("aiw.chat.showHistory")} onClick={() => fold(false)}>
                <PanelIcon />
              </button>
            ) : null}
            {/* Phones: the conversation's title opens the history; desktop with the rail folded: "History". */}
            {conversations.length ? <HistoryPopover conversations={rows} current={conv} label={title || t("aiw.chat.new")} className="flex-1 lg:hidden" /> : null}
            {hasHistory && folded ? <HistoryPopover conversations={rows} current={conv} label={t("aiw.chat.history")} className="hidden lg:block" /> : null}
            {conv && renaming === conv ? (
              <div className="min-w-0 flex-1 max-lg:absolute max-lg:inset-x-2 max-lg:z-10 lg:max-w-md">
                <RenameInput label={t("aiw.chat.renameLabel")} value={title ?? ""} onDone={(v) => void rename(conv, v)} onCancel={() => setRenaming(null)} />
              </div>
            ) : (
              <h2 className="text-ink m-0 hidden min-w-0 flex-1 truncate px-2 text-sm font-medium lg:block">{title ?? ""}</h2>
            )}
            {conv && current_ ? (
              <Menu
                align="right"
                label={t("aiw.chat.more")}
                items={[
                  { label: t("aiw.chat.rename"), icon: <PencilIcon />, onSelect: () => setRenaming(conv) },
                  { label: t("aiw.chat.delete"), icon: <TrashIcon />, danger: true, onSelect: () => void remove(conv) },
                ]}
                trigger={
                  <span className={iconBtn}>
                    <MoreIcon />
                  </span>
                }
              />
            ) : null}
            {conv ? (
              <Link href="/app/ai/ask" className={iconBtn} aria-label={t("aiw.chat.new")} title={t("aiw.chat.new")}>
                <PlusIcon />
              </Link>
            ) : null}
          </div>
        ) : null}
        <Thread
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
            <AskWelcome
              tasks={myTasks}
              workflows={workflows}
              servers={servers}
              name={name}
              composer={composer}
              lead={lead}
              onPick={(text) => setDraft((d) => ({ text, n: (d?.n ?? 0) + 1 }))}
            />
          )}
          above={
            <>
              {proposal ? (
                <div className="relative mb-3">
                  <TaskProposal key={proposal.n} text={proposal.text} />
                  <button type="button" className="text-ink-2 hover:text-ink absolute right-3 top-3 text-xs" onClick={() => setProposal(null)} aria-label={t("common.close")}>
                    ✕
                  </button>
                </div>
              ) : null}
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
              ) : budget && budget.percent >= 80 ? (
                <p className="text-warn m-0 mb-2 text-sm">
                  {budget.percent >= 100 ? t(`aiw.budget.${budget.scope}`) : t(`aiw.budget.warn.${budget.scope}`, { percent: budget.percent })}
                </p>
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
          footer={
            // Phones keep the room for the conversation once it starts; the notice stays on the empty screen and on desktop.
            <p className={cx("text-ink-2 m-0 mt-2 text-balance text-center text-xs", messages.length > 0 && "max-md:hidden")}>
              <ShieldIcon className="mr-1 inline size-3.5 align-[-3px]" />
              {t(`aiw.chat.notice.${policy}`)}{" "}
              <Link href="/app/me?tab=ai" className="text-ink whitespace-nowrap">
                {t("aiw.chat.noticeMore")}
              </Link>
            </p>
          }
        />
      </section>
      {dialog}
    </div>
  );
}

interface Answer {
  conversationId: string;
  answer: string;
  model: string;
  toolCalls?: ToolChip[];
  sources?: Source[];
  /** Charts and tables of what its tools read; checked by readBlocks before they are drawn. */
  blocks?: unknown;
  pending?: PendingCard;
  /** Stopped part-way: `answer` is what was written until then (empty: nothing was kept). */
  stopped?: boolean;
  /** What it did, what limits it, what to ask next (the ai module's progress.ts). */
  steps?: AnswerStep[];
  notes?: string[];
  followUps?: string[];
}

/** The composer's place while the conversation's code loads, so the page does not open empty. */
function ThreadPlaceholder({ empty }: { empty?: boolean }) {
  return (
    <div className={cx("flex min-h-0 flex-1 flex-col", empty && "justify-center")} aria-hidden="true">
      {empty ? null : <div className="min-h-0 flex-1" />}
      <div className="mx-auto w-full max-w-[720px] px-4 pb-4 md:px-6">
        <div className={cx("bg-surface border-hairline rounded-2xl border", empty ? "h-[108px]" : "h-[92px]")} />
        <div className="mt-2 h-4" />
      </div>
    </div>
  );
}

/** Inline rename: Enter or leaving the field saves, Escape cancels. */
function RenameInput({ label, value, onDone, onCancel }: { label: string; value: string; onDone: (v: string) => void; onCancel: () => void }) {
  // Escape unmounts the field, and the blur that follows must not save.
  const cancelled = useRef(false);
  return (
    <input
      aria-label={label}
      defaultValue={value}
      maxLength={200}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onBlur={(e) => (cancelled.current ? undefined : onDone(e.currentTarget.value))}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancelled.current = true;
          onCancel();
        }
      }}
      className="bg-surface border-hairline focus:border-ink/30 focus:ring-selected h-9 w-full rounded-md border px-2.5 text-sm outline-none focus:ring-[3px]"
    />
  );
}
