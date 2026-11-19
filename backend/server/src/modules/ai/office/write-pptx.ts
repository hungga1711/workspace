import { z } from "zod";
import { inlines, parseMarkdown, plain } from "./markdown.js";

/**
 * Presentations from an outline: a title slide, title and bullets, two columns, a table, a picture from
 * an attached image, a section divider, each with optional speaker notes, on a clean 16:9 theme. pptxgenjs is loaded
 * on first use. Pictures are measured here (PNG and JPEG only), never by the library.
 */

type Pptx = typeof import("pptxgenjs").default;
let lib: Promise<Pptx> | null = null;
const load = () => (lib ??= import("pptxgenjs").then((m) => (m as unknown as { default: Pptx }).default ?? (m as unknown as Pptx)));

export const SlideSpec = z.object({
  layout: z.enum(["title", "bullets", "twoColumns", "table", "image", "section"]).default("bullets"),
  title: z.string().max(200).default(""),
  subtitle: z.string().max(300).optional(),
  /** Bullet lines; two leading spaces per level indent one more. **bold** works. */
  bullets: z.array(z.string().max(500)).max(14).optional(),
  leftTitle: z.string().max(120).optional(),
  left: z.array(z.string().max(400)).max(12).optional(),
  rightTitle: z.string().max(120).optional(),
  right: z.array(z.string().max(400)).max(12).optional(),
  /** First row is the header. */
  table: z
    .array(z.array(z.string().max(200)).max(10))
    .max(16)
    .optional(),
  /** The name of an attached image (PNG or JPEG). */
  image: z.string().max(200).optional(),
  notes: z.string().max(4000).optional(),
});
export type SlideSpec = z.infer<typeof SlideSpec>;
export const THEMES = ["light", "dark", "blue"] as const;
export type Theme = (typeof THEMES)[number];

const PALETTE: Record<Theme, { bg: string; title: string; text: string; accent: string; soft: string; headFill: string; headText: string }> = {
  light: { bg: "FFFFFF", title: "1F2A44", text: "333B4F", accent: "4F46E5", soft: "6B7280", headFill: "EEF0F6", headText: "1F2A44" },
  dark: { bg: "151A2D", title: "FFFFFF", text: "D9DEEA", accent: "8B85FF", soft: "9AA3B5", headFill: "2A3150", headText: "FFFFFF" },
  blue: { bg: "F4F7FD", title: "16326B", text: "2B3A57", accent: "1F6FEB", soft: "5B6B88", headFill: "DCE6FA", headText: "16326B" },
};

/** Width and height of a PNG or JPEG, or null for anything else. */
export function imageSize(buf: Buffer): { w: number; h: number; type: "png" | "jpeg" } | null {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), type: "png" };
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1]!;
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
        return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7), type: "jpeg" };
      i += 2 + len;
    }
  }
  return null;
}

const W = 13.333;
const H = 7.5;

/** Bullet lines as pptxgenjs text runs: indent level from leading spaces, **bold** kept. */
function bulletRuns(lines: string[], size: number, color: string) {
  return lines.flatMap((line) => {
    const indent = Math.min(3, Math.floor(/^\s*/.exec(line)![0].replace(/\t/g, "  ").length / 2));
    const text = line.trim().replace(/^[-*•]\s+/, "");
    const parts = inlines(text);
    return parts.map((p, i) => ({
      text: p.text,
      options: {
        ...(i === 0 ? { bullet: true, indentLevel: indent } : {}),
        ...(i === parts.length - 1 ? { breakLine: true } : {}),
        ...(p.bold ? { bold: true } : {}),
        ...(p.italic ? { italic: true } : {}),
        fontSize: indent ? size - 2 : size,
        color,
        paraSpaceAfter: 6,
      },
    }));
  });
}

