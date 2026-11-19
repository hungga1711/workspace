"use client";

import { useCanSend } from "@/lib/connection";
import { useDraft, useLeaveWarning } from "@/lib/draft";
import { REACTION_SET, ReactionArt } from "./ReactionArt";
import { transferFiles } from "@/lib/transfer-files";
import { useEffect, useRef, useState } from "react";
import { Avatar } from "@/lib/people";
import { btnPrimary, btnSm, cx, menuItem, popover } from "@/lib/ui";
import { useT } from "@/lib/i18n/client";
import { api } from "@/lib/client";
import {
  ArrowUpIcon,
  AtIcon,
  BoldIcon,
  BotIcon,
  ClockIcon,
  CloseIcon,
  CodeIcon,
  ItalicIcon,
  ListIcon,
  PaperclipIcon,
  QuoteIcon,
  SmileIcon,
  ChartIcon,
} from "@/components/app/icons";
import { Menu } from "@/components/ui/Menu";
import { MarkdownToolbar, continueListOnEnter, markdownShortcut } from "@/components/ui/MarkdownToolbar";
import { CHAT_MAX_BYTES, kb, type Attachment } from "./attachments";
import { COMPOSE_EVENT } from "./compose";

const tool = "grid size-8 place-items-center rounded-md text-ink-soft transition-colors hover:bg-hover hover:text-ink";

interface Pending {
  key: string;
  name: string;
  size: number;
  status: "uploading" | "ready" | "error";
  attachment?: Attachment;
  error?: string;
}

/** What "@AI" is offered to do with one click, where it was typed. */
const CHAT_QUICK = ["summary", "actions", "unanswered", "attention"] as const;
const TASK_QUICK = ["split", "estimate", "history"] as const;

export interface MentionCandidate {
  id: string;
  name: string;
  agent?: boolean;
}

/**
 * Message box with @mention autocomplete. The user sees "@Lan Nguyễn";
 * on send each picked name becomes <@userId>, so mentions survive renames and
 * reach Home as "needs you". Enter sends, Shift+Enter adds a line.
 * `#` suggests tasks (my open ones first, then a search by code or title); a pick inserts the task's code ("T-041"),
 * which every reader sees as a chip and every other path (notifications, search, AI) reads as plain text.
 *
 * `variant="comment"` (task comments) is for longer, considered text: the Markdown toolbar is always there. Keys match
 * chat: Enter posts (inside a list it continues the list), Shift+Enter adds a line, ⌘Enter also posts.
 */
