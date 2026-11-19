"use client";

import { Thinking } from "@/components/ui/Thinking";

import {
  ActionBarPrimitive,
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useFormat, useT } from "@/lib/i18n/client";
import { Markdown } from "@/lib/markdown";
import { cx } from "@/lib/ui";
import { BrandMark } from "@/components/ui/BrandMark";
import { Picker } from "@/components/ui/Picker";
import { ArrowDownIcon, ArrowUpIcon, AtIcon, CheckIcon, CopyIcon, PaperclipIcon, RefreshIcon } from "@/components/app/icons";
import { ACCEPT, mentionAt, MentionMenu, PendingChips, SentExtras, type AskFile, type AskRef } from "./AskExtras";
import { mayBeRef, refFromDrop, refFromUrl } from "@/lib/ask-context";
import type { AssistantModel } from "./AssistantView";
import { dayBreaks } from "./chatHistory";
import { closeOpenMarks, splitBlocks } from "./reveal";
import { ConfirmCard, SourceChips, ToolChips, type PendingCard, type Source, type ToolChip } from "./McpToolBits";
import dynamic from "next/dynamic";
import { cardsOf, type AnswerBlock } from "./answer/types";
import { AnswerNotes, AnswerProgress, type AnswerStep } from "./AnswerProgress";
import { NextSteps } from "./answer/NextSteps";

// Charts, tables, cards and next steps under an answer: loaded with the first answer that has any of them.
const AnswerExtras = dynamic(() => import("./answer/AnswerExtras"), { ssr: false });

export interface Msg {
  id: string;
  role: "user" | "assistant";
  content: string;
  pending?: boolean;
  /** The hosted model failed over to the offline one: a shorter, extractive answer. */
  offline?: boolean;
  /** Outside (MCP) tools the answer used. */
  tools?: ToolChip[];
  /** A tool waiting for the person's yes before the answer goes on. */
  confirm?: PendingCard;
  /** What the answer read in the workspace (tasks, pages, meetings…), linked under it. */
  sources?: Source[];
  /** Charts and tables of what its tools read (answer/types.ts). */
  blocks?: AnswerBlock[];
  /** A question's images and files, and the work it pointed at with @. */
  files?: AskFile[];
  refs?: AskRef[];
  /** When it was sent (ISO); the server's time once the thread reloads. */
  at?: string;
  /** What the AI did (live while it answers), what limits the answer, and what to ask next. */
  steps?: AnswerStep[];
  notes?: string[];
  followUps?: string[];
}

/** What goes with the next question, owned by AssistantView. */
export interface Extras {
  files: AskFile[];
  refs: AskRef[];
  addFiles: (list: File[]) => void;
  removeFile: (key: string) => void;
  addRef: (r: AskRef) => void;
  removeRef: (r: AskRef) => void;
  /** The person's open tasks, offered first by @. */
  myTasks: { id: string; code?: string | null; title: string }[];
}

/** What the last answer's action row carries besides "copy": "Trả lời lại" and "AI có giúp không?". */
const LastAnswer = createContext<{
  regenerate?: (() => void) | undefined;
  decide?: ((msgId: string, approve: boolean) => void | Promise<unknown>) | undefined;
  /** Puts a follow-up in the composer (a drill in a chart, a next step under an answer). */
  ask?: ((text: string) => void) | undefined;
  /** No hosted AI: every answer is the built-in lookup, and says so under it. */
  builtIn?: boolean;
}>({});

/** Our messages as assistant-ui sees them; `custom` carries what the bubbles need beyond the text. */
const convert = (m: Msg, dayBreak: boolean): ThreadMessageLike => ({
  id: m.id,
  role: m.role,
  // While the answer is written its text shows as it comes; before the first word, the thinking dots.
  content: m.pending && !m.content ? [] : [{ type: "text", text: m.content }],
  ...(m.role === "assistant" ? { status: m.pending ? { type: "running" as const } : { type: "complete" as const, reason: "stop" as const } } : {}),
  metadata: {
    custom: {
      id: m.id,
      pending: !!m.pending && !m.content,
      writing: !!m.pending && !!m.content,
      offline: !!m.offline,
      tools: m.tools ?? [],
      confirm: m.confirm ?? null,
      sources: m.sources ?? [],
      blocks: m.blocks ?? [],
      steps: m.steps ?? [],
      notes: m.notes ?? [],
      followUps: m.followUps ?? [],
      files: m.files ?? [],
      refs: m.refs ?? [],
      at: m.at ?? null,
      dayBreak,
    },
  },
});

