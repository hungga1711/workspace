import { inflateRawSync } from "node:zlib";

/**
 * The text of the Office formats (Word, Excel, PowerPoint), which are zip archives of XML. It lives in service-kit so
 * the work module's workflow reader and the AI module read attachments the same way. Enough to read what a document
 * says; never its layout. No dependency: the zip directory is read by hand and each part inflated on demand.
 */

// ── Zip (the Office formats) ─────────────────────────────────────────────────────────────────────────

/** The entries of a zip archive by name, read from its central directory; an entry inflates when asked for. */
export function unzip(buf: Buffer): Map<string, () => Buffer> {
  const out = new Map<string, () => Buffer>();
  // The end-of-central-directory record is in the last 64 KB.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66_000); i--)
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) return out;
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && at + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) break;
    const method = buf.readUInt16LE(at + 10);
    const compressed = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLen);
    at += 46 + nameLen + extraLen + commentLen;
    // One part of a document is never this large; a zip that claims so is not read (a zip bomb).
    if (size > 60 * 1024 * 1024) continue;
    out.set(name, () => {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + compressed);
      return method === 0 ? data : inflateRawSync(data, { maxOutputLength: 60 * 1024 * 1024 });
    });
  }
  return out;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s: string) =>
  s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1]!.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENTITIES[e] ?? m),
  );
const runs = (xml: string, tag: string) => [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, "g"))].map((m) => decode(m[1]!)).join("");

/** A Word document: its paragraphs, table cells tab-separated. */
function docxText(zip: Map<string, () => Buffer>): string {
  const xml = zip.get("word/document.xml")?.().toString("utf8") ?? "";
  return xml
    .split(/<\/w:p>/)
    .map((p) =>
      runs(
        p
          .replace(/<w:tab\/>/g, "<w:t>\t</w:t>")
          .replace(/<w:br\/>/g, "<w:t>\n</w:t>")
          .replace(/<\/w:tc>/g, "<w:t>\t</w:t>"),
        "w:t",
      ).trimEnd(),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A presentation: each slide's text under its number. */
function pptxText(zip: Map<string, () => Buffer>): string {
  const slides = [...zip.keys()].filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k)).sort((a, b) => Number(/\d+/.exec(a.slice(16))![0]) - Number(/\d+/.exec(b.slice(16))![0]));
  return slides
    .map((k, i) => {
      const xml = zip.get(k)!().toString("utf8");
      const lines = xml
        .split(/<\/a:p>/)
        .map((p) => runs(p, "a:t").trim())
        .filter(Boolean);
      return lines.length ? `Slide ${i + 1}\n${lines.join("\n")}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

/** A workbook: each sheet as comma-separated rows (values as stored: formulas give their last result). */
function xlsxText(zip: Map<string, () => Buffer>): string {
  const shared = (zip.get("xl/sharedStrings.xml")?.().toString("utf8") ?? "").split(/<\/si>/).map((si) => runs(si, "t"));
  const names = [...(zip.get("xl/workbook.xml")?.().toString("utf8") ?? "").matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((m) => decode(m[1]!));
  const sheets = [...zip.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort((a, b) => Number(/\d+/.exec(a.slice(19))![0]) - Number(/\d+/.exec(b.slice(19))![0]));
  const col = (ref: string) => [...ref.replace(/\d+/g, "")].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  const csv = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return sheets
    .map((k, i) => {
      const xml = zip.get(k)!().toString("utf8");
      const rows: string[] = [];
      for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
        const cells: string[] = [];
        for (const c of row[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          const attrs = c[1]!;
          const at = col(/\br="([A-Z]+)\d+"/.exec(attrs)?.[1] ?? "");
          const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
          const body = c[2] ?? "";
          const v = /<v>([^<]*)<\/v>/.exec(body)?.[1] ?? "";
          const value = type === "s" ? (shared[Number(v)] ?? "") : type === "inlineStr" ? runs(body, "t") : decode(v);
          if (at >= 0 && at < 200) cells[at] = value;
          else cells.push(value);
        }
        if (cells.some((x) => x)) rows.push(Array.from(cells, (x) => csv(x ?? "")).join(","));
        if (rows.length >= 5000) break;
      }
      return rows.length ? `Sheet: ${names[i] ?? i + 1}\n${rows.join("\n")}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

/** A .docx, .xlsx or .pptx file's text by its name; null for anything else or a damaged file. Never throws. */
export function officeText(buf: Buffer, name: string): string | null {
  if (!/\.(docx|xlsx|pptx)$/i.test(name)) return null;
  try {
    const zip = unzip(buf);
    const text = (/\.docx$/i.test(name) ? docxText(zip) : /\.pptx$/i.test(name) ? pptxText(zip) : xlsxText(zip)).split("\0").join("").trim();
    return text || null;
  } catch {
    return null;
  }
}
