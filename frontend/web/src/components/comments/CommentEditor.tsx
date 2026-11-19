"use client";

import { useRef, useState } from "react";
import { useT } from "@/lib/i18n/client";
import { btn, btnPrimary, btnSm, cx } from "@/lib/ui";
import { MarkdownToolbar, continueListOnEnter, markdownShortcut } from "@/components/ui/MarkdownToolbar";
import { namesToTokens, tokensToNames } from "@/lib/mention-text";

/**
 * Editing one's own task comment in place: the same Markdown toolbar and shortcuts as the comment box, mentions shown
 * as "@Name" while editing and turned back into mentions on save. ⌘/Ctrl+Enter saves, Esc cancels (without closing
 * the task dialog around it).
 */
export function CommentEditor({
  body,
  names,
  people,
  onSave,
  onCancel,
}: {
  body: string;
  names: Record<string, string>;
  people: { id: string; name: string }[];
  onSave: (body: string) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const area = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState(() => tokensToNames(body, names));
  const save = () => {
    const next = namesToTokens(draft.trim(), people);
    if (next) onSave(next);
  };
  return (
    <div className="border-hairline bg-surface focus-within:border-ink-2/40 grid overflow-hidden rounded-lg border">
      <MarkdownToolbar target={area} value={draft} onChange={setDraft} className="bg-ground/40" />
      <textarea
        ref={area}
        aria-label={t("work.taskdetailview.comment_editAria")}
        className="block max-h-[50vh] min-h-24 w-full resize-y bg-transparent px-3 py-2 text-sm/6 outline-none [field-sizing:content]"
        value={draft}
        autoFocus
        maxLength={10000}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            save();
            return;
          }
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
            return;
          }
          if (continueListOnEnter(e, draft, setDraft)) return;
          markdownShortcut(e, draft, setDraft);
        }}
      />
      <div className="border-divider flex items-center justify-end gap-2 border-t px-2 py-1.5">
        <span className="text-ink-2 mr-auto pl-1 text-xs max-sm:hidden">{t("work.taskdetailview.comment_editKeys")}</span>
        <button type="button" className={cx(btn, btnSm)} onClick={onCancel}>
          {t("common.cancel")}
        </button>
        <button type="button" className={cx(btnPrimary, btnSm)} disabled={!draft.trim()} onClick={save}>
          {t("common.save")}
        </button>
      </div>
    </div>
  );
}
