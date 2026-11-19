import { OFFICE_MAX_BYTES, OfficeRefused } from "./guard.js";

/**
 * A PDF read as its text, page by page, for the Office tools and Hỏi đáp attachments. pdf.js (through
 * unpdf) is loaded on the first PDF only. A PDF comes from someone else, so it is capped in size and pages, opened
 * without system fonts or font faces, and a password, damage or a scan with no text layer is refused with a reason the
 * model can pass on.
 */

export interface PdfPage {
  n: number;
  text: string;
}
export interface PdfRead {
  kind: "pdf";
  pages: PdfPage[];
  /** Pages in the file; more than `pages.length` when it was longer than PDF_PAGES_MAX. */
  total: number;
  /** Almost no text on any page: a scan or photos, whose words only a model that sees images can read. */
  scanned: boolean;
}

export const PDF_PAGES_MAX = 300;
/** Below this many letters a page on average, the PDF is pictures of pages (a real page of text has hundreds; a slide a few dozen). */
const SCAN_CHARS = 5;

export const isPdf = (name: string, data?: Buffer) => /\.pdf$/i.test(name.trim()) || (!!data && data.subarray(0, 1024).includes("%PDF-"));

/** One page's text: pdf.js items joined, a line break where the item ends a line. */
function pageText(items: { str?: string; hasEOL?: boolean }[]): string {
  let out = "";
  for (const it of items) {
    if (typeof it.str !== "string") continue;
    out += it.str + (it.hasEOL ? "\n" : "");
  }
  return out
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replaceAll("\u0000", "")
    .trim();
}

export async function readPdf(buf: Buffer, name: string, maxPages = PDF_PAGES_MAX): Promise<PdfRead> {
  if (buf.length > OFFICE_MAX_BYTES) throw new OfficeRefused(`${name} is larger than ${OFFICE_MAX_BYTES / 1024 / 1024} MB.`);
  if (!buf.subarray(0, 1024).includes("%PDF-")) throw new OfficeRefused(`${name} is damaged or not really a PDF.`);
  const { getDocumentProxy } = await import("unpdf");
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    pdf = await getDocumentProxy(new Uint8Array(buf), { disableFontFace: true, useSystemFonts: false, stopAtErrors: false, verbosity: 0 });
  } catch (e) {
    const n = (e as { name?: string }).name ?? "";
    if (n === "PasswordException") throw new OfficeRefused(`${name} is password-protected; open it, save a copy without the password, and attach that.`);
    throw new OfficeRefused(`${name} could not be read: it may be damaged.`);
  }
  try {
    const total = pdf.numPages;
    const pages: PdfPage[] = [];
    for (let n = 1; n <= Math.min(total, maxPages); n++) {
      try {
        const page = await pdf.getPage(n);
        const content = await page.getTextContent();
        pages.push({ n, text: pageText(content.items as { str?: string; hasEOL?: boolean }[]) });
        page.cleanup();
      } catch {
        // One broken page does not lose the rest.
        pages.push({ n, text: "" });
      }
    }
    const letters = pages.reduce((s, p) => s + p.text.replace(/\s/g, "").length, 0);
    return { kind: "pdf", pages, total, scanned: !pages.length || letters / pages.length < SCAN_CHARS };
  } finally {
    // Frees pdf.js's worker-side copy of the file (named differently across pdf.js versions).
    const p = pdf as unknown as { destroy?: () => Promise<void>; cleanup?: () => Promise<void> };
    await (p.destroy ?? p.cleanup)?.call(pdf).catch(() => undefined);
  }
}

/** A PDF as plain text with page markers, for a model that reads the file with the question. */
export function pdfAsText(r: PdfRead, name: string): string {
  if (r.scanned) return scanNote(name);
  const body = r.pages
    .filter((p) => p.text)
    .map((p) => `--- Page ${p.n} ---\n${p.text}`)
    .join("\n\n");
  return r.total > r.pages.length ? `${body}\n\n(Only the first ${r.pages.length} of ${r.total} pages were read.)` : body;
}

export const scanNote = (name: string) =>
  `${name} has no text layer: it is a scan or photos of pages, so its words cannot be read as text. Ask the person to attach the pages as images (screenshots or photos) instead, which a model that sees images can read.`;