/**
 * The conversation itself, on assistant-ui's primitives (thread, messages, composer, action bar) over our own
 * state: AssistantView owns the messages and the API calls, this renders them. Loaded only on /app/ai.
 */
export default function AssistantThread({
  messages,
  busy,
  onSend,
  models,
  route,
  setRoute,
  above,
  footer,
  onDraftChange,
  draft,
  onRegenerate,
  welcome,
  onDecide,
  onStop,
  extras,
  builtIn = false,
}: {
  messages: Msg[];
  busy: boolean;
  /** Returns false when the text was held back (sensitive data): the composer gets it back. */
  onSend: (text: string) => Promise<boolean>;
  models: AssistantModel[];
  route: string;
  setRoute: (route: string) => void;
  /** Alerts above the composer (errors, budget, sensitive-data warning). */
  above: ReactNode;
  footer: ReactNode;
  onDraftChange: (text: string) => void;
  /** Text to put back into the composer (held back, failed, or picked from a suggestion). */
  draft: { text: string; n: number } | null;
  /** A new answer to the last question; absent when it would only repeat itself (the built-in model). */
  onRegenerate?: (() => void) | undefined;
  /** The empty thread: what to ask, the person's work and the agent workflows (AskWelcome), around the composer. */
  welcome: (composer: ReactNode) => ReactNode;
  /** The confirm card's answer for an outside tool that asks before it runs. */
  onDecide?: ((msgId: string, approve: boolean) => void | Promise<unknown>) | undefined;
  /** Stops the answer being written (it keeps what is there); absent while nothing is streamed. */
  onStop?: (() => void) | undefined;
  extras: Extras;
  /** No hosted AI: answers are the built-in lookups (NoAiNotice says it at the top, each answer under it). */
  builtIn?: boolean;
}) {
  const breaks = useMemo(() => dayBreaks(messages), [messages]);
  const convertMessage = useCallback((m: Msg) => convert(m, breaks.has(m.id)), [breaks]);
  const runtime = useExternalStoreRuntime<Msg>({
    messages,
    isRunning: busy,
    convertMessage,
    unstable_capabilities: { copy: true },
    ...(onStop ? { onCancel: async () => onStop() } : {}),
    onNew: async (m: AppendMessage) => {
      const text = m.content
        .map((p) => (p.type === "text" ? p.text : ""))
        .join("")
        .trim();
      if (text && !(await onSend(text))) runtime.thread.composer.setText(text);
    },
  });
  const ask = useCallback(
    (text: string) => {
      runtime.thread.composer.setText(text);
      const box = document.querySelector<HTMLTextAreaElement>("[data-ask-input]");
      if (box)
        requestAnimationFrame(() => {
          box.focus();
          box.setSelectionRange(text.length, text.length);
        });
    },
    [runtime],
  );
  useEffect(() => {
    if (!draft) return;
    runtime.thread.composer.setText(draft.text);
    // A picked starter is half a sentence: the cursor goes to its end, ready for the rest.
    const box = document.querySelector<HTMLTextAreaElement>("[data-ask-input]");
    if (box && draft.text && window.matchMedia("(pointer: fine)").matches) requestAnimationFrame(() => box.focus());
  }, [draft, runtime]);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <LastAnswer.Provider value={{ regenerate: busy ? undefined : onRegenerate, decide: busy ? undefined : onDecide, ask, builtIn }}>
        <Thread
          models={models}
          route={route}
          setRoute={setRoute}
          above={above}
          footer={footer}
          onDraftChange={onDraftChange}
          welcome={welcome}
          empty={messages.length === 0}
          stoppable={!!onStop}
          extras={extras}
          setText={(text) => runtime.thread.composer.setText(text)}
        />
      </LastAnswer.Provider>
    </AssistantRuntimeProvider>
  );
}

