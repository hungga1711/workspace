"use client";

import { memo, useEffect, useMemo, useRef } from "react";
import { useT } from "@/lib/i18n/client";
import { cx } from "@/lib/ui";
import { docProse } from "./prose";

// Reading only: toggles fold, the contents block lists the headings, checklists cannot be ticked.
const readOnly = cx(
  "[&_[data-toggle]]:relative [&_[data-toggle]]:my-2 [&_[data-toggle]]:pl-6 [&_[data-toggle]>:first-child]:font-semibold",
  "[&_[data-toggle][data-collapsed=true]>:not(:first-child):not([data-toggle-button])]:hidden",
  "[&_[data-toggle-button]]:text-ink-2 [&_[data-toggle-button]]:hover:bg-hover [&_[data-toggle-button]]:absolute [&_[data-toggle-button]]:left-0 [&_[data-toggle-button]]:top-[5px] [&_[data-toggle-button]]:grid [&_[data-toggle-button]]:size-5 [&_[data-toggle-button]]:place-items-center [&_[data-toggle-button]]:rounded",
  "[&_[data-toggle-button]_svg]:size-3.5 [&_[data-toggle-button]_svg]:transition-transform [&_[data-toggle-button][aria-expanded=true]_svg]:rotate-90",
  "[&_[data-toc]]:border-hairline [&_[data-toc]]:bg-hover/40 [&_[data-toc]]:my-3 [&_[data-toc]]:rounded-lg [&_[data-toc]]:border [&_[data-toc]]:px-4 [&_[data-toc]]:py-3",
  "[&_[data-toc]>p]:text-ink-2 [&_[data-toc]>p]:m-0 [&_[data-toc]>p]:mb-1.5 [&_[data-toc]>p]:text-xs [&_[data-toc]>p]:font-medium",
  "[&_[data-toc]_ol]:m-0 [&_[data-toc]_ol]:grid [&_[data-toc]_ol]:list-none [&_[data-toc]_ol]:gap-0.5 [&_[data-toc]_ol]:p-0 [&_[data-toc]_button]:text-brand-text [&_[data-toc]_button]:text-left [&_[data-toc]_button]:text-sm [&_[data-toc]_button:hover]:underline",
  "[&_[data-toc]_li[data-level='2']]:pl-4 [&_[data-toc]_li[data-level='3']]:pl-8",
);

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };
const plain = (v: string) =>
  v
    .replace(/<[^>]+>/g, "")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e: string) => ENTITIES[e] ?? "")
    // The page's emoji is its own field: "Welcome 👋" in the text still repeats the title "Welcome".
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/**
 * Reading view: a page whose first block is a heading saying the page's title again shows it once (the page's h1).
 * The saved HTML keeps the heading, so the editor still has it.
 */
export function dropTitleHeading(html: string, title: string | undefined): string {
  if (!title) return html;
  const m = /^\s*<(h[1-3])\b[^>]*>([\s\S]*?)<\/\1>/i.exec(html);
  return m && plain(m[2]!) === plain(title) ? html.slice(m[0].length) : html;
}

/**
 * A page as it is read: the saved HTML (cleaned by the work module) rendered directly, on the server too,
 * so the words are there before any script runs. The editor (ProseMirror, ~150 kB) loads only for "Sửa".
 */
export const DocBody = memo(function DocBody({ html: saved, title }: { html: string; /** The page title: a first heading repeating it is not shown. */ title?: string }) {
  const html = useMemo(() => dropTitleHeading(saved, title), [saved, title]);
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    root.querySelectorAll<HTMLInputElement>("input[type=checkbox]").forEach((i) => (i.disabled = true));
    const arrow = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M9 6l7 6-7 6z"/></svg>';
    root.querySelectorAll<HTMLElement>("[data-toggle]").forEach((box) => {
      if (box.querySelector(":scope > [data-toggle-button]")) return;
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.toggleButton = "";
      b.innerHTML = arrow;
      const set = (open: boolean) => {
        box.dataset.collapsed = open ? "false" : "true";
        b.setAttribute("aria-expanded", String(open));
        b.setAttribute("aria-label", t(open ? "docs.toggle.collapse" : "docs.toggle.expand"));
      };
      set(true);
      b.onclick = () => set(box.dataset.collapsed === "true");
      box.append(b);
    });
    const headings = [...root.querySelectorAll<HTMLElement>("h1, h2, h3")].filter((h) => h.textContent?.trim());
    root.querySelectorAll<HTMLElement>("[data-toc]").forEach((toc) => {
      toc.replaceChildren();
      const title = document.createElement("p");
      title.textContent = t("docs.toc.title");
      toc.append(title);
      if (!headings.length) {
        const empty = document.createElement("p");
        empty.textContent = t("docs.toc.empty");
        toc.append(empty);
        return;
      }
      const list = document.createElement("ol");
      for (const h of headings) {
        const li = document.createElement("li");
        li.dataset.level = h.tagName[1];
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = h.textContent;
        b.onclick = () => h.scrollIntoView({ behavior: "smooth", block: "start" });
        li.append(b);
        list.append(li);
      }
      toc.append(list);
    });
  }, [html, t]);
  // Memoised, and the same object while the HTML is the same: the page around it re-renders often (presence,
  // comments), and React must not write the HTML again over the folds and contents built above.
  const inner = useMemo(() => ({ __html: html }), [html]);
  return <div ref={ref} className={cx(docProse, readOnly)} dangerouslySetInnerHTML={inner} />;
});
