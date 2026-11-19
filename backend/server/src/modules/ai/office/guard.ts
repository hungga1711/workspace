/**
 * The checks an Office file passes before anything opens it. A .docx, .xlsx or .pptx is a zip of XML
 * that came from someone else: it may claim to be far larger than it is (a zip bomb), carry macros, or point outside
 * itself. Only the zip's directory is read here, nothing is inflated.
 */

export type OfficeKind = "docx" | "xlsx" | "pptx";

/** The largest Office file the tools open or write. */
export const OFFICE_MAX_BYTES = 15 * 1024 * 1024;
/** What all of its parts may add up to once unpacked. */
const UNPACKED_MAX = 150 * 1024 * 1024;
const ENTRIES_MAX = 4000;
/** How much smaller than its content a large part may be (real Office XML compresses about 10–20 times). */
const RATIO_MAX = 120;

export const MIME: Record<OfficeKind, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** The kind a file name says, or null (the macro-enabled .docm/.xlsm/.pptm and the legacy binary formats are not ours). */
export function kindOf(name: string): OfficeKind | null {
  const m = /\.(docx|xlsx|pptx)$/i.exec(name.trim());
  return m ? (m[1]!.toLowerCase() as OfficeKind) : null;
}

export class OfficeRefused extends Error {}

interface Entry {
  name: string;
  compressed: number;
  size: number;
}

/** The zip's directory, read without inflating anything; null when the bytes are not a zip. */
export function zipEntries(buf: Buffer): Entry[] | null {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66_000); i--)
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const out: Entry[] = [];
  for (let n = 0; n < count; n++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50) return null;
    const nameLen = buf.readUInt16LE(at + 28);
    out.push({ name: buf.toString("utf8", at + 46, at + 46 + nameLen), compressed: buf.readUInt32LE(at + 20), size: buf.readUInt32LE(at + 24) });
    at += 46 + nameLen + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
  }
  return out;
}

/**
 * Throws OfficeRefused with a reason the model can pass on when the file must not be opened: not that kind, too large,
 * a bomb, encrypted, or with macros. Returns the kind.
 */
export function checkOffice(buf: Buffer, name: string): OfficeKind {
  if (/\.(docm|xlsm|pptm|xlsb|dotm|xltm|potm)$/i.test(name)) throw new OfficeRefused(`${name} has macros; macro-enabled files are not opened. Save it as .docx/.xlsx/.pptx first.`);
  if (/\.(doc|xls|ppt)$/i.test(name)) throw new OfficeRefused(`${name} is an old binary Office format; save it as .docx/.xlsx/.pptx first.`);
  const kind = kindOf(name);
  if (!kind) throw new OfficeRefused(`${name} is not a Word, Excel or PowerPoint file (.docx, .xlsx, .pptx).`);
  if (buf.length > OFFICE_MAX_BYTES) throw new OfficeRefused(`${name} is larger than ${OFFICE_MAX_BYTES / 1024 / 1024} MB.`);
  // A password-protected Office file is an OLE container, not a zip.
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0xd0cf11e0) throw new OfficeRefused(`${name} is password-protected or in an old format and cannot be opened.`);
  const entries = zipEntries(buf);
  if (!entries) throw new OfficeRefused(`${name} is damaged or not really a ${kind} file.`);
  if (entries.length > ENTRIES_MAX) throw new OfficeRefused(`${name} has too many parts to open safely.`);
  let total = 0;
  for (const e of entries) {
    total += e.size;
    if (e.size > 1_000_000 && e.size / Math.max(1, e.compressed) > RATIO_MAX) throw new OfficeRefused(`${name} unpacks to far more than its size (a zip bomb); not opened.`);
    if (/vbaProject\.bin$|activeX\//i.test(e.name)) throw new OfficeRefused(`${name} contains macros or ActiveX controls; not opened.`);
  }
  if (total > UNPACKED_MAX) throw new OfficeRefused(`${name} unpacks to more than ${UNPACKED_MAX / 1024 / 1024} MB; not opened.`);
  const root = kind === "docx" ? "word/document.xml" : kind === "xlsx" ? "xl/workbook.xml" : "ppt/presentation.xml";
  if (!entries.some((e) => e.name === root)) throw new OfficeRefused(`${name} is not a valid ${kind} file.`);
  return kind;
}