function Thread({
  models,
  route,
  setRoute,
  above,
  footer,
  onDraftChange,
  welcome,
  empty,
  stoppable,
  extras,
  setText,
}: {
  models: AssistantModel[];
  route: string;
  setRoute: (route: string) => void;
  above: ReactNode;
  footer: ReactNode;
  onDraftChange: (text: string) => void;
  welcome: (composer: ReactNode) => ReactNode;
  /** No message yet: the composer sits in the middle of the page, under the greeting, instead of at the foot. */
  empty: boolean;
  /** An answer is being written: the send button becomes stop. */
  stoppable: boolean;
  extras: Extras;
  setText: (text: string) => void;
}) {
  const t = useT();
  const text = useAuiState((s) => s.composer.text);
  useEffect(() => onDraftChange(text), [text, onDraftChange]);
  // @ picker: open while the caret sits right after "@query"; Escape closes it until the text changes.
  const [caret, setCaret] = useState(0);
  const [closedAt, setClosedAt] = useState<string | null>(null);
  const mention = closedAt === text ? null : mentionAt(text, caret);
  const keys = useRef<((e: React.KeyboardEvent) => boolean) | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const box = () => document.querySelector<HTMLTextAreaElement>("[data-ask-input]");
  const pick = (r: AskRef) => {
    if (!mention) return;
    const token = `@${r.code || r.label} `;
    const next = text.slice(0, mention.start) + token + text.slice(caret);
    setText(next);
    extras.addRef(r);
    const at = mention.start + token.length;
    setCaret(at);
    requestAnimationFrame(() => {
      const el = box();
      el?.focus();
      el?.setSelectionRange(at, at);
    });
  };
  /** The "@" button: starts a mention where the caret is, as typing it would. */
  const startMention = () => {
    const el = box();
    const at = el?.selectionStart ?? text.length;
    const before = text.slice(0, at);
    const insert = before && !/\s$/.test(before) ? " @" : "@";
    setText(before + insert + text.slice(at));
    const next = at + insert.length;
    setCaret(next);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(next, next);
    });
  };
  // Focus the composer with a mouse and keyboard; on touch screens that would throw the keyboard over the page.
  const [focus, setFocus] = useState(false);
  useEffect(() => setFocus(window.matchMedia("(pointer: fine)").matches), []);
  const composer = (
    <>
      {above}
      <ComposerPrimitive.Root
        className={cx(
          "bg-surface border-hairline focus-within:border-ink/30 focus-within:ring-selected relative rounded-2xl border px-1 pt-1 transition-shadow focus-within:ring-[3px]",
          empty && "shadow-hero border-transparent",
          dragging && "border-brand-text ring-selected ring-[3px]",
        )}
        onDragOver={(e) => {
          // Files, and a task, page, message or person dragged from the app (or a link to one).
          if (!e.dataTransfer.types.includes("Files") && !mayBeRef(e.dataTransfer.types)) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(e) => {
          setDragging(false);
          if (e.dataTransfer.files.length) {
            e.preventDefault();
            extras.addFiles(Array.from(e.dataTransfer.files));
            return;
          }
          const ref = refFromDrop(e.dataTransfer, window.location.origin);
          if (!ref) return;
          e.preventDefault();
          extras.addRef(ref);
        }}
      >
        {mention ? <MentionMenu query={mention.query} myTasks={extras.myTasks} onPick={pick} keys={keys} /> : null}
        <PendingChips files={extras.files} refs={extras.refs} onRemoveFile={extras.removeFile} onRemoveRef={extras.removeRef} />
        <ComposerPrimitive.Input
          data-ask-input=""
          aria-label={t("aiw.chat.input")}
          placeholder={t("aiw.chat.placeholder")}
          rows={1}
          autoFocus={focus}
          key={focus ? "focus" : "touch"}
          addAttachmentOnPaste={false}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onKeyDown={(e) => {
            if (!mention) return;
            if (e.key === "Escape") {
              e.preventDefault();
              setClosedAt(text);
              return;
            }
            if (keys.current?.(e)) e.preventDefault();
          }}
          onPaste={(e) => {
            const pasted = Array.from(e.clipboardData.files);
            if (pasted.length) {
              e.preventDefault();
              extras.addFiles(pasted);
              return;
            }
            // A link to a record of this app becomes a chip, not text the model would have to guess from.
            const ref = refFromUrl(e.clipboardData.getData("text/plain"), window.location.origin);
            if (!ref) return;
            e.preventDefault();
            extras.addRef(ref);
          }}
          className={cx("placeholder:text-ink-2 block max-h-60 w-full resize-none bg-transparent px-3 pb-1 pt-2.5 text-sm outline-none", empty ? "min-h-16" : "min-h-12")}
        />
        <div className="flex items-center gap-1 px-2 pb-2">
          <input
            ref={fileInput}
            type="file"
            multiple
            accept={ACCEPT}
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) extras.addFiles(Array.from(e.target.files));
              e.target.value = "";
            }}
          />
          <button type="button" className={toolBtn} aria-label={t("aiw.chat.extras.attach")} title={t("aiw.chat.extras.attachHint")} onClick={() => fileInput.current?.click()}>
            <PaperclipIcon />
          </button>
          <button type="button" className={toolBtn} aria-label={t("aiw.chat.extras.mention")} title={t("aiw.chat.extras.mentionHint")} onClick={startMention} data-ask-mention="">
            <AtIcon />
          </button>
          {models.length > 1 ? (
            <Picker
              variant="property"
              label={t("aiw.chat.model")}
              value={route}
              onChange={setRoute}
              options={models.map((m) => ({ value: m.route, label: m.label }))}
              // The composer sits at the bottom of the screen: open the list upwards.
              side="top"
              className="text-ink-2 w-auto text-xs"
            />
          ) : (
            <span className="text-ink-2 truncate px-2 text-xs">{models[0]?.label ?? t("aiw.chat.offline")}</span>
          )}
          <span className="flex-1" />
          {stoppable ? (
            <ComposerPrimitive.Cancel
              aria-label={t("aiw.chat.stop")}
              title={t("aiw.chat.stop")}
              className="bg-ink text-surface hover:bg-ink/85 grid size-8 place-items-center rounded-full transition-[background-color,transform] active:scale-95"
            >
              <span className="size-2.5 rounded-[2px] bg-current" />
            </ComposerPrimitive.Cancel>
          ) : (
            <ComposerPrimitive.Send
              aria-label={t("aiw.chat.send")}
              className="bg-brand text-on-brand hover:bg-brand/90 grid size-8 place-items-center rounded-full transition-[background-color,transform] active:scale-95 disabled:opacity-30"
            >
              <ArrowUpIcon className="size-4" />
            </ComposerPrimitive.Send>
          )}
        </div>
      </ComposerPrimitive.Root>
      {footer}
    </>
  );
  return (
    <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col">
      {/* An empty thread stays where it opens (the greeting on top); a conversation follows its last message. */}
      <ThreadPrimitive.Viewport autoScroll={!empty} className="min-h-0 flex-1 overflow-y-auto">
        {empty ? (
          <div className="mx-auto flex min-h-full max-w-[720px] flex-col justify-center px-4 pb-6 pt-10 max-sm:pt-6 md:px-6">{welcome(composer)}</div>
        ) : (
          // One shrinkable column: a wide table or code line scrolls in its own box instead of widening the thread.
          <div className="mx-auto grid max-w-[720px] grid-cols-1 gap-6 px-4 pb-4 pt-8 md:px-6">
            <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
          </div>
        )}
      </ThreadPrimitive.Viewport>

      {empty ? null : (
        <div className="relative mx-auto w-full max-w-[720px] px-4 pb-4 md:px-6">
          <ThreadPrimitive.ScrollToBottom
            aria-label={t("aiw.chat.toBottom")}
            className="border-hairline bg-surface text-ink hover:bg-hover shadow-popover absolute -top-12 left-1/2 grid size-8 -translate-x-1/2 place-items-center rounded-full border disabled:invisible"
          >
            <ArrowDownIcon className="size-4" />
          </ThreadPrimitive.ScrollToBottom>
          {composer}
        </div>
      )}
    </ThreadPrimitive.Root>
  );
}

