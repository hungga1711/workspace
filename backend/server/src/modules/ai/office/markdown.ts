import type { DocBlock } from "./read.js";

/**
 * The little Markdown the model writes a document in: headings, paragraphs, bullet and numbered lists
 * (two spaces or a tab per level), tables, `---` page breaks and **bold** / *italic* inside a line. Every model can
 * write it, and the Word and PowerPoint builders read it the same way.
 */

export type Inline = { text: string; bold?: boolean; italic?: boolean };
export type MdBlock =
  | { type: "heading"; level: number; text: string }
  | { type: "p"; text: string; list?: "bullet" | "number"; level?: number }
  | { type: "table"; rows: string[][] }
  | { type: "break" };

/** **bold**, *italic* and ***both*** of one line; anything unclosed stays as written. */
export function inlines(line: string): Inline[] {
  // `code` reads as its text in a document or on a slide; links as their words.
  line = line.replace(/`([^`]+)`/g, "$1").replace(/\[([^\]]+)\]\((?:https?:\/\/|\/)[^)]*\)/g, "$1");
  const out: Inline[] = [];
  const re = /(\*\*\*|\*\*|\*|__|_)(?=\S)([\s\S]*?\S)\1/g;
  let at = 0;
  for (const m of line.matchAll(re)) {
    if (m.index! > at) out.push({ text: line.slice(at, m.index) });
    const mark = m[1]!;
    out.push({ text: m[2]!, ...(mark.length >= 2 ? { bold: true } : {}), ...(mark.length !== 2 ? { italic: true } : {}) });
    at = m.index! + m[0].length;
  }
  if (at < line.length) out.push({ text: line.slice(at) });
  return out.filter((x) => x.text);
}

export const plain = (line: string) =>
  inlines(line)
    .map((x) => x.text)
    .join("");

const row = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

export function parseMarkdown(md: string): MdBlock[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: MdBlock[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ type: "p", text: para.join(" ").trim() });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line) || /^\\?pagebreak$/i.test(line)) {
      flush();
      out.push({ type: "break" });
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      out.push({ type: "heading", level: h[1]!.length, text: h[2]!.replace(/\s+#+$/, "") });
      continue;
    }
    if (line.startsWith("|")) {
      flush();
      const rows: string[][] = [];
      for (; i < lines.length && lines[i]!.trim().startsWith("|"); i++) {
        const cells = row(lines[i]!);
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
      }
      i--;
      if (rows.length) out.push({ type: "table", rows });
      continue;
    }
    const li = /^(\s*)([-*+•]|\d+[.)])\s+(.*)$/.exec(raw);
    if (li) {
      flush();
      const indent = li[1]!.replace(/\t/g, "  ").length;
      out.push({ type: "p", text: li[3]!, list: /\d/.test(li[2]!) ? "number" : "bullet", level: Math.min(4, Math.floor(indent / 2)) });
      continue;
    }
    para.push(line);
  }
  flush();
  return out;
}

/** A read document back as the same Markdown (docx → md). */
export function blocksToMarkdown(blocks: DocBlock[]): string {
  return blocks
    .map((b) =>
      b.type === "heading"
        ? `${"#".repeat(Math.max(1, b.level))} ${b.text}`
        : b.type === "break"
          ? "---"
          : b.type === "table"
            ? b.rows.map((r, i) => `| ${r.map((c) => c.replace(/\|/g, "/").replace(/\n/g, " ")).join(" | ")} |${i === 0 ? `\n|${r.map(() => "---").join("|")}|` : ""}`).join("\n")
            : `${b.list === "bullet" ? "- " : b.list === "number" ? "1. " : ""}${b.text}`,
    )
    .join("\n\n");
}
