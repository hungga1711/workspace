"use client";

import { mergeAttributes, Node } from "@tiptap/core";
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n/client";
import { cx } from "@/lib/ui";

/**
 * Toggle ("expand"): the first line is the title, the rest folds away.
 * Folding is per view (not saved), in the editor and when reading.
 */
function ToggleView() {
  const t = useT();
  const [open, setOpen] = useState(true);
  return (
    <NodeViewWrapper
      className={cx("my-2 flex items-start gap-1", !open && "[&_[data-node-view-content-react]>*:not(:first-child)]:hidden")}
      data-toggle-view=""
      data-collapsed={open ? "false" : "true"}
    >
      <button
        type="button"
        contentEditable={false}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label={open ? t("docs.toggle.collapse") : t("docs.toggle.expand")}
        className="text-ink-2 hover:bg-hover hover:text-ink mt-[5px] grid size-5 shrink-0 place-items-center rounded"
      >
        <svg viewBox="0 0 24 24" className={cx("size-3.5 transition-transform", open && "rotate-90")} fill="currentColor" aria-hidden="true">
          <path d="M9 6l7 6-7 6z" />
        </svg>
      </button>
      <NodeViewContent className="min-w-0 flex-1 [&_[data-node-view-content-react]>*:first-child]:font-semibold" />
    </NodeViewWrapper>
  );
}

export const Toggle = Node.create({
  name: "toggle",
  group: "block",
  content: "block+",
  defining: true,
  parseHTML() {
    return [{ tag: "div[data-toggle]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-toggle": "" }), 0];
  },
  addNodeView() {
    return ReactNodeViewRenderer(ToggleView);
  },
});

/** Table of contents: the page's headings, live, each a link that scrolls to it. */
function TocView({ editor }: NodeViewProps) {
  const t = useT();
  const [items, setItems] = useState<{ level: number; text: string; pos: number }[]>([]);
  useEffect(() => {
    const read = () => {
      const out: { level: number; text: string; pos: number }[] = [];
      editor.state.doc.descendants((n, pos) => {
        if (n.type.name === "heading" && n.textContent.trim()) out.push({ level: Number(n.attrs.level ?? 1), text: n.textContent, pos });
      });
      setItems(out);
    };
    read();
    editor.on("update", read);
    return () => {
      editor.off("update", read);
    };
  }, [editor]);
  return (
    <NodeViewWrapper contentEditable={false} className="border-hairline bg-hover/40 my-3 rounded-lg border px-4 py-3" data-toc-view="">
      <p className="text-ink-2 m-0 mb-1.5 text-xs font-medium">{t("docs.toc.title")}</p>
      {items.length ? (
        <ol className="m-0 grid list-none gap-0.5 p-0">
          {items.map((h) => (
            <li key={h.pos} style={{ paddingLeft: (h.level - 1) * 16 }}>
              <button
                type="button"
                className="text-brand-text text-left text-sm hover:underline"
                onClick={() => {
                  const el = editor.view.nodeDOM(h.pos) as HTMLElement | null;
                  el?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
              >
                {h.text}
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-ink-2 m-0 text-sm">{t("docs.toc.empty")}</p>
      )}
    </NodeViewWrapper>
  );
}

export const Toc = Node.create({
  name: "toc",
  group: "block",
  atom: true,
  parseHTML() {
    return [{ tag: "div[data-toc]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-toc": "" })];
  },
  addNodeView() {
    return ReactNodeViewRenderer(TocView);
  },
});

/** Page HTML to Markdown for "Tải Markdown" (headings, lists, checklists, tables, code, quotes, links, emphasis). */
export function htmlToMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const inline = (n: ChildNode): string => {
    if (n.nodeType === 3) return (n.textContent ?? "").replace(/([*_`[\]])/g, "\\$1");
    if (n.nodeType !== 1) return "";
    const el = n as HTMLElement;
    const kids = [...el.childNodes].map(inline).join("");
    switch (el.tagName) {
      case "STRONG":
      case "B":
        return `**${kids}**`;
      case "EM":
      case "I":
        return `_${kids}_`;
      case "S":
        return `~~${kids}~~`;
      case "CODE":
        return `\`${el.textContent ?? ""}\``;
      case "A":
        return `[${kids}](${el.getAttribute("href") ?? ""})`;
      case "IMG":
        return `![${el.getAttribute("alt") ?? ""}](${el.getAttribute("src") ?? ""})`;
      case "BR":
        return "  \n";
      default:
        return kids;
    }
  };
  const block = (el: HTMLElement, depth = 0): string => {
    const pad = "  ".repeat(depth);
    switch (el.tagName) {
      case "H1":
      case "H2":
      case "H3":
        return `${"#".repeat(Number(el.tagName[1]))} ${inline(el)}\n\n`;
      case "P":
        return `${inline(el)}\n\n`;
      case "BLOCKQUOTE":
        return (
          [...el.children]
            .map((c) => block(c as HTMLElement).trim())
            .join("\n")
            .split("\n")
            .map((l) => `> ${l}`)
            .join("\n") + "\n\n"
        );
      case "PRE":
        return `\`\`\`\n${el.textContent ?? ""}\n\`\`\`\n\n`;
      case "HR":
        return "---\n\n";
      case "UL":
      case "OL": {
        const task = el.getAttribute("data-type") === "taskList";
        const items = [...el.children].map((li, i) => {
          const l = li as HTMLElement;
          const mark = task ? `- [${l.getAttribute("data-checked") === "true" ? "x" : " "}] ` : el.tagName === "OL" ? `${i + 1}. ` : "- ";
          const text = [...l.childNodes]
            .filter((c) => !(c.nodeType === 1 && ["UL", "OL", "LABEL"].includes((c as HTMLElement).tagName)))
            .map((c) =>
              c.nodeType === 1 && (c as HTMLElement).tagName === "DIV"
                ? [...c.childNodes].map((x) => (x.nodeType === 1 && (x as HTMLElement).tagName === "P" ? inline(x) : "")).join(" ")
                : c.nodeType === 1 && (c as HTMLElement).tagName === "P"
                  ? inline(c)
                  : inline(c),
            )
            .join(" ")
            .trim();
          const nested = [...l.querySelectorAll(":scope > ul, :scope > ol, :scope > div > ul, :scope > div > ol")].map((x) => block(x as HTMLElement, depth + 1)).join("");
          return `${pad}${mark}${text}\n${nested}`;
        });
        return items.join("") + (depth ? "" : "\n");
      }
      case "TABLE": {
        const rows = [...el.querySelectorAll("tr")].map((tr) => [...tr.children].map((c) => inline(c).replace(/\|/g, "\\|").trim()));
        if (!rows.length) return "";
        const head = rows[0]!;
        return [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.slice(1).map((r) => `| ${r.join(" | ")} |`)].join("\n") + "\n\n";
      }
      case "DIV":
        if (el.hasAttribute("data-toc")) return "";
        if (el.hasAttribute("data-callout")) {
          return (
            [...el.children]
              .map((c) => block(c as HTMLElement).trim())
              .join("\n")
              .split("\n")
              .map((l) => `> ${l}`)
              .join("\n") + "\n\n"
          );
        }
        return [...el.children].map((c) => block(c as HTMLElement, depth)).join("");
      default:
        return `${inline(el)}\n\n`;
    }
  };
  return [...doc.body.firstElementChild!.children]
    .map((c) => block(c as HTMLElement))
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