export async function buildPptx(
  input: { title?: string | undefined; theme?: Theme | undefined; slides: SlideSpec[] },
  images: Map<string, Buffer> = new Map(),
): Promise<{ buffer: Buffer; missing: string[] }> {
  const P = await load();
  const pptx = new P();
  pptx.layout = "LAYOUT_WIDE";
  pptx.title = input.title ?? "Presentation";
  pptx.author = "Workspace AI";
  const c = PALETTE[input.theme ?? "light"];
  const missing: string[] = [];
  const font = "Arial";
  input.slides.forEach((s) => {
    const slide = pptx.addSlide();
    slide.background = { color: s.layout === "title" || s.layout === "section" ? (input.theme === "dark" ? c.bg : c.accent) : c.bg };
    const onAccent = (s.layout === "title" || s.layout === "section") && input.theme !== "dark";
    const titleColor = onAccent ? "FFFFFF" : c.title;
    if (s.layout === "title" || s.layout === "section") {
      slide.addText(plain(s.title), {
        x: 0.8,
        y: s.layout === "title" ? 2.4 : 2.9,
        w: W - 1.6,
        h: 1.4,
        fontFace: font,
        fontSize: s.layout === "title" ? 40 : 34,
        bold: true,
        color: titleColor,
      });
      if (s.subtitle) slide.addText(plain(s.subtitle), { x: 0.8, y: 3.9, w: W - 1.6, h: 0.9, fontFace: font, fontSize: 20, color: onAccent ? "E8E7FF" : c.soft });
    } else {
      slide.addText(plain(s.title), { x: 0.6, y: 0.35, w: W - 1.2, h: 0.9, fontFace: font, fontSize: 28, bold: true, color: titleColor });
      slide.addShape("rect" as never, { x: 0.6, y: 1.22, w: 1.1, h: 0.06, fill: { color: c.accent }, line: { color: c.accent } });
      const top = 1.55;
      if (s.layout === "twoColumns") {
        const colW = (W - 1.6) / 2;
        [
          [s.leftTitle, s.left ?? []],
          [s.rightTitle, s.right ?? []],
        ].forEach(([head, lines], k) => {
          const x = 0.6 + k * (colW + 0.4);
          let y = top;
          if (head) {
            slide.addText(plain(head as string), { x, y, w: colW, h: 0.5, fontFace: font, fontSize: 20, bold: true, color: c.accent });
            y += 0.6;
          }
          if ((lines as string[]).length) slide.addText(bulletRuns(lines as string[], 18, c.text) as never, { x, y, w: colW, h: H - y - 0.6, fontFace: font, valign: "top" });
        });
      } else if (s.layout === "table" && s.table?.length) {
        const rows = s.table.map((row, r) =>
          row.map((cell) => ({ text: plain(cell), options: r === 0 ? { bold: true, fill: { color: c.headFill }, color: c.headText } : { color: c.text } })),
        );
        slide.addTable(rows as never, {
          x: 0.6,
          y: top,
          w: W - 1.2,
          fontFace: font,
          fontSize: Math.max(11, 16 - Math.floor(s.table.length / 3)),
          border: { type: "solid", pt: 0.5, color: "C9CEDA" },
          autoPage: false,
        });
      } else if (s.layout === "image" && s.image) {
        const img = images.get(s.image.toLowerCase());
        const size = img ? imageSize(img) : null;
        if (img && size) {
          const boxW = s.bullets?.length ? (W - 1.2) * 0.58 : W - 1.2;
          const boxH = H - top - 0.5;
          const scale = Math.min(boxW / size.w, boxH / size.h);
          const w = size.w * scale;
          const h = size.h * scale;
          slide.addImage({ data: `image/${size.type};base64,${img.toString("base64")}`, x: 0.6 + (boxW - w) / 2, y: top + (boxH - h) / 2, w, h });
          if (s.bullets?.length)
            slide.addText(bulletRuns(s.bullets, 18, c.text) as never, { x: 0.6 + boxW + 0.3, y: top, w: W - 1.5 - boxW, h: boxH, fontFace: font, valign: "top" });
        } else {
          missing.push(s.image);
          slide.addText(`[${s.image}]`, { x: 0.6, y: top, w: W - 1.2, h: 1, fontFace: font, fontSize: 16, color: c.soft });
        }
      } else if (s.bullets?.length)
        slide.addText(bulletRuns(s.bullets, s.bullets.length > 8 ? 16 : 20, c.text) as never, { x: 0.6, y: top, w: W - 1.2, h: H - top - 0.6, fontFace: font, valign: "top" });
    }
    if (s.notes?.trim()) slide.addNotes(s.notes.trim());
  });
  const out = await pptx.write({ outputType: "nodebuffer" });
  return { buffer: Buffer.from(out as ArrayBuffer), missing };
}

/**
 * A Markdown outline as slides: "# Title" opens the deck (title slide), each "## Heading" is a slide whose lists and
 * paragraphs become its bullets, a table under a heading makes it a table slide, "> note" lines are speaker notes.
 */
export function outlineToSlides(md: string): { title?: string; slides: SlideSpec[] } {
  const slides: SlideSpec[] = [];
  let title: string | undefined;
  let cur = null as SlideSpec | null;
  const body = md
    .split("\n")
    .filter((l) => !/^\s*>/.test(l))
    .join("\n");
  for (const b of parseMarkdown(body)) {
    if (b.type === "heading" && b.level === 1) {
      title = b.text;
      cur = { layout: "title", title: b.text };
      slides.push(cur);
    } else if (b.type === "heading") {
      cur = { layout: "bullets", title: b.text, bullets: [] };
      slides.push(cur);
    } else if (b.type === "table") {
      const prev: SlideSpec | null = cur;
      if (!prev || prev.layout !== "bullets" || prev.bullets?.length) {
        cur = { layout: "table", title: prev?.title ?? "", table: b.rows };
        slides.push(cur);
      } else Object.assign(prev, { layout: "table", table: b.rows });
    } else if (b.type === "p") {
      if (!cur) {
        cur = { layout: "bullets", title: "", bullets: [] };
        slides.push(cur);
      }
      if (cur.layout === "title") cur.subtitle = cur.subtitle ? `${cur.subtitle} ${b.text}` : b.text;
      else (cur.bullets ??= []).push(`${"  ".repeat(b.level ?? 0)}${b.text}`);
    }
  }
  // Notes written under a heading ("> say this") belong to that heading's slide.
  let at: SlideSpec | null = null;
  for (const line of md.split("\n")) {
    const h = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (h) at = slides.find((s) => s.title === h[1]!.replace(/\s+#+$/, "")) ?? at;
    const n = /^\s*>\s?(.*)$/.exec(line);
    if (n && at) at.notes = at.notes ? `${at.notes}\n${n[1]}` : n[1];
  }
  return { ...(title ? { title } : {}), slides: slides.map((s) => (s.bullets && s.bullets.length > 14 ? { ...s, bullets: s.bullets.slice(0, 14) } : s)) };
}
