import { OfficeRefused, checkOffice } from "./guard.js";
import { loadZipLib as load } from "./zip.js";

/**
 * Filling a Word template: every {{name}} in the body, headers and footers takes its value and keeps the
 * formatting of the text around it. Word often splits "{{name}}" over several runs (spell check, an edit in the
 * middle); the parts are joined within the paragraph so such a placeholder is still found. Macros never survive:
 * checkOffice refuses a file that has them.
 */

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const unesc = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
const key = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

/** The placeholders a paragraph's XML holds, with the values put in; `used` collects the names found. */
export function fillParagraph(p: string, values: Map<string, string>, used: Set<string>, missing: Set<string>): string {
  const nodes = [...p.matchAll(/(<w:t(?:\s[^>]*)?>)([^<]*)(<\/w:t>)/g)];
  if (!nodes.length) return p;
  const texts = nodes.map((n) => unesc(n[2]!));
  const joined = texts.join("");
  if (!joined.includes("{{")) return p;
  // Where each node's text starts in the joined text.
  const starts: number[] = [];
  texts.reduce((at, t) => (starts.push(at), at + t.length), 0);
  const nodeAt = (pos: number) => {
    let i = 0;
    while (i + 1 < starts.length && starts[i + 1]! <= pos) i++;
    return i;
  };
  const matches = [...joined.matchAll(/\{\{\s*([^{}]{1,80}?)\s*\}\}/g)];
  for (const m of matches.reverse()) {
    const name = m[1]!;
    const value = values.get(key(name));
    if (value === undefined) {
      missing.add(name);
      continue;
    }
    used.add(name);
    const from = m.index!;
    const to = from + m[0].length;
    const a = nodeAt(from);
    const b = nodeAt(to - 1);
    // The value goes where the placeholder starts (keeping that run's formatting); the rest of it is taken out.
    texts[a] = texts[a]!.slice(0, from - starts[a]!) + value + (a === b ? texts[a]!.slice(to - starts[a]!) : "");
    for (let i = a + 1; i < b; i++) texts[i] = "";
    if (b > a) texts[b] = texts[b]!.slice(to - starts[b]!);
  }
  let i = 0;
  return p.replace(/(<w:t)((?:\s[^>]*)?)>([^<]*)(<\/w:t>)/g, (_m, open: string, attrs: string, _t: string, close: string) => {
    const t = texts[i++] ?? "";
    // Leading or trailing spaces in a value must survive.
    const keep = /^\s|\s$/.test(t) && !/xml:space/.test(attrs) ? ' xml:space="preserve"' : "";
    return `${open}${attrs}${keep}>${esc(t).replace(/\n/g, "</w:t><w:br/><w:t>")}${close}`;
  });
}

export interface FillResult {
  buffer: Buffer;
  used: string[];
  missing: string[];
}

/** The template with its placeholders filled; `values` by placeholder name (any case, with or without accents). */
export async function fillTemplate(buf: Buffer, name: string, values: Record<string, string | number | null>): Promise<FillResult> {
  if (checkOffice(buf, name) !== "docx") throw new OfficeRefused(`${name} is not a Word file; only .docx templates can be filled.`);
  const JSZip = await load();
  const zip = await JSZip.loadAsync(buf);
  const map = new Map(Object.entries(values).map(([k, v]) => [key(k), v === null || v === undefined ? "" : String(v)]));
  const used = new Set<string>();
  const missing = new Set<string>();
  const parts = Object.keys(zip.files).filter((p) => /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(p));
  for (const part of parts) {
    const xml = await zip.file(part)!.async("string");
    zip.file(
      part,
      xml.replace(/<w:p\b[^>]*\/>|<w:p\b[\s\S]*?<\/w:p>/g, (p) => fillParagraph(p, map, used, missing)),
    );
  }
  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return { buffer, used: [...used], missing: [...missing].filter((m) => !used.has(m)) };
}

/** The placeholders a template asks for, in order of appearance. */
export async function placeholdersOf(buf: Buffer, name: string): Promise<string[]> {
  if (checkOffice(buf, name) !== "docx") return [];
  const JSZip = await load();
  const zip = await JSZip.loadAsync(buf);
  const found: string[] = [];
  for (const part of Object.keys(zip.files).filter((p) => /^word\/(document|header\d*|footer\d*)\.xml$/.test(p))) {
    const xml = await zip.file(part)!.async("string");
    for (const p of xml.match(/<w:p\b[\s\S]*?<\/w:p>/g) ?? []) {
      const text = [...p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => unesc(m[1]!)).join("");
      for (const m of text.matchAll(/\{\{\s*([^{}]{1,80}?)\s*\}\}/g)) if (!found.includes(m[1]!)) found.push(m[1]!);
    }
  }
  return found;
}

/** A zip of several files (mail merge results). */
export async function zipFiles(files: { name: string; data: Buffer }[]): Promise<Buffer> {
  const JSZip = await load();
  const zip = new JSZip();
  const seen = new Set<string>();
  for (const f of files) {
    let n = f.name;
    for (let i = 2; seen.has(n); i++) n = f.name.replace(/(\.\w+)$/, ` (${i})$1`);
    seen.add(n);
    zip.file(n, f.data);
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
