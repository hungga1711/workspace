"use client";

import { useRef, useState } from "react";
import { useT } from "@/lib/i18n/client";
import { Markdown } from "@/lib/markdown";
import { cx } from "@/lib/ui";
import { MarkdownToolbar, continueListOnEnter, markdownShortcut } from "@/components/ui/MarkdownToolbar";

/**
 * A Markdown field for the workflow editor (the description and a step's role as rich text): Write and
 * Preview tabs, the formatting toolbar and the shortcuts of the task description; the value stays a Markdown string.
 * Loaded on demand by the studio (studio/parts.tsx).
 */
export function RichField({
  value,
  onChange,
  label,
  placeholder,
  maxLength,
  minRows = "min-h-24",
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  placeholder?: string;
  maxLength?: number;
  /** The textarea's minimum height class. */
  minRows?: string;
}) {
  const t = useT();
  const area = useRef<HTMLTextAreaElement>(null);
  const [tab, setTab] = useState<"write" | "preview">("write");
  const set = (v: string) => onChange(maxLength ? v.slice(0, maxLength) : v);
  const tabBtn = (key: "write" | "preview", text: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === key}
      onClick={() => setTab(key)}
      className={cx("-mb-px h-9 border-b-2 px-2.5 text-[13px] font-medium transition-colors", tab === key ? "border-ink text-ink" : "text-ink-2 hover:text-ink border-transparent")}
    >
      {text}
    </button>
  );
  return (
    <div className="border-hairline bg-surface focus-within:border-ink-2/40 focus-within:ring-selected min-w-0 overflow-hidden rounded-lg border transition-[border-color,box-shadow] focus-within:ring-[3px]">
      <div className="border-hairline flex items-center gap-0.5 border-b pl-1 pr-2" role="tablist" aria-label={label}>
        {tabBtn("write", t("work.taskdetailview.desc_write"))}
        {tabBtn("preview", t("work.taskdetailview.desc_preview"))}
        {maxLength && value.length > maxLength * 0.8 ? (
          <span className="text-ink-2 ml-auto text-xs tabular-nums">
            {value.length}/{maxLength}
          </span>
        ) : null}
      </div>
      {tab === "write" ? (
        <>
          <MarkdownToolbar target={area} value={value} onChange={set} className="bg-ground/40" />
          <textarea
            ref={area}
            aria-label={label}
            className={cx("placeholder:text-ink-2 block max-h-[50vh] w-full resize-y bg-transparent px-3 py-2.5 text-sm/6 outline-none [field-sizing:content]", minRows)}
            value={value}
            maxLength={maxLength}
            placeholder={placeholder}
            onChange={(e) => set(e.target.value)}
            onKeyDown={(e) => {
              if (continueListOnEnter(e, value, set)) return;
              markdownShortcut(e, value, set);
            }}
          />
        </>
      ) : (
        <div className={cx("px-3 py-2.5 text-sm [&>div>:first-child]:mt-0 [&>div>:last-child]:mb-0", minRows)}>
          {value.trim() ? <Markdown source={value} /> : <p className="text-ink-2 m-0 text-sm">{t("work.taskdetailview.desc_previewEmpty")}</p>}
        </div>
      )}
    </div>
  );
}
