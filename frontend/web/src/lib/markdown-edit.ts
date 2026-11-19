/** Pure text edits behind the Markdown toolbar and its shortcuts (unit-tested). */
export type Edit = { text: string; from: number; to: number };

/** Wraps the selection in a Markdown marker, or prefixes every selected line; returns the new text and selection. */
export function applyMarkdown(text: string, a: number, b: number, before: string, after = before, linePrefix = false): Edit {
  if (linePrefix) {
    const start = text.lastIndexOf("\n", a - 1) + 1;
    const block = text
      .slice(start, b)
      .split("\n")
      .map((l, i) => (before === "1. " ? `${i + 1}. ` : before) + l)
      .join("\n");
    return { text: text.slice(0, start) + block + text.slice(b), from: start, to: start + block.length };
  }
  const sel = text.slice(a, b);
  return { text: text.slice(0, a) + before + sel + after + text.slice(b), from: a + before.length, to: a + before.length + sel.length };
}

/** A link around the selection with "url" selected, so typing replaces it. */
export function linkEdit(text: string, a: number, b: number): Edit {
  const label = text.slice(a, b) || "link";
  const next = `${text.slice(0, a)}[${label}](url)${text.slice(b)}`;
  const from = a + label.length + 3;
  return { text: next, from, to: from + 3 };
}

/**
 * Enter inside a list continues it ("- ", "1. " → "2. ", "- [ ] ", "> "); Enter on an empty item ends the list.
 * Returns null when Enter should just break the line.
 */
export function continueList(text: string, caret: number): Edit | null {
  const start = text.lastIndexOf("\n", caret - 1) + 1;
  const line = text.slice(start, caret);
  const m = line.match(/^(\s*)([-*] \[[ xX]\] |[-*] |(\d+)([.)]) |> )/);
  if (!m) return null;
  if (line.trim() === m[0].trim()) {
    // An empty item: drop its marker and leave the list.
    return { text: text.slice(0, start) + text.slice(caret), from: start, to: start };
  }
  const marker = m[3] ? `${m[1]}${Number(m[3]) + 1}${m[4]} ` : /^[-*] \[/.test(m[2]!) ? `${m[1]}- [ ] ` : `${m[1]}${m[2]}`;
  const insert = `\n${marker}`;
  return { text: text.slice(0, caret) + insert + text.slice(caret), from: caret + insert.length, to: caret + insert.length };
}

/** Ticks or unticks the n-th checklist item ("- [ ]" ↔ "- [x]", counting from 0), outside code blocks. */
export function toggleTask(text: string, n: number): string {
  let seen = 0;
  let code = false;
  return text
    .split("\n")
    .map((l) => {
      if (/^```/.test(l)) code = !code;
      if (code) return l;
      const m = l.match(/^(\s*[-*] \[)([ xX])(\] )/);
      if (!m) return l;
      return seen++ === n ? `${m[1]}${m[2] === " " ? "x" : " "}${m[3]}${l.slice(m[0].length)}` : l;
    })
    .join("\n");
}
