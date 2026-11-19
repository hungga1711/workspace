"use client";

import { transferFiles } from "@/lib/transfer-files";
import { useEffect, useId, useRef, useState } from "react";
import { useLeaveWarning } from "@/lib/draft";
import { useT } from "@/lib/i18n/client";
import { Markdown } from "@/lib/markdown";
import { toggleTask } from "@/lib/markdown-edit";
import { MarkdownToolbar, continueListOnEnter, markdownShortcut } from "@/components/ui/MarkdownToolbar";
import { PencilIcon } from "@/components/app/icons";
import { btn, btnGhost, btnPrimary, btnSm, cx, iconBtn } from "@/lib/ui";

/**
 * A task's description: rendered Markdown, edited in place with the formatting toolbar, Viết / Xem trước and explicit
 * Lưu / Huỷ (⌘Enter saves, Esc cancels and restores the saved text). It stays Markdown text, which is what the API,
 * search and the AI read. Checklist items can be ticked from the rendered view without opening the editor.
 */
export function TaskDescription({
  value,
  onSave,
  className,
  headClassName,
  titleClassName,
  bare = false,
  onUploadImage,
  prefill,
}: {
  value: string;
  /** Resolves true once saved; false keeps the editor open with the draft. */
  onSave: (next: string) => Promise<boolean>;
  className?: string;
  headClassName?: string;
  titleClassName?: string;
  /** Under the task's title: no visible heading; the text itself is what you click to edit. */
  bare?: boolean;
  /** Stores a pasted or dropped picture with the task; resolves to its link (/app/files/<id>), or null on failure. */
  onUploadImage?: (file: File) => Promise<string | null>;
  /** Opens the editor with this text (the description template), unsaved until Lưu; a new `key` asks again. */
  prefill?: { text: string; key: number } | null;
}) {
  const t = useT();
  // Its own id: the task screen has a "desc-h" heading of its own around the bare form.
  const headingId = useId();
  const area = useRef<HTMLTextAreaElement>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [tab, setTab] = useState<"write" | "preview">("write");
  const [busy, setBusy] = useState(false);
  // An edit not saved yet: ask before the tab closes on it.
  useLeaveWarning(editing && draft !== value);
  const [failed, setFailed] = useState(false);
  // A ticked checklist item shows at once; the saved text replaces it (or it reverts if saving fails).
  const [ticked, setTicked] = useState<string | null>(null);
  const shown = ticked ?? value;

  // A pasted or dropped picture goes in where the caret is: a placeholder while it uploads, then its Markdown.
  const addImages = (data: DataTransfer | null, e: React.SyntheticEvent) => {
    const images = transferFiles(data).filter((f) => f.type.startsWith("image/"));
    if (!onUploadImage || !images.length) return;
    e.preventDefault();
    const el = area.current;
    for (const file of images) {
      const mark = `![${t("work.taskdetailview.imgUploading")}](…${Math.random().toString(36).slice(2, 7)})`;
      setDraft((d) => {
        const at = el ? el.selectionStart : d.length;
        return `${d.slice(0, at)}${mark}\n${d.slice(at)}`;
      });
      void onUploadImage(file).then((url) => setDraft((d) => d.replace(mark, url ? `![${file.name.replace(/[\[\]]/g, "")}](${url})` : "")));
    }
  };
  useEffect(() => {
    if (!prefill) return;
    setDraft(prefill.text);
    setTab("write");
    setFailed(false);
    setEditing(true);
  }, [prefill]);
  const open = () => {
    setDraft(value);
    setTab("write");
    setFailed(false);
    setEditing(true);
  };
  const cancel = () => {
    setDraft(value);
    setEditing(false);
    setFailed(false);
  };
  const commit = async () => {
    if (busy) return;
    if (draft === value) {
      setEditing(false);
      return;
    }
    setBusy(true);
    const ok = await onSave(draft);
    setBusy(false);
    setFailed(!ok);
    if (ok) setEditing(false);
  };
  const tick = (n: number) => {
    const next = toggleTask(shown, n);
    setTicked(next);
    void onSave(next).finally(() => setTicked(null));
  };

  const tabBtn = (key: "write" | "preview", label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === key}
      onClick={() => setTab(key)}
      className={cx("-mb-px h-10 border-b-2 px-3 text-sm font-medium transition-colors", tab === key ? "border-ink text-ink" : "text-ink-2 hover:text-ink border-transparent")}
    >
      {label}
    </button>
  );

  return (
    <section className={className} aria-labelledby={headingId}>
      <header className={bare ? "sr-only" : headClassName}>
        <h2 id={headingId} className={titleClassName}>
          {t("work.taskdetailview.mo_ta")}
        </h2>
        {!editing && value && !bare ? (
          <button type="button" className={cx(btnGhost, btnSm, "ml-auto")} onClick={open} aria-label={t("work.taskdetailview.desc_editAria")}>
            <PencilIcon className="size-3.5" />
            {t("work.taskdetailview.desc_edit")}
          </button>
        ) : null}
      </header>
      {editing ? (
        <div className="border-hairline bg-surface focus-within:border-ink-2/40 focus-within:ring-selected overflow-hidden rounded-xl border transition-[border-color,box-shadow] focus-within:ring-[3px]">
          <div className="border-hairline flex items-center gap-1 border-b pl-1 pr-2" role="tablist">
            {tabBtn("write", t("work.taskdetailview.desc_write"))}
            {tabBtn("preview", t("work.taskdetailview.desc_preview"))}
          </div>
          {tab === "write" ? (
            <>
              <MarkdownToolbar target={area} value={draft} onChange={setDraft} className="bg-ground/40" />
              <textarea
                ref={area}
                aria-label={t("work.taskdetailview.desc_editAria")}
                className="placeholder:text-ink-2 block max-h-[60vh] min-h-40 w-full resize-y bg-transparent px-4 py-3 text-[14px]/7 outline-none [field-sizing:content]"
                value={draft}
                autoFocus
                placeholder={t("work.taskdetailview.them_mo_ta_boi")}
                onChange={(e) => setDraft(e.target.value)}
                onPaste={(e) => addImages(e.clipboardData, e)}
                onDrop={(e) => addImages(e.dataTransfer, e)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    void commit();
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    cancel();
                    return;
                  }
                  if (continueListOnEnter(e, draft, setDraft)) return;
                  markdownShortcut(e, draft, setDraft);
                }}
              />
            </>
          ) : (
            <div className="min-h-40 px-4 py-3">
              {draft.trim() ? <Markdown source={draft} /> : <p className="text-ink-2 m-0 text-sm">{t("work.taskdetailview.desc_previewEmpty")}</p>}
            </div>
          )}
          <footer className="border-hairline flex flex-wrap items-center gap-2 border-t px-3 py-2">
            <span className="text-ink-2 min-w-0 flex-1 text-xs">
              {failed ? (
                <span className="text-block" role="alert">
                  {t("work.taskdetailview.desc_failed")}
                </span>
              ) : (
                <>
                  {t("work.taskdetailview.desc_hint")}
                  <span className="max-md:hidden"> · {t("work.taskdetailview.desc_keys")}</span>
                </>
              )}
            </span>
            <button type="button" className={cx(btn, btnSm)} onClick={cancel} disabled={busy}>
              {t("work.taskdetailview.huy")}
            </button>
            <button type="button" className={cx(btnPrimary, btnSm)} onClick={() => void commit()} disabled={busy}>
              {busy ? t("work.taskdetailview.desc_saving") : t("work.taskdetailview.luu")}
            </button>
          </footer>
        </div>
      ) : shown.trim() ? (
        bare ? (
          // The text is the control: a click anywhere but a link or a checklist box opens the editor.
          <div
            className="text-ink hover:bg-hover/50 group relative -mx-3 cursor-text rounded-lg py-2 pl-3 pr-11 transition-colors [&>div>:first-child]:mt-0 [&>div>:last-child]:mb-0"
            onClick={(e) => {
              if ((e.target as HTMLElement).closest("a, input, button, label")) return;
              open();
            }}
          >
            <Markdown source={shown} onToggleTask={tick} />
            {/* Icon only, in a gutter the text never enters (pr-11): a labelled button here covered the last words.
                Always shown where there is no hover, so editing stays findable on phones. */}
            <span className="absolute right-1.5 top-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
              <button type="button" className={iconBtn} onClick={open} aria-label={t("work.taskdetailview.desc_editAria")} title={t("work.taskdetailview.desc_edit")}>
                <PencilIcon />
              </button>
            </span>
          </div>
        ) : (
          <div className="text-ink [&>div>:first-child]:mt-0 [&>div>:last-child]:mb-0">
            <Markdown source={shown} onToggleTask={tick} />
          </div>
        )
      ) : bare ? (
        <button
          type="button"
          onClick={open}
          className="text-ink-2 hover:bg-hover/50 -mx-3 flex w-[calc(100%+1.5rem)] items-center rounded-lg px-3 py-2 text-left text-[14px]/7 transition-colors"
        >
          {t("work.taskdetailview.them_mo_ta_boi")}
        </button>
      ) : (
        <button
          type="button"
          onClick={open}
          className="border-hairline text-ink-2 hover:border-ink-2/40 hover:bg-hover/40 flex min-h-20 w-full items-start rounded-xl border border-dashed px-4 py-3 text-left text-[14px]/7 transition-colors"
        >
          {t("work.taskdetailview.them_mo_ta_boi")}
        </button>
      )}
    </section>
  );
}
