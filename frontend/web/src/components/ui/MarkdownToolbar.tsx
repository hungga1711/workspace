"use client";

import { useT } from "@/lib/i18n/client";
import { applyMarkdown, continueList, linkEdit, type Edit } from "@/lib/markdown-edit";
import { BoldIcon, ChecklistIcon, CodeIcon, HeadingIcon, ItalicIcon, LinkIcon, ListIcon, ListOrderedIcon, QuoteIcon, StrikeIcon } from "@/components/app/icons";
import { cx } from "@/lib/ui";

/**
 * Formatting buttons and shortcuts (⌘B, ⌘I, ⌘⇧X, ⌘K) for a Markdown textarea. The textarea stays the source
 * of truth; each action edits its value and restores a sensible selection.
 */
export function MarkdownToolbar({
  target,
  value,
  onChange,
  className,
}: {
  target: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (v: string) => void;
  className?: string;
}) {
  const t = useT();
  const run = (make: (text: string, a: number, b: number) => Edit) => {
    const el = target.current;
    if (!el) return;
    const e = make(value, el.selectionStart, el.selectionEnd);
    onChange(e.text);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(e.from, e.to);
    });
  };
  const tool = "grid size-8 shrink-0 place-items-center rounded-md text-ink-2 hover:bg-hover hover:text-ink";
  const b = (label: string, icon: React.ReactNode, make: (text: string, a: number, b: number) => Edit, hint?: string) => (
    <button type="button" className={tool} onMouseDown={(e) => e.preventDefault()} onClick={() => run(make)} aria-label={label} title={hint ?? label}>
      {icon}
    </button>
  );
  return (
    <div
      className={cx("border-hairline flex items-center gap-0.5 overflow-x-auto border-b px-2 py-1 [scrollbar-width:none]", className)}
      role="toolbar"
      aria-label={t("chat.composer.formatting")}
    >
      {b(t("ui.md.heading"), <HeadingIcon className="size-4" />, (s, a, z) => applyMarkdown(s, a, z, "## ", "", true))}
      {b(t("chat.composer.bold"), <BoldIcon className="size-4" />, (s, a, z) => applyMarkdown(s, a, z, "**"), `${t("chat.composer.bold")} (⌘B)`)}
      {b(t("chat.composer.italic"), <ItalicIcon className="size-4" />, (s, a, z) => applyMarkdown(s, a, z, "_"), `${t("chat.composer.italic")} (⌘I)`)}
      {b(t("chat.composer.strike"), <StrikeIcon className="size-4" />, (s, a, z) => applyMarkdown(s, a, z, "~~"), `${t("chat.composer.strike")} (⌘⇧X)`)}
      {b(t("ui.md.link"), <LinkIcon className="size-4" />, linkEdit, `${t("ui.md.link")} (⌘K)`)}
      <span className="bg-hairline mx-1 h-5 w-px shrink-0" aria-hidden="true" />
      {b(t("chat.composer.list"), <ListIcon className="size-4" />, (s, a, z) => applyMarkdown(s, a, z, "- ", "", true))}
      {b(t("ui.md.numbered"), <ListOrderedIcon className="size-4" />, (s, a, z) => applyMarkdown(s, a, z, "1. ", "", true))}
      {b(t("ui.md.checklist"), <ChecklistIcon className="size-4" />, (s, a, z) => applyMarkdown(s, a, z, "- [ ] ", "", true))}
      {b(t("chat.composer.quote"), <QuoteIcon className="size-4" />, (s, a, z) => applyMarkdown(s, a, z, "> ", "", true))}
      {b(t("chat.composer.code"), <CodeIcon className="size-4" />, (s, a, z) =>
        s.slice(a, z).includes("\n") ? applyMarkdown(s, a, z, "```\n", "\n```") : applyMarkdown(s, a, z, "`"),
      )}
    </div>
  );
}

/** Keyboard shortcuts for the same actions; returns true when it handled the key. */
export function markdownShortcut(e: React.KeyboardEvent<HTMLTextAreaElement>, value: string, onChange: (v: string) => void): boolean {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return false;
  const k = e.key.toLowerCase();
  const el = e.currentTarget;
  const make = e.shiftKey
    ? k === "x"
      ? (s: string, a: number, z: number) => applyMarkdown(s, a, z, "~~")
      : null
    : k === "b"
      ? (s: string, a: number, z: number) => applyMarkdown(s, a, z, "**")
      : k === "i"
        ? (s: string, a: number, z: number) => applyMarkdown(s, a, z, "_")
        : k === "k"
          ? linkEdit
          : null;
  if (!make) return false;
  e.preventDefault();
  const r = make(value, el.selectionStart, el.selectionEnd);
  onChange(r.text);
  requestAnimationFrame(() => el.setSelectionRange(r.from, r.to));
  return true;
}

/**
 * Enter inside a list continues it, or ends it on an empty item (`continueList`). Returns true when it handled the key.
 * The edit goes through the browser's own text insertion, so the caret lands at once (typing straight after Enter
 * cannot jump ahead of it) and ⌘Z undoes it; the value-and-selection fallback covers browsers without it.
 */
export function continueListOnEnter(e: React.KeyboardEvent<HTMLTextAreaElement>, value: string, onChange: (v: string) => void): boolean {
  if (e.key !== "Enter" || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey || e.nativeEvent.isComposing) return false;
  const el = e.currentTarget;
  const caret = el.selectionStart;
  if (caret !== el.selectionEnd) return false;
  const r = continueList(value, caret);
  if (!r) return false;
  e.preventDefault();
  let done = false;
  if (r.text.length > value.length) done = document.execCommand("insertText", false, r.text.slice(caret, caret + r.text.length - value.length));
  else {
    el.setSelectionRange(r.from, caret);
    done = document.execCommand("delete");
  }
  if (!done) {
    onChange(r.text);
    requestAnimationFrame(() => el.setSelectionRange(r.from, r.to));
  }
  return true;
}
