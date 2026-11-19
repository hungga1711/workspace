import { inlines, parseMarkdown, type MdBlock } from "./markdown.js";

/**
 * A Word document from the model's Markdown, with a plain house style: Arial (every Vietnamese letter
 * renders), real Word headings (so the navigation pane and a table of contents work), real bullet and numbered lists,
 * tables with a shaded header row, and page numbers in the footer. The `docx` library is loaded on first use.
 */

type Docx = typeof import("docx");
let lib: Promise<Docx> | null = null;
const load = () => (lib ??= import("docx"));

export interface WordInput {
  title?: string | undefined;
  markdown: string;
  landscape?: boolean | undefined;
}

export async function buildDocx(input: WordInput): Promise<Buffer> {
  const d = await load();
  const blocks: MdBlock[] = parseMarkdown(input.markdown);
  // A title also written as the content's first heading is shown once, as the title.
  const first = blocks[0];
  if (input.title?.trim() && first?.type === "heading" && first.text.trim().toLowerCase() === input.title.trim().toLowerCase()) blocks.shift();
  const runs = (text: string, extra: { bold?: boolean; size?: number; color?: string } = {}) =>
    inlines(text).map(
      (x) =>
        new d.TextRun({
          text: x.text,
          ...(x.bold || extra.bold ? { bold: true } : {}),
          ...(x.italic ? { italics: true } : {}),
          ...(extra.size ? { size: extra.size } : {}),
          ...(extra.color ? { color: extra.color } : {}),
        }),
    );
  const HEADINGS = [d.HeadingLevel.HEADING_1, d.HeadingLevel.HEADING_2, d.HeadingLevel.HEADING_3, d.HeadingLevel.HEADING_4, d.HeadingLevel.HEADING_5, d.HeadingLevel.HEADING_6];
  const children: (InstanceType<Docx["Paragraph"]> | InstanceType<Docx["Table"]>)[] = [];
  if (input.title?.trim()) children.push(new d.Paragraph({ heading: d.HeadingLevel.TITLE, children: runs(input.title.trim()) }));
  for (const b of blocks) {
    if (b.type === "heading") children.push(new d.Paragraph({ heading: HEADINGS[Math.min(5, b.level - 1)]!, children: runs(b.text) }));
    else if (b.type === "break") children.push(new d.Paragraph({ children: [new d.PageBreak()] }));
    else if (b.type === "table") {
      const width = Math.max(...b.rows.map((r) => r.length));
      children.push(
        new d.Table({
          width: { size: 100, type: d.WidthType.PERCENTAGE },
          rows: b.rows.map(
            (r, ri) =>
              new d.TableRow({
                tableHeader: ri === 0,
                children: Array.from(
                  { length: width },
                  (_, ci) =>
                    new d.TableCell({
                      ...(ri === 0 ? { shading: { type: d.ShadingType.CLEAR, color: "auto", fill: "EEF0F6" } } : {}),
                      margins: { top: 60, bottom: 60, left: 100, right: 100 },
                      children: [new d.Paragraph({ children: runs(r[ci] ?? "", ri === 0 ? { bold: true } : {}) })],
                    }),
                ),
              }),
          ),
        }),
      );
      children.push(new d.Paragraph({ children: [] }));
    } else if (b.list === "bullet") children.push(new d.Paragraph({ bullet: { level: b.level ?? 0 }, children: runs(b.text) }));
    else if (b.list === "number") children.push(new d.Paragraph({ numbering: { reference: "numbers", level: b.level ?? 0 }, children: runs(b.text) }));
    else children.push(new d.Paragraph({ spacing: { after: 120 }, children: runs(b.text) }));
  }
  const doc = new d.Document({
    creator: "Workspace AI",
    title: input.title?.trim() || "Document",
    styles: {
      default: { document: { run: { font: "Arial", size: 22 }, paragraph: { spacing: { line: 300 } } } },
      paragraphStyles: [
        { id: "Title", name: "Title", basedOn: "Normal", next: "Normal", run: { font: "Arial", size: 40, bold: true, color: "1F2A44" }, paragraph: { spacing: { after: 240 } } },
        {
          id: "Heading1",
          name: "Heading 1",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { font: "Arial", size: 32, bold: true, color: "1F2A44" },
          paragraph: { spacing: { before: 240, after: 120 } },
        },
        {
          id: "Heading2",
          name: "Heading 2",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { font: "Arial", size: 26, bold: true, color: "2B3A67" },
          paragraph: { spacing: { before: 200, after: 100 } },
        },
        {
          id: "Heading3",
          name: "Heading 3",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { font: "Arial", size: 23, bold: true, color: "2B3A67" },
          paragraph: { spacing: { before: 160, after: 80 } },
        },
      ],
    },
    numbering: {
      config: [
        {
          reference: "numbers",
          levels: [0, 1, 2, 3, 4].map((level) => ({
            level,
            format: level % 2 ? d.LevelFormat.LOWER_LETTER : d.LevelFormat.DECIMAL,
            text: `%${level + 1}.`,
            alignment: d.AlignmentType.START,
            style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
          })),
        },
      ],
    },
    sections: [
      {
        properties: input.landscape ? { page: { size: { orientation: d.PageOrientation.LANDSCAPE } } } : {},
        footers: {
          default: new d.Footer({
            children: [new d.Paragraph({ alignment: d.AlignmentType.CENTER, children: [new d.TextRun({ children: [d.PageNumber.CURRENT], size: 18, color: "888888" })] })],
          }),
        },
        children,
      },
    ],
  });
  return Buffer.from(await d.Packer.toBuffer(doc));
}
