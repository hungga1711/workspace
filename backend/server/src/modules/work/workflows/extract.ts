import { officeText, unzip } from "@workspace/service-kit";

export { unzip };

/**
 * The text of a file a company hands the AI as reference: plain text and data files as they are, PDF (unpdf), and the
 * Office formats (Word, Excel, PowerPoint), which are zip archives of XML. Enough to read what the document says;
 * never its layout. Anything else has no text here (the file is still listed, and a sandbox gets the file itself).
 */

const TEXT_TYPE = /^(text\/|application\/(json|xml|x-yaml|yaml|csv|x-ndjson)$)/i;
const TEXT_EXT = /\.(md|markdown|txt|csv|tsv|json|ya?ml|xml|html?|log|ini|toml)$/i;
const OFFICE_EXT = /\.(docx|xlsx|pptx)$/i;
/** How much of a file is read: text as it is up to 1 MB, documents up to 15 MB (their text is a fraction of that). */
export const TEXT_MAX = 1024 * 1024;
export const DOCUMENT_MAX = 15 * 1024 * 1024;

export type Readable = "text" | "pdf" | "office" | null;

/** How a file's text can be read, by its name and type; null when it has none for us. */
export function readableAs(name: string, contentType: string, size: number): Readable {
  if ((TEXT_TYPE.test(contentType) || TEXT_EXT.test(name)) && size <= TEXT_MAX) return "text";
  if ((contentType === "application/pdf" || /\.pdf$/i.test(name)) && size <= DOCUMENT_MAX) return "pdf";
  if (OFFICE_EXT.test(name) && size <= DOCUMENT_MAX) return "office";
  return null;
}

/** The file's text, or null when it has none we can read (or it is damaged). Never throws. */
export async function textOf(buf: Buffer, name: string, contentType: string): Promise<string | null> {
  try {
    const how = readableAs(name, contentType, buf.length);
    let text: string | null = null;
    if (how === "text") text = buf.toString("utf8");
    else if (how === "pdf") {
      // Loaded on the first PDF only: pdf.js is a few MB the server does not need otherwise.
      const { extractText, getDocumentProxy } = await import("unpdf");
      text = (await extractText(await getDocumentProxy(new Uint8Array(buf)), { mergePages: true })).text;
    } else if (how === "office") {
      text = officeText(buf, name);
    }
    text = text?.split("\0").join("").trim() ?? null;
    return text || null;
  } catch {
    return null;
  }
}
