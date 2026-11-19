import { Fragment } from "react";
import { CodeBlock } from "./markdown-code";

/**
 * Small, safe Markdown renderer for documents: headings, lists and checklists, quotes, code,
 * bold/italic/strike/code/links, and pictures stored with a task (/app/files/<id>). Produces React elements (no HTML injection).
 */
// Links: http(s) or a path on this site; "//host" and "/\\host" are other sites dressed as paths, so they stay text.
function inline(text: string, key: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re =
    /(!\[[^\]]*\]\((?:\/app\/files\/[\w-]+|https?:\/\/[^)\s]+)\)|\*\*[^*]+\*\*|~~[^~]+~~|\*[^*]+\*|(?<![\w])_[^_\n]+_(?![\w])|`[^`]+`|\[[^\]]+\]\((https?:\/\/[^)\s]+|\/(?![/\\])[^)\s]*)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    const k = `${key}-${i++}`;
    // A picture pasted into a task (only this site's file links: /app/files/<id>, which checks who may see it).
    if (t.startsWith("![")) {
      const im = t.match(/^!\[([^\]]*)\]\(([^)]+)\)$/)!;
      // A picture on another site: the page's CSP loads pictures only from here, so it is a link to open it.
      if (/^https?:/.test(im[2]!))
        out.push(
          <a key={k} href={im[2]} target="_blank" rel="noopener noreferrer" className="inline-flex items-baseline gap-1">
            <span aria-hidden="true">🖼</span>
            {im[1] || new URL(im[2]!).hostname}
          </a>,
        );
      else
        out.push(
          <a key={k} href={im[2]} target="_blank" rel="noopener noreferrer" className="my-1 block w-fit">
            <img src={im[2]} alt={im[1] ?? ""} loading="lazy" className="border-hairline max-h-80 max-w-full rounded-lg border" />
          </a>,
        );
    } else if (t.startsWith("**")) out.push(<strong key={k}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith("~~")) out.push(<s key={k}>{t.slice(2, -2)}</s>);
    else if (t.startsWith("`"))
      out.push(
        <code key={k} className="bg-hover rounded-sm px-1 font-mono text-[0.9em]">
          {t.slice(1, -1)}
        </code>,
      );
    else if (t.startsWith("[")) {
      const lm = t.match(/^\[([^\]]+)\]\(([^)]+)\)$/)!;
      out.push(
        <a key={k} href={lm[2]} rel="noopener noreferrer" target={lm[2]!.startsWith("http") ? "_blank" : undefined}>
          {lm[1]}
        </a>,
      );
    } else out.push(<em key={k}>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

/** A GFM table row's cells: the outer pipes are optional, `\|` is a literal pipe. */
const cells = (row: string) =>
  row
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, "|"));

const isTableAt = (lines: string[], i: number) => lines[i]!.includes("|") && i + 1 < lines.length && lines[i + 1]!.includes("-") && TABLE_SEP.test(lines[i + 1]!);

