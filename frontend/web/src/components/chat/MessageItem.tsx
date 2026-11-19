"use client";

import { useState } from "react";
import { useFormat } from "@/lib/i18n/client";
import { Avatar, useDirectory } from "@/lib/people";
import { btn, btnPrimary, cx, input } from "@/lib/ui";
import { BookmarkIcon, BotIcon, ChevronRightIcon, ClockIcon, ForwardIcon, MoreIcon, PinIcon, SmileIcon, ThreadIcon, TranslateIcon } from "@/components/app/icons";
import { Menu, type MenuItem } from "@/components/ui/Menu";
import { StatusBadge } from "@/components/app/Status";
import { PersonTrigger } from "./PersonTrigger";
import { ReactionArt } from "./ReactionArt";
import { RichText } from "./RichText";
import { AttachmentList } from "./attachments";
import { LinkPreviews } from "./LinkPreviews";
import { PollCard, type PollState } from "./Polls";
import { EmojiGrid } from "./Composer";
import { reactorsText } from "./reactors";
import type { Message } from "./Conversation";
import { dragRef } from "@/lib/ask-context";

/** The two reactions on the hover toolbar; the rest are in the emoji grid. */
const QUICK_BAR = ["✅", "👍"];

/**
 * One chat message, wherever it shows: the channel log and a thread's replies render the same row (author, time,
 * body, attachments, previews, poll, reactions, hover toolbar). What a place can't do is simply not passed: a thread
 * has no "reply in thread", a read-only list has no toolbar.
 */