export function Composer({
  id = "composer",
  label: labelProp,
  placeholder,
  candidates,
  onSubmit,
  onTyping,
  autoFocus,
  onUpload,
  draftKey,
  onEditLast,
  onSchedule,
  onPoll,
  variant = "chat",
  maxLength,
  sendLabel,
}: {
  id?: string;
  label?: string;
  placeholder: string;
  candidates: MentionCandidate[];
  onSubmit: (body: string, attachments: Attachment[]) => void;
  onTyping?: () => void;
  autoFocus?: boolean;
  /** Unsent text is kept per conversation (this browser only) and restored on return. */
  draftKey?: string;
  /** ArrowUp in an empty box edits your last message. */
  onEditLast?: () => void;
  /** When set, files can be attached (button, paste or drop) and upload before sending. */
  onUpload?: (file: File) => Promise<Attachment>;
  /** "Gửi sau": when set, text-only messages can be scheduled for later. */
  onSchedule?: (body: string, at: Date) => Promise<void>;
  /** "Bình chọn": when set, the toolbar offers a poll. */
  onPoll?: () => void;
  variant?: "chat" | "comment";
  /** The longest text the place it posts to accepts (a request's question: 2,000). */
  maxLength?: number;
  /** The comment form's button, when "Comment" is not the word (a request: "Ask" or "Reply"). */
  sendLabel?: string;
}) {
  const comment = variant === "comment";
  const t = useT();
  const label = labelProp ?? t("chat.composer.label");
  const [files, setFiles] = useState<Pending[]>([]);
  const addFiles = (list: FileList | File[]) => {
    if (!onUpload) return;
    for (const file of Array.from(list).slice(0, 10)) {
      const key = `${file.name}-${file.size}-${Math.random().toString(36).slice(2, 7)}`;
      if (file.size > CHAT_MAX_BYTES) {
        setFiles((f) => [...f, { key, name: file.name, size: file.size, status: "error", error: t("chat.composer.tooBig") }]);
        continue;
      }
      setFiles((f) => [...f, { key, name: file.name, size: file.size, status: "uploading" }]);
      onUpload(file)
        .then((attachment) => setFiles((f) => f.map((x) => (x.key === key ? { ...x, status: "ready", attachment } : x))))
        .catch((e: { body?: { message?: string } }) =>
          setFiles((f) =>
            f.map((x) =>
              x.key === key ? { ...x, status: "error", error: t(e.body?.message?.includes("not allowed") ? "chat.composer.typeNotAllowed" : "chat.composer.uploadFailed") } : x,
            ),
          ),
        );
    }
  };
  const ready = files.filter((f) => f.status === "ready").map((f) => f.attachment!);
  const uploading = files.some((f) => f.status === "uploading");
  // Read after mount (useDraft): reading storage during render made the server and client HTML differ (React #418).
  const [text, setText] = useDraft(draftKey ?? null);
  // Without a draft key nothing keeps unsent text: ask before the tab closes on it.
  useLeaveWarning(!draftKey && !!text.trim());
  const [emoji, setEmoji] = useState(false);
  // A comment box rests as one quiet line; the toolbar and the button appear once someone starts writing.
  const [active, setActive] = useState(false);
  const pressing = useRef(false);
  const resting = comment && !active && !text.trim() && files.length === 0;
  // Formatting tools stay folded away (a quiet box); the choice is remembered in this browser.
  const [fmt, setFmtRaw] = useState(false);
  useEffect(() => {
    try {
      if (localStorage.getItem("wos_composer_fmt") === "1") setFmtRaw(true);
    } catch {
      /* private mode */
    }
  }, []);
  const setFmt = (v: boolean) => {
    setFmtRaw(v);
    try {
      localStorage.setItem("wos_composer_fmt", v ? "1" : "0");
    } catch {
      /* private mode */
    }
  };
  /** Wraps the selection in a Markdown marker (or inserts a line prefix), keeping the selection. */
  const wrap = (before: string, after = before, linePrefix = false) => {
    const el = ref.current;
    if (!el) return;
    const a = el.selectionStart,
      b = el.selectionEnd;
    const sel = text.slice(a, b);
    let next: string, from: number, to: number;
    if (linePrefix) {
      const start = text.lastIndexOf("\n", a - 1) + 1;
      const block = text
        .slice(start, b)
        .split("\n")
        .map((l, i) => (before === "1. " ? `${i + 1}. ` : before) + l)
        .join("\n");
      next = text.slice(0, start) + block + text.slice(b);
      from = start;
      to = start + block.length;
    } else {
      next = text.slice(0, a) + before + sel + after + text.slice(b);
      from = a + before.length;
      to = from + sel.length;
    }
    setText(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(from, to);
    });
  };
  const insert = (s: string) => {
    const el = ref.current;
    const a = el?.selectionStart ?? text.length;
    const b = el?.selectionEnd ?? text.length;
    const next = text.slice(0, a) + s + text.slice(b);
    setText(next);
    if (s === "@") {
      setQuery("");
      setSel(0);
    }
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(a + s.length, a + s.length);
    });
  };
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [query, setQuery] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  // An AI answer's follow-up lands here (compose.ts): put in the box, caret at its end, never sent by itself.
  const fill = useRef(setText);
  fill.current = setText;
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ id?: string; text?: string }>).detail;
      if (!d || d.id !== id || typeof d.text !== "string") return;
      const text = d.text;
      fill.current(text);
      setActive(true);
      requestAnimationFrame(() => {
        ref.current?.focus();
        ref.current?.setSelectionRange(text.length, text.length);
      });
    };
    window.addEventListener(COMPOSE_EVENT, on);
    return () => window.removeEventListener(COMPOSE_EVENT, on);
  }, [id]);

  const matches =
    query === null
      ? []
      : candidates.filter((c) => c.name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").includes(query.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""))).slice(0, 6);
  const [taskQuery, setTaskQuery] = useState<string | null>(null);
  const tasks = useTaskSuggestions(taskQuery);
  const listLength = matches.length || tasks.length;

  const update = (value: string) => {
    setText(value);
    onTyping?.();
    const caret = ref.current?.selectionStart ?? value.length;
    const before = value.slice(0, caret);
    const m = before.match(/(?:^|\s)@([\p{L}\p{N}_]*)$/u);
    setQuery(m ? m[1]! : null);
    const h = m ? null : before.match(/(?:^|\s)#([\p{L}\p{N}_-]*)$/u);
    setTaskQuery(h ? h[1]! : null);
    setSel(0);
  };

  const choose = (c: MentionCandidate) => {
    const el = ref.current;
    const caret = el?.selectionStart ?? text.length;
    const start = text.slice(0, caret).lastIndexOf("@");
    const next = `${text.slice(0, start)}@${c.name} ${text.slice(caret)}`;
    setText(next);
    if (!c.agent) setPicked((p) => ({ ...p, [c.name]: c.id }));
    setQuery(null);
    requestAnimationFrame(() => {
      el?.focus();
      const pos = start + c.name.length + 2;
      el?.setSelectionRange(pos, pos);
    });
  };

  const chooseTask = (task: TaskHit) => {
    const el = ref.current;
    const caret = el?.selectionStart ?? text.length;
    const start = text.slice(0, caret).lastIndexOf("#");
    const next = `${text.slice(0, start)}${task.code} ${text.slice(caret)}`;
    setText(next);
    setTaskQuery(null);
    requestAnimationFrame(() => {
      el?.focus();
      const pos = start + task.code.length + 1;
      el?.setSelectionRange(pos, pos);
    });
  };

  // Longest names first so "Lan Nguyễn Thị" wins over "Lan".
  const withMentions = (raw: string) =>
    Object.entries(picked)
      .sort((a, b) => b[0].length - a[0].length)
      .reduce((b, [name, id]) => b.split(`@${name}`).join(`<@${id}>`), raw);
  const canSend = useCanSend();
  const send = () => {
    const body = withMentions(text.trim());
    // Offline or signed out the message would be lost after the box clears: keep it (and its draft) until it can go.
    if ((!body && ready.length === 0) || uploading || !canSend) return;
    onSubmit(body, ready);
    setText("");
    setPicked({});
    setFiles([]);
    // A posted comment returns the box to its resting line now: folding it on the next click's blur moved the
    // thread under the pointer, so that click (e.g. the new comment's "⋯") landed on empty space.
    if (comment) {
      setActive(false);
      ref.current?.blur();
    }
  };
  const schedule = async (at: Date) => {
    const body = withMentions(text.trim());
    if (!body || !onSchedule) return;
    await onSchedule(body, at);
    setText("");
    setPicked({});
  };
  const later = () => {
    const now = new Date();
    const at8 = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 8, 0, 0);
    return [
      { label: t("chat.composer.later1h"), at: new Date(now.getTime() + 3600_000) },
      { label: t("chat.composer.laterTomorrow"), at: at8(new Date(now.getTime() + 86400_000)) },
      { label: t("chat.composer.laterMonday"), at: at8(new Date(now.getTime() + ((8 - now.getDay()) % 7 || 7) * 86400_000)) },
    ];
  };

  // Say up front where the message goes: @AI answers privately and nothing is posted to the channel.
  const toAi = candidates.find((c) => c.agent && text.toLowerCase().startsWith(`@${c.name.toLowerCase()} `));
  // Just "@AI " typed: a few things to hand it here (a channel: the conversation; a task's comments: the task), each
  // only filling the box so the person can add to it before sending.
  const aiQuick = toAi?.id === "ai" && text.trim().toLowerCase() === `@${toAi.name.toLowerCase()}` ? (comment ? TASK_QUICK : CHAT_QUICK) : null;

  const KEYS = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (comment) {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        send();
        return;
      }
      // Same keys as chat: Enter posts, Shift+Enter adds a line; inside a list Enter continues the list.
      if (continueListOnEnter(e, text, setText)) return;
      if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        send();
        return;
      }
      markdownShortcut(e, text, setText);
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
      e.preventDefault();
      wrap("**");
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "i") {
      e.preventDefault();
      wrap("_");
      return;
    }
    if (e.key === "ArrowUp" && !text && onEditLast) {
      e.preventDefault();
      onEditLast();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="relative">
      {matches.length > 0 ? (
        <ul role="listbox" aria-label={t("chat.composer.mentionSuggestions")} className={cx(popover, "absolute bottom-full left-0 z-20 mb-1.5 w-72 list-none")}>
          {matches.map((c, i) => (
            <li key={c.id} role="option" aria-selected={i === sel}>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(c);
                }}
                className={cx(menuItem, "px-2", i === sel && "bg-brand-wash hover:bg-brand-wash")}
              >
                {c.agent ? (
                  <span className="bg-hover text-ink-2 grid size-6 place-items-center rounded-md">
                    <BotIcon className="size-3.5" />
                  </span>
                ) : (
                  <Avatar id={c.id} size="sm" />
                )}
                <span className="flex-1 truncate">{c.name}</span>
                {c.agent ? <span className="text-ink-2 text-xs">{t(c.id === "ai" ? "chat.composer.askAi" : "chat.composer.agent")}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : aiQuick && toAi ? (
        <div role="group" aria-label={t("chat.composer.aiQuick.label")} className="absolute bottom-full left-0 z-20 mb-1.5 flex max-w-full flex-wrap items-center gap-1.5">
          {aiQuick.map((k) => (
            <button
              key={k}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                setText(`@${toAi.name} ${t(`chat.composer.aiQuick.${k}`)}`);
                ref.current?.focus();
              }}
              className="bg-surface shadow-card text-ink-soft hover:bg-hover hover:text-ink inline-flex min-h-7 max-w-full items-center rounded-full px-2.5 py-1 text-left text-xs max-md:min-h-8"
            >
              {t(`chat.composer.aiQuick.${k}`)}
            </button>
          ))}
        </div>
      ) : taskQuery !== null && tasks.length > 0 ? (
        <ul role="listbox" aria-label={t("chat.composer.taskSuggestions")} className={cx(popover, "absolute bottom-full left-0 z-20 mb-1.5 w-[min(26rem,100%)] list-none")}>
          <li role="presentation" className="text-ink-2 px-2 pb-1 pt-0.5 text-xs font-medium">
            {taskQuery ? t("chat.composer.tasksMatching") : t("chat.composer.tasksMine")}
          </li>
          {tasks.map((x, i) => (
            <li key={x.code} role="option" aria-selected={i === sel}>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  chooseTask(x);
                }}
                className={cx(menuItem, "px-2", i === sel && "bg-brand-wash hover:bg-brand-wash")}
              >
                <span className="text-ink-2 shrink-0 font-mono text-xs">{x.code}</span>
                <span className="min-w-0 flex-1 truncate">{x.title}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {files.length ? (
        <ul className="m-0 mb-1.5 flex list-none flex-wrap gap-1.5 p-0" aria-label={t("chat.composer.pendingFiles")}>
          {files.map((f) => (
            <li
              key={f.key}
              className={cx(
                "flex items-center gap-2 rounded-md border px-2.5 py-1 text-xs",
                f.status === "error" ? "border-block/40 bg-block-wash text-block" : "border-hairline bg-surface",
              )}
            >
              <span className="max-w-48 truncate">{f.name}</span>
              <span className="text-ink-2">{f.status === "uploading" ? t("chat.composer.uploading") : f.status === "error" ? f.error : kb(f.size)}</span>
              <button
                type="button"
                aria-label={t("chat.composer.remove", { name: f.name })}
                onClick={() => setFiles((x) => x.filter((y) => y.key !== f.key))}
                className="text-ink-2 hover:text-ink"
              >
                <CloseIcon className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div
        className={cx(
          // A hairline ring like Home's cards; typing lifts it (darker ring, long soft shadow), no border or glow ring.
          "bg-surface shadow-card ease-out-soft focus-within:shadow-lift focus-within:hover:shadow-lift transition-shadow duration-200 hover:shadow-[0_0_0_1px_var(--edge)]",
          resting ? "rounded-xl" : "rounded-2xl",
        )}
        onFocus={() => setActive(true)}
        // A press on something in the box that takes no focus (the attach label; any button in Safari) blurs the text
        // with nowhere to go: folding the toolbar away then would remove the control before its click lands.
        onPointerDown={() => (pressing.current = true)}
        onPointerUp={() => (pressing.current = false)}
        onPointerCancel={() => (pressing.current = false)}
        onBlur={(e) => !pressing.current && !e.currentTarget.contains(e.relatedTarget as Node | null) && setActive(false)}
        onDragOver={(e) => {
          if (onUpload) e.preventDefault();
        }}
        onDrop={(e) => {
          const dropped = onUpload ? transferFiles(e.dataTransfer) : [];
          if (dropped.length) {
            e.preventDefault();
            addFiles(dropped);
          }
        }}
      >
        {resting ? null : comment ? (
          <MarkdownToolbar target={ref} value={text} onChange={setText} className="rounded-t-2xl" />
        ) : fmt ? (
          <div className="border-hairline flex items-center gap-0.5 border-b px-2 py-1.5" role="toolbar" aria-label={t("chat.composer.formatting")}>
            <button type="button" className={tool} onClick={() => wrap("**")} aria-label={t("chat.composer.bold")} title={t("chat.composer.boldHint")}>
              <BoldIcon className="size-4" />
            </button>
            <button type="button" className={tool} onClick={() => wrap("_")} aria-label={t("chat.composer.italic")} title={t("chat.composer.italicHint")}>
              <ItalicIcon className="size-4" />
            </button>
            <button type="button" className={tool} onClick={() => wrap("~~")} aria-label={t("chat.composer.strike")} title={t("chat.composer.strike")}>
              <span className="text-sm font-semibold line-through">S</span>
            </button>
            <button
              type="button"
              className={tool}
              onClick={() => (text.slice(ref.current?.selectionStart ?? 0, ref.current?.selectionEnd ?? 0).includes("\n") ? wrap("```\n", "\n```") : wrap("`"))}
              aria-label={t("chat.composer.code")}
              title={t("chat.composer.code")}
            >
              <CodeIcon className="size-4" />
            </button>
            <button type="button" className={tool} onClick={() => wrap("> ", "", true)} aria-label={t("chat.composer.quote")} title={t("chat.composer.quote")}>
              <QuoteIcon className="size-4" />
            </button>
            <button type="button" className={tool} onClick={() => wrap("- ", "", true)} aria-label={t("chat.composer.list")} title={t("chat.composer.list")}>
              <ListIcon className="size-4" />
            </button>
          </div>
        ) : null}
        <label className="sr-only" htmlFor={id}>
          {label}
        </label>
        <textarea
          id={id}
          ref={ref}
          rows={1}
          value={text}
          placeholder={placeholder}
          autoFocus={autoFocus}
          maxLength={maxLength}
          className={cx(
            "placeholder:text-ink-2 block max-h-60 w-full resize-none bg-transparent px-4 pb-2 pt-3.5 text-sm/[1.55] outline-none [field-sizing:content]",
            resting ? "min-h-11 pb-2.5 pt-2.5" : comment ? "min-h-20" : "min-h-14",
          )}
          onChange={(e) => update(e.target.value)}
          onPaste={(e) => {
            const pasted = onUpload ? transferFiles(e.clipboardData) : [];
            if (pasted.length) {
              e.preventDefault();
              addFiles(pasted);
            }
          }}
          onKeyDown={(e) => {
            const suggesting = matches.length > 0 || (taskQuery !== null && tasks.length > 0);
            if (suggesting && listLength > 0) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel((s) => (s + 1) % listLength);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((s) => (s - 1 + listLength) % listLength);
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                if (matches.length) choose(matches[Math.min(sel, matches.length - 1)]!);
                else chooseTask(tasks[Math.min(sel, tasks.length - 1)]!);
                return;
              }
              if (e.key === "Escape") {
                e.stopPropagation();
                setQuery(null);
                setTaskQuery(null);
                return;
              }
            }
            KEYS(e);
          }}
        />
        <div className={cx("relative flex items-center gap-0.5 px-2 pb-2", resting && "hidden")}>
          {onUpload ? (
            <label className={tool + " cursor-pointer"} title={t("chat.composer.attach")}>
              <PaperclipIcon className="size-4" />
              <span className="sr-only">{t("chat.composer.attach")}</span>
              <input
                type="file"
                multiple
                className="sr-only"
                onChange={(e) => {
                  if (e.target.files) addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
            </label>
          ) : null}
          {/* Nobody to mention (a request's thread notifies its two people anyway): no "@" button. */}
          {candidates.length ? (
            <button type="button" className={tool} onClick={() => insert("@")} aria-label={t("chat.composer.mention")} title={t("chat.composer.mention")}>
              <AtIcon className="size-4" />
            </button>
          ) : null}
          <button
            type="button"
            className={cx(tool, emoji && "bg-selected text-ink")}
            data-emoji-toggle
            onClick={() => setEmoji((v) => !v)}
            aria-label={t("chat.composer.insertEmoji")}
            aria-expanded={emoji}
            title={t("chat.composer.emoji")}
          >
            <SmileIcon className="size-4" />
          </button>
          {onPoll ? (
            <button type="button" className={tool} onClick={onPoll} aria-label={t("chat.poll.create")} title={t("chat.poll.create")}>
              <ChartIcon className="size-4" />
            </button>
          ) : null}
          {comment ? null : (
            <button
              type="button"
              className={cx(tool, fmt && "bg-selected text-brand-text")}
              onClick={() => setFmt(!fmt)}
              aria-pressed={fmt}
              aria-label={t("chat.composer.formatting")}
              title={t(fmt ? "chat.composer.hideFormatting" : "chat.composer.showFormatting")}
            >
              <span className="text-sm font-semibold">Aa</span>
            </button>
          )}
          {emoji ? (
            <EmojiGrid
              onPick={(e) => {
                insert(e);
                setEmoji(false);
              }}
              onClose={() => setEmoji(false)}
              className="bottom-full left-0 mb-1"
            />
          ) : null}
          {toAi ? (
            <span className="text-ink-2 ml-2 flex min-w-0 items-center gap-1 truncate text-xs" role="status">
              <BotIcon className="size-3.5 shrink-0" />
              <span className="truncate">{toAi.id === "ai" ? t("chat.composer.toAi") : t("chat.composer.toAgent", { name: toAi.name })}</span>
            </span>
          ) : null}
          {/* The key hint shows only while typing: an empty composer stays quiet. */}
          <span className="text-ink-2 ml-auto hidden pr-2 text-xs md:inline">
            {!text.trim() ? null : comment ? t("chat.composer.commentKeys") : t(text.includes("\n") || text.length > 60 ? "chat.composer.shiftEnter" : "chat.composer.enterToSend")}
          </span>
          {onSchedule && text.trim() && !files.length && !toAi ? (
            <Menu
              label={t("chat.composer.later")}
              align="right"
              items={later().map((o) => ({ label: o.label, onSelect: () => void schedule(o.at) }))}
              trigger={
                <span className="text-ink-soft hover:bg-hover hover:text-ink grid size-8 place-items-center rounded-md transition-colors" title={t("chat.composer.later")}>
                  <ClockIcon className="size-4" />
                </span>
              }
            />
          ) : null}
          {comment ? (
            <button type="button" onClick={send} disabled={(!text.trim() && ready.length === 0) || uploading || !canSend} className={cx(btnPrimary, btnSm, "ml-auto md:ml-0")}>
              {sendLabel ?? t("chat.composer.commentSend")}
            </button>
          ) : (
            <button
              type="button"
              onClick={send}
              disabled={(!text.trim() && ready.length === 0) || uploading || !canSend}
              aria-label={t(toAi ? "chat.composer.ask" : "chat.composer.send")}
              title={t("chat.composer.sendHint")}
              className="bg-brand text-on-brand hover:bg-brand/85 disabled:bg-ink-2/30 ml-auto grid size-8 shrink-0 place-items-center rounded-md transition-colors md:ml-0"
            >
              <ArrowUpIcon className="size-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const EMOJI: ["frequent" | "feelings" | "work", string[]][] = [
  ["frequent", ["👍", "🙏", "❤️", "😂", "🎉", "✅", "👀", "🔥", "💯", "🙌", "👏", "🚀"]],
  ["feelings", ["😀", "😊", "😉", "😍", "🤔", "😅", "😢", "😮", "😴", "🤝", "💪", "👌"]],
  ["work", ["📌", "📎", "📅", "⏰", "📈", "📉", "💡", "⚠️", "❗", "❓", "📝", "🏁"]],
];

/** A small, curated emoji grid: enough for work chat, no heavy picker library. Reactions use it too. */
/** The emoji popover. A press anywhere else or Esc closes it; its own toggle button carries `data-emoji-toggle`, so the
 * press that closes it there is not followed by a click that reopens it. */
export function EmojiGrid({
  onPick,
  onClose,
  className,
  reactions = false,
}: {
  onPick: (e: string) => void;
  onClose: () => void;
  className?: string;
  /** For a reaction: the app's own reaction art (REACTION_SET) instead of the composer's emoji. */
  reactions?: boolean;
}) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: PointerEvent) => {
      const el = e.target as Element;
      if (!box.current?.contains(el) && !el.closest?.("[data-emoji-toggle]")) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key, true);
    };
  }, [onClose]);
  return (
    <div
      ref={box}
      className={cx("bg-surface border-hairline shadow-popover animate-pop absolute z-30 w-[284px] rounded-lg border p-2", className)}
      role="dialog"
      aria-label={t("chat.composer.pickEmoji")}
    >
      {reactions ? (
        <div className="grid grid-cols-6 gap-0.5">
          {REACTION_SET.map((e) => (
            <button key={e} type="button" onClick={() => onPick(e)} className="hover:bg-hover grid size-10 place-items-center rounded-md transition hover:scale-110" aria-label={e}>
              <ReactionArt emoji={e} size={28} />
            </button>
          ))}
        </div>
      ) : null}
      {(reactions ? [] : EMOJI).map(([group, list]) => (
        <div key={group} className="mb-1 last:mb-0">
          <p className="text-ink-2 px-1 pb-0.5 text-xs font-medium">{t(`chat.composer.emojiGroups.${group}`)}</p>
          <div className="grid grid-cols-6 gap-0.5">
            {list.map((e) => (
              <button key={e} type="button" onClick={() => onPick(e)} className="hover:bg-hover grid size-10 place-items-center rounded-md text-lg" aria-label={e}>
                {e}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

interface TaskHit {
  code: string;
  title: string;
  status?: string;
}

/**
 * Tasks for the `#` picker: with nothing typed, my open tasks (the ones people talk about); otherwise the search,
 * which only returns tasks the writer may read. Debounced, and nothing is fetched until `#` is typed.
 */
function useTaskSuggestions(query: string | null): TaskHit[] {
  const [hits, setHits] = useState<TaskHit[]>([]);
  useEffect(() => {
    if (query === null) {
      setHits([]);
      return;
    }
    let live = true;
    const q = query.trim();
    const timer = setTimeout(() => {
      const load: Promise<TaskHit[]> =
        q.length < 2
          ? api<{ tasks: { code: string; title: string; status: string }[] }>("work/tasks").then((r) =>
              r.tasks.filter((x) => x.status !== "done" && x.status !== "cancelled" && (!q || x.code.toLowerCase().includes(q.toLowerCase()))).slice(0, 6),
            )
          : api<{ hits: { entity_type: string; title: string }[] }>(`chat/search?types=task&q=${encodeURIComponent(q)}`).then((r) =>
              r.hits
                .filter((h) => h.entity_type === "task")
                .map((h) => {
                  // The index stores "T-041 Title": the code is the first word.
                  const [code = "", ...rest] = h.title.split(" ");
                  return { code, title: rest.join(" ") };
                })
                .filter((x) => x.code)
                .slice(0, 6),
            );
      load.then((list) => live && setHits(list)).catch(() => live && setHits([]));
    }, 180);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query]);
  return hits;
}
