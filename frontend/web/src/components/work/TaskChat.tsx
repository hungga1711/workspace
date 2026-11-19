"use client";

import { useDraft } from "@/lib/draft";
import { useCanSend } from "@/lib/connection";
import { Thinking } from "@/components/ui/Thinking";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import { budgetMessage } from "@/lib/ai-spend";
import { sensitiveLabel } from "@/lib/ai-labels";
import type { SensitiveKind } from "@/lib/sensitive";
import { useFormat, useT } from "@/lib/i18n/client";
import { Markdown } from "@/lib/markdown";
import { btn, btnPrimary, btnSm, cx, input } from "@/lib/ui";
import {
  ArrowRightIcon,
  ArrowUpIcon,
  ChatIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ClockIcon,
  FileIcon,
  FolderIcon,
  ListIcon,
  LockIcon,
  MoreIcon,
  PencilIcon,
  PlusIcon,
  ShieldIcon,
  SparkleIcon,
  TrashIcon,
  WorkIcon,
} from "@/components/app/icons";
import { Menu } from "@/components/ui/Menu";
import { Portal } from "@/components/ui/Portal";
import { Checkbox } from "@/components/ui/Checkbox";
import { ConfirmCard, ToolChips, type PendingCard, type ToolChip } from "@/components/ai/McpToolBits";
import { TaskRelated } from "./TaskRelated";
import { linkCitations, plainAnswer, stepsOf, type ChatSource } from "./taskChatText";

interface Msg {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: ChatSource[] | null;
  toolCalls?: ToolChip[] | null;
  confirm?: PendingCard;
  pending?: boolean;
  offline?: boolean;
}
interface ChatRow {
  id: string;
  title: string;
  lastAt: string;
  messages: number;
}
interface Opened {
  chats: ChatRow[];
  current: string | null;
  messages: Msg[];
}
interface Answer {
  chatId?: string;
  answer: string;
  model: string;
  sources?: ChatSource[];
  toolCalls?: ToolChip[];
  pending?: PendingCard;
}
type Action = "subtasks" | "description" | "comment";

const SRC_ICON: Record<ChatSource["type"], React.ReactNode> = { task: <WorkIcon />, document: <FileIcon />, message: <ChatIcon />, project: <FolderIcon /> };