function UserMessage() {
  const custom = useAuiState((s) => s.message.metadata.custom) as { files?: AskFile[]; refs?: AskRef[]; at?: string | null; dayBreak?: boolean };
  return (
    <MessagePrimitive.Root className="grid justify-items-end gap-1.5">
      {custom.dayBreak && custom.at ? <DayBreak at={custom.at} /> : null}
      <SentExtras files={custom.files} refs={custom.refs} />
      <div className="bg-hover max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md px-4 py-2.5 text-[14px]/[1.6] [overflow-wrap:anywhere]" data-role="user">
        <MessagePrimitive.Parts />
      </div>
      {custom.at ? <Stamp at={custom.at} className="px-1" /> : null}
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  const t = useT();
  const custom = useAuiState((s) => s.message.metadata.custom) as {
    id?: string;
    pending?: boolean;
    writing?: boolean;
    offline?: boolean;
    tools?: ToolChip[];
    confirm?: PendingCard | null;
    sources?: Source[];
    blocks?: AnswerBlock[];
    steps?: AnswerStep[];
    notes?: string[];
    followUps?: string[];
    at?: string | null;
    dayBreak?: boolean;
  };
  const last = useAuiState((s) => s.message.isLast);
  const extras = useContext(LastAnswer);
  const done = !custom.pending && !custom.writing;
  // Named tasks, people, pages and meetings become cards; the rest of what it read stays as small links.
  const cards = done ? cardsOf(custom.sources) : [];
  const carded = new Set(cards.map((x) => `${x.type}:${x.id}`));
  const blocks = custom.blocks ?? [];
  const rich = done && (blocks.length > 0 || cards.length > 0);
  return (
    <MessagePrimitive.Root className="group grid min-w-0 grid-cols-1 gap-x-3 gap-y-1.5 sm:grid-cols-[1.75rem_minmax(0,1fr)]">
      {custom.dayBreak && custom.at ? <DayBreak at={custom.at} /> : null}
      {/* The app's mark in the gutter says who answers; it breathes while the answer is on its way. */}
      <BrandMark className={cx("row-span-2 mt-px size-7 self-start max-sm:hidden", (custom.pending || custom.writing) && "motion-safe:animate-pulse")} />
      <div className="min-w-0 text-sm/[1.65] [overflow-wrap:anywhere] sm:pt-0.5" data-role="assistant" aria-busy={custom.pending || custom.writing || undefined}>
        {/* Its steps say which tools it used, in words: the chips only for an answer without them (older ones). */}
        {custom.steps?.length ? <AnswerProgress steps={custom.steps} live={!done} /> : custom.tools?.length ? <ToolChips calls={custom.tools} /> : null}
        {custom.pending ? <Thinking label={t("aiw.chat.thinking")} longLabel={t("aiw.chat.thinkingLong")} /> : <MessagePrimitive.Parts components={ANSWER_PARTS} />}
        {rich ? <AnswerExtras blocks={blocks} cards={cards} onAsk={extras.ask} /> : null}
        {done ? <SourceChips sources={custom.sources?.filter((x) => !carded.has(`${x.type}:${x.id}`))} /> : null}
        {done ? <AnswerNotes notes={custom.notes} /> : null}
        {custom.offline ? <p className="text-warn m-0 mt-2 text-xs">{t("aiw.chat.offlineNote")}</p> : null}
        {extras.builtIn && done && !custom.offline && !custom.confirm ? <p className="text-ink-2 m-0 mt-2 text-xs">{t("aiw.noAi.note")}</p> : null}
        {/* Next steps only under the last answer: an older one's would act on a conversation that has moved on. */}
        {done && last && !custom.confirm ? <NextSteps tools={custom.tools} followUps={custom.followUps} onPick={extras.ask} /> : null}
        {custom.confirm && !custom.pending ? (
          <ConfirmCard card={custom.confirm} onDecide={extras.decide && custom.id ? (approve) => extras.decide!(custom.id!, approve) : undefined} />
        ) : null}
      </div>
      {custom.pending || custom.writing ? null : (
        <ActionBarPrimitive.Root
          hideWhenRunning
          autohide="not-last"
          autohideFloat="single-branch"
          className="text-ink-2 -ml-2 flex min-h-8 flex-wrap items-center gap-0.5 transition-opacity data-[floating]:opacity-0 data-[floating]:focus-within:opacity-100 data-[floating]:group-hover:opacity-100"
        >
          <ActionBarPrimitive.Copy aria-label={t("aiw.chat.copy")} title={t("aiw.chat.copy")} className={cx(actionBtn, "group/copy")}>
            <CopyIcon className="group-data-[copied]/copy:hidden" />
            <CheckIcon className="hidden group-data-[copied]/copy:block" />
          </ActionBarPrimitive.Copy>
          {last && extras.regenerate ? (
            <button type="button" aria-label={t("aiw.chat.regenerate")} title={t("aiw.chat.regenerate")} className={actionBtn} onClick={extras.regenerate}>
              <RefreshIcon />
            </button>
          ) : null}
          {custom.at ? <Stamp at={custom.at} className="px-2" /> : null}
        </ActionBarPrimitive.Root>
      )}
    </MessagePrimitive.Root>
  );
}

/**
 * An answer's text. While it is written (the brand mark pulses meanwhile), it is drawn block by block: the blocks
 * already finished stay as they are and only the last one is drawn again as words are added. Once complete, in one
 * piece. A stable component, so the text is not mounted afresh on every update.
 */
function AnswerText({ text }: { text: string }) {
  const t = useT();
  const writing = useAuiState((s) => !!(s.message.metadata.custom as { writing?: boolean }).writing);
  const label = t("aiw.chat.copyCode");
  const done = t("aiw.chat.copiedCode");
  if (!writing) return <Markdown source={text} copyCode={{ label, done }} />;
  const blocks = splitBlocks(text);
  return (
    <>
      {blocks.map((b, i) => (
        <AnswerBlock key={i} source={i === blocks.length - 1 ? closeOpenMarks(b) : b} label={label} done={done} />
      ))}
    </>
  );
}
const AnswerBlock = memo(function AnswerBlock({ source, label, done }: { source: string; label: string; done: string }) {
  return <Markdown source={source} copyCode={{ label, done }} />;
});
const ANSWER_PARTS = { Text: AnswerText };

/** A message's time ("14:05", "Yesterday 14:05"), the full date and time on hover. */
function Stamp({ at, className }: { at: string; className?: string }) {
  const { stamp, dateTime } = useFormat();
  return (
    <time dateTime={at} title={dateTime(at)} className={cx("text-ink-2 text-xs tabular-nums", className)}>
      {stamp(at)}
    </time>
  );
}

/** The day a thread moves on to, as a rule across it ("Today", "Monday, 9/11"). */
function DayBreak({ at }: { at: string }) {
  const { dayLabel } = useFormat();
  return (
    <div className="text-ink-2 col-span-full flex items-center gap-3 justify-self-stretch text-xs font-medium" role="separator">
      <span className="bg-divider h-px flex-1" />
      <time dateTime={at}>{dayLabel(at)}</time>
      <span className="bg-divider h-px flex-1" />
    </div>
  );
}

const actionBtn = "hover:bg-hover hover:text-ink grid size-8 place-items-center rounded-md transition-colors [&_svg]:size-4";
const toolBtn = "text-ink-2 hover:bg-hover hover:text-ink grid size-8 shrink-0 place-items-center rounded-md transition-colors [&_svg]:size-4";
