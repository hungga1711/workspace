/**
 * Zip archives for the Office files the tools write or change, with JSZip loaded on first use. Reading
 * for analysis uses service-kit's directory reader; this is only for building a file.
 */

type JSZipT = typeof import("jszip");
let lib: Promise<JSZipT> | null = null;
export const loadZipLib = () => (lib ??= import("jszip").then((m) => ((m as unknown as { default?: JSZipT }).default ?? m) as JSZipT));

/** Every part of an archive: XML and relationship parts as text, the rest (pictures, embedded files) as bytes. */
export async function openZip(buf: Buffer): Promise<Map<string, string | Buffer>> {
  const JSZip = await loadZipLib();
  const zip = await JSZip.loadAsync(buf);
  const out = new Map<string, string | Buffer>();
  for (const [name, f] of Object.entries(zip.files)) {
    if (f.dir) continue;
    out.set(name, /\.(xml|rels)$/i.test(name) ? await f.async("string") : await f.async("nodebuffer"));
  }
  return out;
}

/** An archive from its parts; "[Content_Types].xml" goes first, as Office expects. */
export async function makeZip(parts: Map<string, string | Buffer>): Promise<Buffer> {
  const JSZip = await loadZipLib();
  const zip = new JSZip();
  const names = [...parts.keys()].sort((a, b) => (a === "[Content_Types].xml" ? -1 : b === "[Content_Types].xml" ? 1 : 0));
  for (const n of names) zip.file(n, parts.get(n)!);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
}