export function MessageItem({
  m,
  me,
  head = true,
  stamp,
  agentName,
  className,
  tone = "default",
  editing = false,
  onSaveEdit,
  onCancelEdit,
  picker = false,
  onPicker,
  onReact,
  onThread,
  onSave,
  remindItems,
  moreItems,
  onHidePreviews,
  onPoll,
  translation,
  extra,
  rowProps,
}: {
  m: Message;
  me: string;
  /** First of a run by the same author: avatar and name; later ones show only the time on hover. */
  head?: boolean;
  /** How the time reads (a thread's old messages carry their day too). */
  stamp?: (iso: string) => string;
  agentName?: (authorId: string) => string;
  /** Width and side padding of the row in its container. */
  className?: string;
  tone?: "default" | "focused" | "mentioned";
  editing?: boolean;
  onSaveEdit?: (body: string) => void;
  onCancelEdit?: () => void;
  /** The emoji grid is open on this message. */
  picker?: boolean;
  onPicker?: (open: boolean) => void;
  onReact?: (emoji: string) => void;
  /** Opens the message's thread (the thread line and the toolbar button); left out inside a thread. */
  onThread?: () => void;
  onSave?: () => void;
  remindItems?: MenuItem[];
  moreItems?: MenuItem[];
  onHidePreviews?: () => void;
  onPoll?: (poll: PollState) => void;
  translation?: { text: string | null; to: string };
  /** Context-only lines under the body (suggested tasks, resend, an AI invitation). */
  extra?: React.ReactNode;
  rowProps?: React.HTMLAttributes<HTMLElement>;
}) {
  const { t, time } = useFormat();
  const dir = useDirectory();
  const when = stamp ?? time;
  const author =
    m.authorType === "system"
      ? "workspace"
      : m.authorType === "agent"
        ? (agentName?.(m.authorId) ?? "Agent")
        : m.authorType === "import"
          ? (m.importAuthor ?? "Slack")
          : dir.name(m.authorId);
  const actions = !m.pending && !m.deletedAt && !editing && (onReact || onThread || onSave || moreItems?.length);
  return (
    <article
      id={m.id}
      className={cx(
        "group relative grid grid-cols-[36px_minmax(0,1fr)] gap-x-3 rounded-lg transition-colors duration-100",
        head ? "pb-1 pt-3" : "py-0.5",
        m.pending && "opacity-60",
        // A message that mentions me keeps a blue rail on its left edge (Slack's yellow, in our accent).
        tone === "focused"
          ? "bg-nav-active"
          : tone === "mentioned"
            ? "bg-signal-wash shadow-[inset_3px_0_0_var(--color-accent)]"
            : cx("hover:bg-hover has-[[aria-expanded=true]]:bg-hover", picker && "bg-hover"),
        className,
      )}
      aria-label={`${m.authorType === "import" ? (m.importAuthor ?? "Slack") : dir.short(m.authorId)}, ${when(m.createdAt)}`}
      {...rowProps}
    >
      <div>
        {head ? (
          m.authorType === "agent" ? (
            <span className="bg-hover text-ink-2 grid size-8 place-items-center rounded-lg">
              <BotIcon className="size-4" />
            </span>
          ) : m.authorType === "user" ? (
            <PersonTrigger userId={m.authorId} className="block">
              <Avatar id={m.authorId} size="md" />
            </PersonTrigger>
          ) : (
            <Avatar
              id={m.authorType === "system" ? "system" : m.authorType === "import" ? `import:${m.importAuthor ?? ""}` : m.authorId}
              name={m.authorType === "import" ? (m.importAuthor ?? "Slack") : undefined}
              size="md"
            />
          )
        ) : (
          <span className="text-ink-2 hidden pt-0.5 text-xs tabular-nums group-hover:block">{time(m.createdAt)}</span>
        )}
      </div>
      <div className="min-w-0">
        {head ? (
          <div className="flex items-baseline gap-2">
            {m.authorType === "user" ? (
              <PersonTrigger userId={m.authorId} className="rounded-sm text-sm font-semibold hover:underline">
                {dir.short(m.authorId)}
              </PersonTrigger>
            ) : (
              <span className="text-sm font-semibold">{author}</span>
            )}
            {m.authorType === "user" ? <StatusBadge userId={m.authorId} /> : null}
            {m.authorType === "agent" ? <span className="bg-hover text-ink-2 rounded-sm px-1 text-xs font-medium">AGENT</span> : null}
            {m.authorType === "import" ? (
              <span className="bg-hover text-ink-2 rounded-sm px-1 text-xs font-medium" title={t("chat.conv.importedHint")}>
                SLACK
              </span>
            ) : null}
            {/* Dragged into the ask box (⌘J), the message becomes something to ask about. */}
            <time
              dateTime={m.createdAt}
              className="text-ink-2 cursor-grab text-xs tabular-nums"
              draggable={!m.deletedAt}
              onDragStart={(e) => dragRef(e, { kind: "message", id: m.id, label: m.body.replace(/\s+/g, " ").slice(0, 80) || author }, `/app/chat/m/${m.id}`)}
            >
              {when(m.createdAt)}
            </time>
          </div>
        ) : null}
        {editing && onSaveEdit && onCancelEdit ? (
          <EditBox initial={m.body} onCancel={onCancelEdit} onSave={onSaveEdit} />
        ) : (
          <div className="whitespace-pre-wrap text-sm/[1.5] [overflow-wrap:anywhere]">
            {m.deletedAt ? (
              <em className="text-ink-2">{t("chat.conv.deleted")}</em>
            ) : m.forwardOf ? (
              <div className="border-hairline my-0.5 border-l-2 pl-3">
                <span className="text-ink-2 mb-0.5 flex items-center gap-1 text-xs">
                  <ForwardIcon className="size-3.5" />
                  {t("chat.forward.from", {
                    name: dir.short(m.forwardOf.authorId),
                    // A private channel's name is itself private: readers here need not be its members.
                    where:
                      m.forwardOf.channelKind === "dm" || m.forwardOf.channelKind === "group"
                        ? t("chat.forward.private")
                        : m.forwardOf.channelKind === "private"
                          ? t("chat.forward.privateChannel")
                          : `#${m.forwardOf.channelName ?? ""}`,
                  })}
                </span>
                <RichText text={m.body} names={dir.names} me={me} />
              </div>
            ) : m.body ? (
              <RichText text={m.authorType === "agent" ? withoutAgentPrefix(m.body, author) : m.body} names={dir.names} me={me} />
            ) : null}
            {m.editedAt && !m.deletedAt ? <span className="text-ink-2 ml-1 text-xs">{t("chat.conv.edited")}</span> : null}
            {m.pinned ? (
              <span className="text-brand-text ml-1.5 inline-flex items-center gap-0.5 text-xs font-medium">
                <PinIcon className="size-3" />
                {t("chat.conv.pinnedMark")}
              </span>
            ) : null}
            {!m.deletedAt ? <AttachmentList items={m.attachments ?? []} /> : null}
            {!m.deletedAt && m.linkPreviews?.length ? <LinkPreviews messageId={m.id} items={m.linkPreviews} onHide={onHidePreviews} /> : null}
            {!m.deletedAt && m.poll && onPoll ? <PollCard messageId={m.id} poll={m.poll} onChange={onPoll} /> : null}
            {translation ? (
              <span className="border-hairline text-ink-2 mt-1.5 block border-l-2 pl-3 text-sm" lang={translation.to}>
                <span className="text-ink-2 mb-0.5 flex items-center gap-1 text-xs font-medium">
                  <TranslateIcon className="size-3.5" />
                  {translation.text === null ? t("chat.translate.working") : t("chat.translate.label")}
                </span>
                {/* Same formatting as the original (bold, lists, links): the model keeps the Markdown. */}
                {translation.text ? <RichText text={translation.text} names={dir.names} me={me} /> : null}
              </span>
            ) : null}
          </div>
        )}
        {extra}
        {m.reactions.length > 0 ? (
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {m.reactions.map((r) => (
              <button
                key={r.emoji}
                type="button"
                aria-pressed={r.mine}
                disabled={!onReact}
                title={t("chat.reactors.title", { names: reactorsText(t, r.users ?? [], r.count, me, dir.name), emoji: r.emoji })}
                onClick={() => onReact?.(r.emoji)}
                className={cx(
                  // Slack's chips: a quiet grey pill; mine is a pale blue one with a thin blue edge.
                  "inline-flex h-6 items-center gap-1 rounded-full border px-2 text-xs tabular-nums transition-colors",
                  r.mine
                    ? "border-accent/50 bg-accent-wash text-accent-text hover:border-accent"
                    : "bg-hover text-ink-soft hover:border-ink-2/40 hover:bg-surface border-transparent",
                )}
              >
                <ReactionArt emoji={r.emoji} size={16} />
                <span className="font-medium">{r.count}</span>
              </button>
            ))}
            {!m.deletedAt && !m.pending && onPicker ? (
              <button
                type="button"
                onClick={() => onPicker(!picker)}
                data-emoji-toggle
                aria-label={t("chat.conv.react")}
                title={t("chat.conv.react")}
                className="bg-hover text-ink-2 hover:text-ink hover:border-ink-2/40 hover:bg-surface inline-flex h-6 items-center rounded-full border border-transparent px-2 opacity-0 transition focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
              >
                <SmileIcon className="size-3.5" />
              </button>
            ) : null}
          </div>
        ) : null}
        {m.replyCount > 0 && onThread ? (
          <button
            type="button"
            onClick={onThread}
            // Slack's thread line: the count in blue, the last reply in grey; hovering lifts it onto a white strip.
            className="group/reply hover:border-hairline hover:bg-surface -ml-1.5 mt-1 flex h-7 w-full max-w-md items-center gap-2 rounded-md border border-transparent px-1.5 text-[13px] transition-colors"
          >
            <ThreadIcon className="text-accent-text size-4 shrink-0" />
            <span className="text-accent-text font-semibold">{t("chat.conv.replies", { count: m.replyCount })}</span>
            {m.lastReplyAt ? <span className="text-ink-2 truncate">{t("chat.conv.lastReply", { time: time(m.lastReplyAt) })}</span> : null}
            <ChevronRightIcon className="text-ink-2 ml-auto size-3.5 shrink-0 opacity-0 transition-opacity group-hover/reply:opacity-100" />
          </button>
        ) : null}
      </div>
      {actions ? (
        <div
          role="toolbar"
          aria-label={t("chat.conv.messageActions")}
          className={cx(
            "border-hairline bg-surface shadow-popover absolute -top-4 right-4 z-10 hidden items-center gap-0.5 rounded-lg border p-1 group-focus-within:flex group-hover:flex has-[[aria-expanded=true]]:flex",
            picker && "flex",
          )}
        >
          {/* The two most used reactions, then react, thread, remind, save; the rest in "⋯". */}
          {onReact ? (
            <>
              {QUICK_BAR.map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => onReact(e)}
                  aria-label={t("chat.conv.reactWith", { emoji: e })}
                  title={t("chat.conv.reactWith", { emoji: e })}
                  className="hover:bg-hover grid size-8 place-items-center rounded-md text-base transition hover:scale-110"
                >
                  <ReactionArt emoji={e} size={20} />
                </button>
              ))}
              <span className="bg-hairline mx-0.5 h-5 w-px" aria-hidden="true" />
            </>
          ) : null}
          {onPicker ? (
            <ToolBtn label={t("chat.conv.react")} emojiToggle active={picker} onClick={() => onPicker(!picker)}>
              <SmileIcon />
            </ToolBtn>
          ) : null}
          {onThread ? (
            <ToolBtn label={t("chat.conv.replyThread")} onClick={onThread}>
              <ThreadIcon />
            </ToolBtn>
          ) : null}
          {onSave ? (
            <ToolBtn label={t(m.saved ? "chat.conv.unsaveMessage" : "chat.conv.saveMessage")} active={!!m.saved} onClick={onSave}>
              <BookmarkIcon />
            </ToolBtn>
          ) : null}
          {remindItems?.length ? (
            <Menu
              label={t("chat.remind.title")}
              items={remindItems}
              trigger={
                <span className={toolBtn} title={t("chat.remind.title")}>
                  <ClockIcon />
                </span>
              }
            />
          ) : null}
          {moreItems?.length ? (
            <Menu
              label={t("chat.conv.moreActions")}
              items={moreItems}
              trigger={
                <span className={cx(toolBtn, "[&_path]:stroke-[3]")} title={t("chat.conv.moreActions")}>
                  <MoreIcon />
                </span>
              }
            />
          ) : null}
        </div>
      ) : null}
      {picker && onPicker && onReact ? (
        <EmojiGrid
          reactions
          className="right-4 top-6"
          onClose={() => onPicker(false)}
          onPick={(e) => {
            onPicker(false);
            onReact(e);
          }}
        />
      ) : null}
    </article>
  );
}