/** Phones (below 640px): the chat takes the whole screen, over the task. */
function usePhone() {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const on = () => setPhone(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return phone;
}

/**
 * "Hỏi AI" on a task: the person's own chat about this task, grounded on the server in the task, related
 * tasks, documents and messages they can open. Private: teammates see an answer only when it is posted as a comment.
 * Every write (subtasks, description, comment) shows what it will do and waits for a confirm. Loaded with
 * the tab (next/dynamic), never with the task page; without `ai.use` it shows the related list instead.
 */
export default function TaskChat({
  taskId,
  code,
  onClose,
  onAddSubtasks,
  onAppendDescription,
  onComment,
  docked = false,
}: {
  taskId: string;
  code: string;
  /** Back to the activity tab (the phone's full-screen header). */
  onClose: () => void;
  /** `asked`: the question the answer replied to, so "next week" in it can correct a model's date. */
  onAddSubtasks: (titles: string[], asked?: string) => Promise<void>;
  onAppendDescription: (text: string) => Promise<boolean>;
  onComment: (text: string) => Promise<void>;
  /** In the Hỏi AI side sheet, which has its own header and close: fill its height on every screen. */
  docked?: boolean;
}) {
  const t = useT();
  const { ago } = useFormat();
  const phone = usePhone() && !docked;
  const [chats, setChats] = useState<ChatRow[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "failed" | "noAccess">("loading");
  // An unsent question stays with its task (this browser) until it is asked.
  const [text, setText] = useDraft(`task-ai:${taskId}`);
  const [error, setError] = useState<{ text: string; retry: string | null } | null>(null);
  const [warn, setWarn] = useState<{ kinds: SensitiveKind[]; text: string } | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const busy = messages.some((m) => m.pending);
  const canSend = useCanSend();

  const open = useCallback(
    async (chatId?: string) => {
      setState("loading");
      setError(null);
      try {
        const r = await api<Opened>(`ai/tasks/${taskId}/chat${chatId ? `?c=${chatId}` : ""}`);
        setChats(r.chats);
        setCurrent(r.current);
        setMessages(r.messages);
        setState("ready");
      } catch (e) {
        const s = (e as { status?: number }).status;
        // No AI for this person (ai.use) or the company switched the assistant off meanwhile: the related list stands in.
        setState(s === 403 || s === 404 || s === 503 ? "noAccess" : "failed");
      }
    },
    [taskId],
  );
  useEffect(() => void open(), [open]);
  useEffect(() => end.current?.scrollIntoView({ block: "end" }), [messages.length, busy]);

  const fill = (v: string) => {
    setText(v);
    requestAnimationFrame(() => {
      const el = box.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(v.length, v.length);
    });
  };

  const answerMsg = (id: string, r: Answer): Msg => ({
    id,
    role: "assistant",
    content: r.answer,
    sources: r.sources ?? [],
    toolCalls: r.toolCalls ?? [],
    offline: !!r.model && r.model.startsWith("local") && r.model !== "local-extractive",
    ...(r.pending ? { confirm: r.pending } : {}),
  });

  const post = async (content: string) => {
    setError(null);
    const mine: Msg = { id: `u${Date.now()}`, role: "user", content };
    const wait: Msg = { id: `a${Date.now()}`, role: "assistant", content: "", pending: true };
    setMessages((m) => [...m, mine, wait]);
    try {
      const r = await api<Answer>(`ai/tasks/${taskId}/chat`, { method: "POST", body: { content, chatId: current } });
      setMessages((m) => m.map((x) => (x.id === wait.id ? answerMsg(wait.id, r) : x)));
      if (!current && r.chatId) {
        setCurrent(r.chatId);
        setChats((c) => [{ id: r.chatId!, title: content.slice(0, 80), lastAt: new Date().toISOString(), messages: 1 }, ...c]);
      }
    } catch (e) {
      setMessages((m) => m.filter((x) => x.id !== mine.id && x.id !== wait.id));
      setText(content);
      const budget = budgetMessage(t, e);
      setError(budget ? { text: budget, retry: null } : { text: t("taskChat.failed"), retry: content });
    }
  };

  const send = async (content: string, force = false) => {
    const v = content.trim();
    if (!v || busy) return;
    if (!force) {
      // The rule table loads with the first send, not with the tab.
      const { detectSensitive } = await import("@/lib/sensitive");
      const kinds = detectSensitive(v);
      if (kinds.length) {
        setWarn({ kinds, text: v });
        return;
      }
    }
    setWarn(null);
    setText("");
    void post(v);
  };

  const decide = async (msgId: string, approve: boolean) => {
    const msg = messages.find((x) => x.id === msgId);
    if (!msg?.confirm) return;
    setMessages((m) => m.map((x) => (x.id === msgId ? { ...x, pending: true } : x)));
    try {
      const r = await api<Answer>(`ai/assistant/pending/${msg.confirm.id}`, { method: "POST", body: { approve } });
      setMessages((m) => m.map((x) => (x.id === msgId ? answerMsg(msgId, r) : x)));
    } catch (e) {
      setMessages((m) => m.map((x) => (x.id === msgId ? { ...msg, pending: false } : x)));
      setError({ text: budgetMessage(t, e) ?? t("taskChat.failed"), retry: null });
    }
  };

  const fresh = () => {
    setCurrent(null);
    setMessages([]);
    setError(null);
    requestAnimationFrame(() => box.current?.focus());
  };
  const remove = async () => {
    if (!current || !window.confirm(t("taskChat.deleteConfirm"))) return;
    try {
      await api(`ai/tasks/${taskId}/chat/${current}`, { method: "DELETE" });
      setChats((c) => c.filter((x) => x.id !== current));
      fresh();
    } catch {
      setError({ text: t("taskChat.actionFailed"), retry: null });
    }
  };

  const iconBtn = "text-ink-2 hover:bg-hover hover:text-ink grid size-8 shrink-0 place-items-center rounded-md transition-colors [&_svg]:size-4";
  const currentTitle = chats.find((c) => c.id === current)?.title || t("taskChat.newChat");
  // Which conversation is open (a menu of the earlier ones) and a new one; on phones also the way back and the title.
  const bar = (
    <div className={cx("flex min-h-11 min-w-0 items-center gap-1", phone ? "border-hairline border-b pb-1" : "border-hairline border-b px-3 sm:px-4")}>
      {phone ? (
        <>
          <button type="button" className={iconBtn} onClick={onClose} aria-label={t("taskChat.back")}>
            <ChevronLeftIcon />
          </button>
          <span aria-hidden="true" className="bg-violet-wash text-violet-text grid size-6 shrink-0 place-items-center rounded-md [&_svg]:size-3.5">
            <SparkleIcon />
          </span>
          <p className="text-ink m-0 mr-1 shrink-0 text-sm font-semibold">{t("taskChat.titleOf", { code })}</p>
        </>
      ) : null}
      <span className="min-w-0 flex-1">
        {chats.length ? (
          <Menu
            label={t("taskChat.history")}
            items={chats.map((c) => ({
              label: `${c.title || t("taskChat.newChat")} · ${ago(c.lastAt)}`,
              icon: c.id === current ? <ChatIcon /> : <ClockIcon />,
              onSelect: () => void open(c.id),
            }))}
            trigger={
              <span className="text-ink-2 hover:bg-hover hover:text-ink inline-flex h-8 min-w-0 max-w-full items-center gap-1.5 rounded-md px-2 text-[13px] transition-colors [&_svg]:size-3.5 [&_svg]:shrink-0">
                <ListIcon />
                <span className="truncate">{currentTitle}</span>
                <ChevronDownIcon />
              </span>
            }
          />
        ) : null}
      </span>
      {current ? (
        <>
          <button type="button" className={iconBtn} onClick={fresh} title={t("taskChat.newChat")} aria-label={t("taskChat.newChat")}>
            <PlusIcon />
          </button>
          <Menu
            align="right"
            label={t("taskChat.more")}
            items={[{ label: t("taskChat.deleteChat"), danger: true, icon: <TrashIcon />, onSelect: () => void remove() }]}
            trigger={
              <span className={iconBtn}>
                <MoreIcon />
              </span>
            }
          />
        </>
      ) : null}
    </div>
  );

  const starters = [t("taskChat.starters.explain"), t("taskChat.starters.steps"), t("taskChat.starters.similar"), t("taskChat.starters.stuck")];
  const welcome = (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4 py-4">
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="bg-violet-wash text-violet-text ring-current/10 grid size-9 shrink-0 place-items-center rounded-lg ring-1 ring-inset [&_svg]:size-[18px]"
        >
          <SparkleIcon />
        </span>
        <div className="min-w-0">
          <p className="text-ink m-0 text-sm font-semibold">{t("taskChat.emptyTitle", { code })}</p>
          <p className="text-ink-2 m-0 mt-0.5 text-[13px]/5">{t("taskChat.emptyBody")}</p>
        </div>
      </div>
      <ul className="border-hairline divide-hairline m-0 grid list-none divide-y overflow-hidden rounded-lg border p-0" aria-label={t("taskChat.starterLabel")}>
        {starters.map((s, i) => (
          <li key={s}>
            <button
              type="button"
              onClick={() => fill(s)}
              className="text-ink hover:bg-hover group flex min-h-10 w-full items-center gap-2.5 px-3 text-left text-[13px] transition-colors"
            >
              <span className="min-w-0 flex-1 truncate">{i === 3 ? `${s.trim()}…` : s}</span>
              <ArrowRightIcon className="text-ink-2 size-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
            </button>
          </li>
        ))}
      </ul>
      <TaskRelated taskId={taskId} code={code} compact />
    </div>
  );

  let body: React.ReactNode;
  if (state === "noAccess")
    body = (
      <div className="grid gap-3 px-4 py-4 sm:px-5">
        <p className="text-ink-2 m-0 text-xs">{t("taskChat.noAccess")}</p>
        <TaskRelated taskId={taskId} code={code} />
      </div>
    );
  else if (state === "failed")
    body = (
      <p role="status" className="text-ink-2 m-0 flex items-center gap-2 px-4 py-4 text-sm sm:px-5">
        {t("taskChat.loadFailed")}
        <button type="button" className={cx(btn, btnSm)} onClick={() => void open(current ?? undefined)}>
          {t("taskChat.retry")}
        </button>
      </p>
    );
  else
    body = (
      <>
        {phone || chats.length || current ? bar : null}
        <div className={cx("min-h-0 overflow-y-auto overscroll-contain", phone ? "flex-1" : docked ? "flex-1 px-4 sm:px-5" : "max-h-[60vh] px-4 sm:px-5")} aria-live="polite">
          {state === "loading" ? (
            <p className="text-ink-2 m-0 py-6 text-sm" aria-busy="true">
              {t("taskChat.thinking")}
            </p>
          ) : messages.length === 0 ? (
            welcome
          ) : (
            <ol className="m-0 grid list-none grid-cols-[minmax(0,1fr)] gap-5 p-0 py-4">
              {messages.map((m, i) =>
                m.role === "user" ? (
                  <li key={m.id} className="grid justify-items-end pl-8">
                    <div className="bg-accent-wash text-ink max-w-full whitespace-pre-wrap rounded-2xl rounded-tr-md px-3.5 py-2 text-sm/6 [overflow-wrap:anywhere]">
                      {m.content}
                    </div>
                  </li>
                ) : (
                  <li key={m.id} className="grid min-w-0 grid-cols-[24px_minmax(0,1fr)] gap-x-2.5">
                    <span aria-hidden="true" className="bg-violet-wash text-violet-text mt-0.5 grid size-6 place-items-center rounded-md [&_svg]:size-3.5">
                      <SparkleIcon />
                    </span>
                    <AnswerBubble
                      msg={m}
                      last={i === messages.length - 1}
                      onDecide={busy ? undefined : (approve) => void decide(m.id, approve)}
                      onAddSubtasks={(titles) => onAddSubtasks(titles, messages.slice(0, i).findLast((x) => x.role === "user")?.content ?? "")}
                      onAppendDescription={onAppendDescription}
                      onComment={onComment}
                    />
                  </li>
                ),
              )}
            </ol>
          )}
          <div ref={end} />
        </div>
        <div
          className={cx(
            "grid gap-2",
            phone
              ? "pb-[max(12px,env(safe-area-inset-bottom))] pt-2"
              : docked
                ? "border-hairline bg-ground/40 border-t px-3 pb-[max(12px,env(safe-area-inset-bottom))] pt-3 sm:px-4"
                : "border-hairline bg-ground/40 rounded-b-xl border-t px-3 py-3 sm:px-4",
          )}
        >
          {error ? (
            <div role="alert" className="text-block flex flex-wrap items-center gap-2 text-sm">
              <span className="min-w-0 flex-1">{error.text}</span>
              {error.retry ? (
                <button
                  type="button"
                  className={cx(btn, btnSm)}
                  onClick={() => {
                    const v = error.retry!;
                    setText("");
                    void post(v);
                  }}
                >
                  {t("taskChat.retry")}
                </button>
              ) : null}
            </div>
          ) : null}
          {warn ? (
            <div role="alert" className="bg-warn-wash text-warn border-warn/20 flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm">
              <ShieldIcon className="size-4 shrink-0" />
              <span className="min-w-0 flex-1">{t("taskChat.sensitive", { kinds: warn.kinds.map((k) => sensitiveLabel(t, k)).join(", ") })}</span>
              <button type="button" className={cx(btn, btnSm)} onClick={() => setWarn(null)}>
                {t("taskChat.edit")}
              </button>
              <button type="button" className={cx(btn, btnSm)} onClick={() => void send(warn.text, true)}>
                {t("taskChat.sendAnyway")}
              </button>
            </div>
          ) : null}
          <form
            className="bg-surface ring-hairline focus-within:ring-accent/40 flex items-end gap-2 rounded-xl p-1.5 pl-3 shadow-sm ring-1 transition-shadow"
            onSubmit={(e) => {
              e.preventDefault();
              void send(text);
            }}
          >
            <textarea
              ref={box}
              rows={1}
              value={text}
              maxLength={8000}
              aria-label={t("taskChat.input")}
              placeholder={t("taskChat.placeholder", { code })}
              onChange={(e) => {
                setText(e.target.value);
                if (warn) setWarn(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send(text);
                }
              }}
              className="placeholder:text-ink-2 max-h-40 min-h-9 min-w-0 flex-1 resize-none bg-transparent py-1.5 text-sm outline-none [field-sizing:content] max-md:text-base"
            />
            <button
              type="submit"
              disabled={!text.trim() || busy || !canSend}
              aria-label={t("taskChat.send")}
              className="bg-brand text-on-brand hover:bg-brand/90 grid size-8 shrink-0 place-items-center rounded-lg transition-colors disabled:opacity-30"
            >
              <ArrowUpIcon className="size-4" />
            </button>
          </form>
          <p className="text-ink-2 m-0 flex items-center gap-1.5 text-xs" title={t("taskChat.privateNote")}>
            <LockIcon className="size-3 shrink-0" />
            <span className="min-w-0 truncate">{t("taskChat.privateShort")}</span>
          </p>
        </div>
      </>
    );

  if (phone)
    return (
      <Portal>
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t("taskChat.titleOf", { code })}
          className="bg-surface fixed inset-0 z-50 flex flex-col px-3 pt-[max(8px,env(safe-area-inset-top))]"
        >
          {state === "noAccess" || state === "failed" ? (
            <>
              <div className="flex min-h-10 items-center">
                <button type="button" className={iconBtn} onClick={onClose} aria-label={t("taskChat.back")}>
                  <ChevronLeftIcon />
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>
            </>
          ) : (
            body
          )}
        </div>
      </Portal>
    );
  if (docked) return <div className="flex min-h-0 min-w-0 flex-1 flex-col">{body}</div>;
  return <div className="grid min-w-0 grid-cols-[minmax(0,1fr)]">{body}</div>;
}

/** One answer: the text with its citations as links, the sources as chips, then the actions (each asks first). */
function AnswerBubble({
  msg,
  last,
  onDecide,
  onAddSubtasks,
  onAppendDescription,
  onComment,
}: {
  msg: Msg;
  last: boolean;
  onDecide?: ((approve: boolean) => void) | undefined;
  onAddSubtasks: (titles: string[]) => Promise<void>;
  onAppendDescription: (text: string) => Promise<boolean>;
  onComment: (text: string) => Promise<void>;
}) {
  const t = useT();
  const [action, setAction] = useState<Action | null>(null);
  const [done, setDone] = useState<string | null>(null);
  if (msg.pending) return <Thinking label={t("taskChat.thinking")} longLabel={t("taskChat.thinkingLong")} className="text-sm" />;
  const sources = msg.sources ?? [];
  const steps = stepsOf(msg.content);
  const actions: { key: Action; label: string; icon: React.ReactNode }[] = [
    ...(steps.length ? [{ key: "subtasks" as const, label: t("taskChat.actions.subtasks"), icon: <PlusIcon /> }] : []),
    { key: "description", label: t("taskChat.actions.description"), icon: <PencilIcon /> },
    { key: "comment", label: t("taskChat.actions.comment"), icon: <ChatIcon /> },
  ];
  return (
    <div className="group/answer grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2.5">
      {msg.toolCalls?.length ? <ToolChips calls={msg.toolCalls} /> : null}
      {msg.content ? (
        <div className="text-ink text-sm/[1.65] [overflow-wrap:anywhere] [&>div]:text-sm/[1.65] [&_h2]:mt-3 [&_h2]:text-base [&_h3]:mt-3 [&_h3]:text-[15px] [&_p:first-child]:mt-0">
          <Markdown source={linkCitations(msg.content, sources)} />
        </div>
      ) : null}
      {msg.offline ? <p className="text-warn m-0 text-xs">{t("taskChat.offline")}</p> : null}
      {msg.confirm ? <ConfirmCard card={msg.confirm} onDecide={onDecide} /> : null}
      {sources.length ? (
        <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" aria-label={t("taskChat.sources")}>
          {sources.map((s) => (
            <li key={`${s.type}:${s.id}`} className="min-w-0 max-w-full">
              <Link
                href={s.url}
                title={`${t(`taskChat.src.${s.type}`)}: ${s.title}`}
                className="border-hairline bg-surface text-ink-soft hover:bg-hover hover:text-ink flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-sm border px-2 text-xs no-underline transition-colors [&_svg]:size-3.5 [&_svg]:shrink-0"
              >
                {s.n ? <span className="text-ink-2 tabular-nums">{s.n}</span> : null}
                {SRC_ICON[s.type]}
                <span className="truncate">{s.title}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      {msg.content && !msg.confirm ? (
        <div
          className={cx(
            "flex flex-wrap items-center gap-2 transition-opacity",
            !last && "opacity-0 focus-within:opacity-100 group-hover/answer:opacity-100 [@media(hover:none)]:opacity-100",
          )}
        >
          <Menu
            label={t("taskChat.actionsLabel")}
            items={actions.map((a) => ({
              label: a.label,
              icon: a.icon,
              onSelect: () => {
                setDone(null);
                setAction(a.key);
              },
            }))}
            trigger={
              <span className="border-hairline text-ink-soft hover:bg-hover hover:text-ink inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs font-medium transition-colors [&_svg]:size-3.5">
                <PlusIcon />
                {t("taskChat.actionsLabel")}
                <ChevronDownIcon />
              </span>
            }
          />
          {done ? (
            <span className="text-ok text-xs" role="status">
              {done}
            </span>
          ) : null}
        </div>
      ) : null}
      {action ? (
        <ConfirmAction
          key={action}
          action={action}
          text={plainAnswer(msg.content)}
          steps={steps}
          onCancel={() => setAction(null)}
          onDone={(m) => {
            setAction(null);
            setDone(m);
          }}
          onAddSubtasks={onAddSubtasks}
          onAppendDescription={onAppendDescription}
          onComment={onComment}
        />
      ) : null}
    </div>
  );
}

/** What an action will write, editable, and nothing happens until "Xác nhận". */
function ConfirmAction({
  action,
  text,
  steps,
  onCancel,
  onDone,
  onAddSubtasks,
  onAppendDescription,
  onComment,
}: {
  action: Action;
  text: string;
  steps: string[];
  onCancel: () => void;
  onDone: (message: string) => void;
  onAddSubtasks: (titles: string[]) => Promise<void>;
  onAppendDescription: (text: string) => Promise<boolean>;
  onComment: (text: string) => Promise<void>;
}) {
  const t = useT();
  const [picked, setPicked] = useState<string[]>(steps);
  const [value, setValue] = useState(text);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  // The card opens under the answer, often below the fold of the chat's scroll box.
  useEffect(() => card.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }), []);
  const apply = async () => {
    setSaving(true);
    setFailed(false);
    try {
      if (action === "subtasks") {
        await onAddSubtasks(picked);
        onDone(t("taskChat.done.subtasks", { count: picked.length }));
      } else if (action === "description") {
        if (!(await onAppendDescription(value.trim()))) throw new Error("not saved");
        onDone(t("taskChat.done.description"));
      } else {
        await onComment(value.trim());
        onDone(t("taskChat.done.comment"));
      }
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };
  const title = t(`taskChat.confirm.${action}`);
  const disabled = saving || (action === "subtasks" ? !picked.length : !value.trim());
  return (
    <div ref={card} role="group" aria-label={title} className="border-hairline bg-surface shadow-card grid gap-2.5 rounded-xl border p-3">
      <p className="text-ink m-0 text-[13px] font-medium">{title}</p>
      {action === "subtasks" ? (
        <ul className="m-0 grid list-none gap-1 p-0">
          {steps.map((s, i) => (
            <li key={`${i}-${s}`}>
              <Checkbox
                checked={picked.includes(s)}
                onChange={(e) => {
                  const on = e.target.checked;
                  setPicked((p) => (on ? [...p, s] : p.filter((x) => x !== s)));
                }}
                label={s}
              />
            </li>
          ))}
        </ul>
      ) : (
        <>
          <textarea aria-label={title} value={value} maxLength={10000} onChange={(e) => setValue(e.target.value)} rows={5} className={cx(input, "min-h-28 py-2 text-[13px]/5")} />
        </>
      )}
      {failed ? (
        <p className="text-block m-0 text-xs" role="alert">
          {t("taskChat.actionFailed")}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={cx(btnPrimary, btnSm)} disabled={disabled} onClick={() => void apply()}>
          {t("taskChat.confirm.apply")}
        </button>
        <button type="button" className={cx(btn, btnSm)} onClick={onCancel}>
          {t("taskChat.confirm.cancel")}
        </button>
      </div>
    </div>
  );
}