/** Where a paragraph stops: a blank line or the start of any other block. */
const startsBlock = (lines: string[], i: number) => {
  const l = lines[i]!;
  return !l.trim() || /^(#{1,6}\s| {0,3}```|>)/.test(l) || RULE.test(l) || LIST_ITEM.test(l) || isTableAt(lines, i);
};

export interface MarkdownProps {
  source: string;
  /**
   * `onToggleTask` makes checklist items clickable: it gets the item's index among all checklist items (the order
   * `toggleTask` in markdown-edit.ts counts in). Without it the boxes only show the state.
   */
  onToggleTask?: (n: number) => void;
  /** Labels for a copy button on code blocks (AI answers); without them code blocks have none. */
  copyCode?: { label: string; done: string };
}

/**
 * Lists nest by indentation (two or more spaces deeper than their parent's marker), an ordered list keeps its first
 * number, and blank lines between items do not end the list: AI answers write "1. …\n\n2. …" and must not read
 * as three lists that each start at 1.
 */
export function Markdown({ source, onToggleTask, copyCode }: MarkdownProps) {
  let task = 0;
  let key = 0;
  // Blocks from lines; a code block or table indented under a list item is parsed the same way, as the item's child.
  const parse = (lines: string[]): React.ReactNode[] => {
    const list = (from: number, indent: number): [React.ReactNode, number] => {
      const first = lines[from]!.match(LIST_ITEM)!;
      const ordered = /\d/.test(first[2]!);
      const items: { text: string; children: React.ReactNode[] }[] = [];
      let i = from;
      while (i < lines.length) {
        const line = lines[i]!;
        if (!line.trim()) {
          // A blank line ends the list unless more of it (an item, or text indented under the last one) follows.
          let j = i;
          while (j < lines.length && !lines[j]!.trim()) j++;
          const next = lines[j]?.match(LIST_ITEM);
          const indentOf = j < lines.length ? lines[j]!.length - lines[j]!.trimStart().length : -1;
          if ((next && indentOf >= indent && /\d/.test(next[2]!) === ordered) || (next && indentOf >= indent + 2) || (!next && indentOf >= indent + 2)) {
            i = j;
            continue;
          }
          break;
        }
        const m = line.match(LIST_ITEM);
        const at = line.length - line.trimStart().length;
        if (!m) {
          // A fence or a table indented under an item belongs to it (AI answers nest them: "- Result:\n  ```").
          const lead = line.trimStart();
          if (at >= indent + 2 && items.length && (lead.startsWith("```") || (lead.includes("|") && TABLE_SEP.test(lines[i + 1] ?? "") && lines[i + 1]!.includes("-")))) {
            const sub: string[] = [];
            if (lead.startsWith("```")) {
              sub.push(lines[i++]!);
              while (i < lines.length && !lines[i]!.trimStart().startsWith("```")) sub.push(lines[i++]!);
              if (i < lines.length) sub.push(lines[i++]!);
            } else while (i < lines.length && lines[i]!.trim() && lines[i]!.includes("|")) sub.push(lines[i++]!);
            const cut = (l: string) => l.slice(Math.min(at, l.length - l.trimStart().length));
            items.at(-1)!.children.push(<Fragment key={`n${key++}`}>{parse(sub.map(cut))}</Fragment>);
            continue;
          }
          // Text indented under an item continues it; anything else ends the list.
          if (at >= indent + 2 && items.length) {
            items.at(-1)!.text += ` ${line.trim()}`;
            i++;
            continue;
          }
          break;
        }
        if (at < indent) break;
        if (at >= indent + 2 && items.length) {
          const [child, next] = list(i, at);
          items.at(-1)!.children.push(child);
          i = next;
          continue;
        }
        if (/\d/.test(m[2]!) !== ordered) break;
        items.push({ text: m[3]!, children: [] });
        i++;
      }
      const k = `l${key++}`;
      const L = ordered ? "ol" : "ul";
      const start = ordered ? parseInt(first[2]!, 10) : 1;
      const node = (
        <L key={k} start={start !== 1 ? start : undefined} className={`my-2 grid gap-1 pl-6 ${ordered ? "list-decimal" : "list-disc"} [&_ol]:my-1 [&_ul]:my-1`}>
          {items.map((it, n) => {
            const box = it.text.match(/^\[([ xX])\]\s+(.*)$/);
            if (!box)
              return (
                <li key={n}>
                  {inline(it.text, `${k}-${n}`)}
                  {it.children}
                </li>
              );
            const index = task++;
            const done = box[1] !== " ";
            return (
              <li key={n} className="-ml-6 list-none">
                <span className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="accent-brand mt-[0.4em] size-4 shrink-0"
                    checked={done}
                    disabled={!onToggleTask}
                    onChange={() => onToggleTask?.(index)}
                    aria-label={box[2]}
                  />
                  <span className={done ? "text-ink-2 line-through" : undefined}>{inline(box[2]!, `${k}-${n}`)}</span>
                </span>
                {it.children.length ? <div className="pl-6">{it.children}</div> : null}
              </li>
            );
          })}
        </L>
      );
      return [node, i];
    };

    const blocks: React.ReactNode[] = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i]!;
      const k = `b${key++}`;
      if (!line.trim()) {
        i++;
        continue;
      }
      if (/^ {0,3}```/.test(line)) {
        const lang = line.trimStart().slice(3).trim().split(/\s/)[0] ?? "";
        const body: string[] = [];
        i++;
        while (i < lines.length && !lines[i]!.trimStart().startsWith("```")) body.push(lines[i++]!);
        i++;
        // A table the AI fenced as plain text reads better as a table.
        const rows = body.filter((l) => l.trim());
        if ((!lang || lang === "markdown" || lang === "md") && rows.length > 1 && rows.every((l) => l.includes("|")) && isTableAt(rows, 0)) blocks.push(...parse(rows));
        else blocks.push(<CodeBlock key={k} code={body.join("\n")} lang={lang} copy={copyCode} />);
        continue;
      }
      if (RULE.test(line)) {
        blocks.push(<hr key={k} className="border-divider my-4 border-t" />);
        i++;
        continue;
      }
      const h = line.match(HEADING);
      if (h) {
        const level = Math.min(h[1]!.length, 4);
        const cls = ["", "mt-6 font-display text-2xl font-semibold tracking-[-0.015em]", "mt-5 text-lg font-semibold", "mt-4 font-semibold", "mt-3 font-semibold"][level];
        const Tag = `h${Math.min(level + 1, 5)}` as "h2" | "h3" | "h4" | "h5";
        blocks.push(
          <Tag key={k} className={cls}>
            {inline(h[2]!, k)}
          </Tag>,
        );
        i++;
        continue;
      }
      if (isTableAt(lines, i)) {
        const head = cells(line);
        const align = cells(lines[i + 1]!).map((c) => (c.endsWith(":") ? (c.startsWith(":") ? "center" : "right") : "left") as "left" | "center" | "right");
        i += 2;
        const rows: string[][] = [];
        while (i < lines.length && lines[i]!.trim() && lines[i]!.includes("|")) rows.push(cells(lines[i++]!));
        const ALIGN = { left: "text-left", center: "text-center", right: "text-right" } as const;
        blocks.push(
          // Wide tables scroll inside their own box, never the page; the box takes focus so keyboards can scroll it.
          <div key={k} tabIndex={0} className="border-hairline my-3 overflow-x-auto rounded-lg border">
            <table className="w-full border-collapse text-sm">
              <thead className="bg-hover/60">
                <tr>
                  {head.map((c, n) => (
                    <th key={n} className={`border-divider whitespace-nowrap border-b px-3 py-2 font-semibold ${ALIGN[align[n] ?? "left"]}`}>
                      {inline(c, `${k}-h${n}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, y) => (
                  <tr key={y} className="border-divider-soft border-b last:border-b-0">
                    {head.map((_, n) => (
                      <td
                        key={n}
                        // Short cells (numbers, dates, names) stay on one line; on a phone the table scrolls instead.
                        className={`px-3 py-2 align-top ${(r[n] ?? "").length <= 24 ? "whitespace-nowrap" : "min-w-48"} ${ALIGN[align[n] ?? "left"]}`}
                      >
                        {inline(r[n] ?? "", `${k}-${y}-${n}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>,
        );
        continue;
      }
      const li = line.match(LIST_ITEM);
      if (li) {
        const [node, next] = list(i, li[1]!.length);
        blocks.push(node);
        i = next;
        continue;
      }
      if (line.startsWith(">")) {
        const q: string[] = [];
        while (i < lines.length && lines[i]!.startsWith(">")) q.push(lines[i++]!.replace(/^>\s?/, ""));
        blocks.push(
          <blockquote key={k} className="border-hairline text-ink-2 my-2 border-l-2 pl-3">
            {inline(q.join(" "), k)}
          </blockquote>,
        );
        continue;
      }
      const para: string[] = [];
      while (i < lines.length && (para.length === 0 || !startsBlock(lines, i))) para.push(lines[i++]!);
      blocks.push(
        <p key={k} className="my-2">
          {para.map((p, n) => (
            <Fragment key={n}>
              {n ? <br /> : null}
              {inline(p, `${k}-${n}`)}
            </Fragment>
          ))}
        </p>,
      );
    }
    return blocks;
  };
  return <div className="text-[15px]/[1.7]">{parse(source.replace(/\r\n/g, "\n").replace(/\t/g, "    ").split("\n"))}</div>;
}