/** Agents prefix their answers with "**Name:** "; the header already shows the name. */
function withoutAgentPrefix(body: string, name: string): string {
  return body.startsWith(`**${name}:** `) ? body.slice(name.length + 6) : body;
}

/** A message toolbar button: 32px, an 18px icon in ink-soft (ink-2 at 16px read as disabled). */
export const toolBtn =
  "text-ink-soft hover:bg-hover hover:text-ink aria-expanded:bg-selected aria-expanded:text-ink in-aria-expanded:bg-selected in-aria-expanded:text-ink grid size-8 place-items-center rounded-md transition-colors";

export function ToolBtn({
  label,
  onClick,
  children,
  active,
  emojiToggle,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  active?: boolean;
  /** Opens the emoji grid: a press here must not count as a press outside it. */
  emojiToggle?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-pressed={active}
      data-emoji-toggle={emojiToggle || undefined}
      className={cx(toolBtn, active && "bg-selected text-ink", active && !emojiToggle && "[&_svg]:fill-current")}
    >
      {children}
    </button>
  );
}

function EditBox({ initial, onSave, onCancel }: { initial: string; onSave: (b: string) => void; onCancel: () => void }) {
  const [v, setV] = useState(initial);
  const { t } = useFormat();
  return (
    <div className="mt-1 grid gap-2">
      <textarea
        className={cx(input, "min-h-16 resize-y py-2")}
        value={v}
        onChange={(e) => setV(e.target.value)}
        autoFocus
        aria-label={t("chat.conv.editMessage")}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (v.trim()) onSave(v.trim());
          }
        }}
      />
      <div className="flex gap-2">
        <button type="button" className={btnPrimary} onClick={() => v.trim() && onSave(v.trim())}>
          {t("common.save")}
        </button>
        <button type="button" className={btn} onClick={onCancel}>
          {t("common.cancel")}
        </button>
        <span className="text-ink-2 self-center text-xs">{t("chat.conv.editHint")}</span>
      </div>
    </div>
  );
}
