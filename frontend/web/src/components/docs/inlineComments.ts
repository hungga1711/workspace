/**
 * Inline comments on a page: the text a comment quotes is found in the rendered page
 * and painted with the CSS Custom Highlight API, so the editor's DOM is never touched. Text spread over
 * several nodes (bold inside a sentence) is matched across them.
 */

/** A Range for the first place `quote` appears in `root`'s text, or null. Whitespace runs match loosely. */
export function findQuote(root: Element, quote: string): Range | null {
  const needle = quote.replace(/\s+/g, " ").trim();
  if (needle.length < 2) return null;
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
  // One flat string with a map back to (node, offset), collapsing whitespace like the needle.
  let flat = "";
  const map: { node: Text; offset: number }[] = [];
  for (const node of nodes) {
    const text = node.data;
    for (let i = 0; i < text.length; i++) {
      const ch = /\s/.test(text[i]!) ? " " : text[i]!;
      if (ch === " " && flat.endsWith(" ")) continue;
      flat += ch;
      map.push({ node, offset: i });
    }
  }
  const at = flat.indexOf(needle);
  if (at < 0) return null;
  const start = map[at]!;
  const end = map[at + needle.length - 1]!;
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset + 1);
  return range;
}

const NAME = "doc-comment";

/**
 * The highlight's style lives here, not in globals.css: Turbopack's CSS parser (lightningcss in Next 15.1) rejects
 * the `::highlight()` pseudo-element, and the rule only matters once this code has painted something anyway.
 */
function ensureStyle() {
  if (document.getElementById(`${NAME}-style`)) return;
  const style = document.createElement("style");
  style.id = `${NAME}-style`;
  style.textContent = `::highlight(${NAME}){background-color:var(--accent-wash);text-decoration:underline 2px var(--accent);text-underline-offset:3px}`;
  document.head.append(style);
}

/** Paints every quote of an open comment; returns a cleanup. Browsers without the API just skip it. */
export function paintQuotes(root: Element, quotes: string[]): () => void {
  const api = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights;
  const H = (globalThis as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
  if (!api || !H) return () => undefined;
  ensureStyle();
  const ranges = quotes.map((q) => findQuote(root, q)).filter((r): r is Range => !!r);
  api.set(NAME, new H(...ranges));
  return () => api.delete(NAME);
}

/** The selected text inside `root`, trimmed and capped, with where to show the "Bình luận" button. */
export function selectionIn(root: Element): { text: string; rect: DOMRect } | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;
  const text = sel.toString().replace(/\s+/g, " ").trim();
  if (text.length < 3) return null;
  return { text: text.slice(0, 500), rect: range.getBoundingClientRect() };
}
