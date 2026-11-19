import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import type { INestApplication } from "@nestjs/common";
import pg from "pg";
import { migrate, PRINCIPAL_HEADER, S3Storage, ServiceCallError, signInternalToken, type ServiceClient } from "@workspace/service-kit";
import { newId, type Principal } from "@workspace/shared";
import { DEFAULT_ROLES } from "../../src/modules/identity/catalog.js";
import { createWorkApp } from "../../src/modules/work/app.js";
import { READ, WRITE } from "../../src/modules/ai/tools-office.js";
import { READ as CONTENT_READ } from "../../src/modules/ai/tools-content.js";
import { READ as CHAT_READ } from "../../src/modules/ai/tools-chat.js";
import type { AttachedFile, Tool, ToolContext } from "../../src/modules/ai/tools.js";
import { buildXlsx } from "../../src/modules/ai/office/write-xlsx.js";
import { buildDocx } from "../../src/modules/ai/office/write-docx.js";
import { buildPptx } from "../../src/modules/ai/office/write-pptx.js";
import { buildPdf } from "../../src/modules/ai/office/write-pdf.js";
import { resetTestDatabase } from "../test-db.js";

/**
 * PDF and pictures in the Office tools against the real work module and storage: a PDF made, saved on a
 * task and read back page by page; Word, PowerPoint and Excel printed to PDF and a PDF turned into Word; the text tools
 * (summary, tasks, action items) reading a file; a table read from a picture saved as a workbook.
 */
const SECRET = "dev-internal-secret-change-me-32bytes!";
const EMPLOYEE = DEFAULT_ROLES.find((r) => r.name === "Employee")!.grants;
const person = (): Principal => ({ type: "user", id: newId(), teamIds: [], departmentId: null, grants: EMPLOYEE });
const lan = person();
const huy = person();

let app: INestApplication;
let pool: pg.Pool;
let base = "";

/** The work module as the ai module reaches it: a request as a person. */
const client: ServiceClient = {
  request: async <T>(method: string, path: string, body?: unknown, as?: Principal): Promise<T> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", [PRINCIPAL_HEADER]: await signInternalToken({ principal: as!, requestId: newId() }, SECRET) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const t = await res.text();
    const parsed = t ? JSON.parse(t) : null;
    if (!res.ok) throw new ServiceCallError(res.status, parsed, `${method} ${path}`);
    return parsed as T;
  },
} as unknown as ServiceClient;

const ctxOf = (p: Principal, files: AttachedFile[] = []): ToolContext => ({
  principal: p,
  agentId: null,
  services: { work: client, chat: client, employee: client },
  lang: "vi",
  loc: "vi",
  files,
  storedFile: async () => [],
});
const tool = (name: string): Tool => [...READ, ...CONTENT_READ, ...CHAT_READ].find((t) => t.name === name) ?? WRITE.find((w) => w.tool.name === name)!.tool;
const run = async (name: string, ctx: ToolContext, input: Record<string, unknown>) => tool(name).run(ctx, tool(name).input.parse(input));

beforeAll(async () => {
  await migrate("postgres://workspace_owner:owner_pw@localhost:5432/workspace_test", fileURLToPath(new URL("../../migrations/work", import.meta.url)), "work");
  await resetTestDatabase();
  pool = new pg.Pool({ connectionString: "postgres://workspace_work:app_pw@localhost:5432/workspace_test", max: 4 });
  const storage = new S3Storage({
    endpoint: "http://localhost:8333",
    region: "auto",
    bucket: "workspace-files",
    accessKeyId: "workspace_dev_key",
    secretAccessKey: "workspace_dev_secret",
  });
  await storage.ensureBucket();
  const ai = { request: async () => ({ text: "unused" }) } as unknown as ServiceClient;
  app = await createWorkApp({ pool, storage, internalSecret: SECRET, ai, resolvePrincipal: async (id: string) => (id === huy.id ? huy : lan) });
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "127.0.0.1");
});
afterAll(async () => {
  await app?.close();
  await pool?.end();
});

const fileIdOf = (url: string) => /files\/([0-9A-Z]{26})/.exec(url)![1]!;
const PDF = "application/pdf";

describe("PDF and pictures in the Office tools", () => {
  it("makes a PDF on a task and reads it back page by page, in Vietnamese", async () => {
    const task = await client.request<{ id: string; code: string }>("POST", "/tasks", { title: "Hợp đồng dịch vụ", assigneeId: lan.id }, lan);
    const made = await run("create_word_document", ctxOf(lan), {
      fileName: "Biên bản bàn giao",
      format: "pdf",
      task: task.code,
      markdown:
        "# Biên bản bàn giao\n\nBên A bàn giao **thiết bị** cho bên B.\n\n| Thiết bị | Số lượng |\n|---|---|\n| Máy tính xách tay | 3 |\n\n---\n\n## Chữ ký\nĐại diện các bên",
    });
    expect(made.content).toContain("Biên bản bàn giao.pdf");
    const row = (await pool.query("SELECT content_type FROM files WHERE attached_type = 'task' AND attached_id = $1 AND name = 'Biên bản bàn giao.pdf'", [task.id])).rows[0];
    expect(row).toEqual({ content_type: PDF });
    const read = await run("read_office_file", ctxOf(lan), { file: "bien ban ban giao", task: task.code });
    expect(read.content).toMatch(/^Biên bản bàn giao\.pdf: PDF, 2 pages/);
    expect(read.content).toContain("## Page 1\nBiên bản bàn giao\nBên A bàn giao thiết bị cho bên B.");
    expect(read.content).toContain("## Page 2\nChữ ký");
    // Someone without the task cannot open it through the tools.
    await expect(run("read_office_file", ctxOf(huy), { file: fileIdOf(made.sources[0]!.url) })).rejects.toThrow();
  });

  it("prints Word, PowerPoint and Excel to PDF (a slide a page) and turns a PDF into Word", async () => {
    const deck = (
      await buildPptx({
        title: "Ra mắt",
        slides: [
          { layout: "bullets", title: "Mục tiêu", bullets: ["Tăng doanh số"] },
          { layout: "bullets", title: "Lịch trình", bullets: ["Tháng 12"] },
        ],
      })
    ).buffer;
    const ctx = ctxOf(lan, [
      { name: "quy-trinh.docx", contentType: "application/octet-stream", data: await buildDocx({ markdown: "# Quy trình\n1. Nhận đơn\n2. Giao hàng" }) },
      { name: "ra-mat.pptx", contentType: "application/octet-stream", data: deck },
      {
        name: "chi-phi.xlsx",
        contentType: "application/octet-stream",
        data: await buildXlsx([{ name: "Tháng 11", columns: [{ header: "Khoản" }, { header: "Tiền", type: "currency" }], rows: [["Quảng cáo", 12_500_000]] }]),
      },
      {
        name: "hop-dong.pdf",
        contentType: PDF,
        data: await buildPdf({ markdown: "Hợp đồng này được lập giữa hai bên với các điều khoản và điều kiện\nnhư sau đây.\n\n• Bên A thanh toán" }),
      },
    ]);
    const pages = async (r: { sources: { url: string }[] }) => (await run("read_office_file", ctxOf(lan), { file: fileIdOf(r.sources[0]!.url) })).content;
    expect(await pages(await run("convert_office", ctx, { file: "quy-trinh.docx", to: "pdf" }))).toContain("Quy trình\n1. Nhận đơn\n2. Giao hàng");
    const slides = await pages(await run("convert_office", ctx, { file: "ra-mat.pptx", to: "pdf" }));
    expect(slides).toMatch(/PDF, 2 pages/);
    expect(slides).toContain("## Page 1\nMục tiêu\n• Tăng doanh số");
    expect(await pages(await run("convert_office", ctx, { file: "chi-phi.xlsx", to: "pdf" }))).toContain("Quảng cáo 12.500.000");
    const word = await pages(await run("convert_office", ctx, { file: "hop-dong.pdf", to: "docx" }));
    expect(word).toContain("Hợp đồng này được lập giữa hai bên với các điều khoản và điều kiện như sau đây.");
    expect(word).toContain("- Bên A thanh toán");
    await expect(run("convert_office", ctx, { file: "hop-dong.pdf", to: "pdf" })).rejects.toThrow(/already a PDF/);
  });

  it("lets the summary, task and action-item tools read a file, and says when a PDF is a scan", async () => {
    const minutes = await buildPdf({ markdown: "# Họp giao ban\n\nAnh An gửi báo giá cho khách trước thứ Sáu.\n\n---\n\nChị Bích chốt hợp đồng." });
    const scan = await new Promise<Buffer>((resolve) => {
      void import("pdfkit").then(({ default: PDFDocument }) => {
        const d = new PDFDocument();
        const out: Buffer[] = [];
        d.on("data", (c: Buffer) => out.push(c));
        d.on("end", () => resolve(Buffer.concat(out)));
        d.rect(40, 40, 300, 300).fill("#777777");
        d.end();
      });
    });
    const ctx = ctxOf(lan, [
      { name: "giao-ban.pdf", contentType: PDF, data: minutes },
      { name: "scan.pdf", contentType: PDF, data: scan },
    ]);
    const sum = await run("summarize_document", ctx, { file: "giao-ban.pdf", focus: "việc cần làm" });
    expect(sum.content).toMatch(/^giao-ban\.pdf: PDF, 2 pages; focus: việc cần làm/);
    expect(sum.content).toContain("<untrusted_content>\n## Page 1\nHọp giao ban");
    expect((await run("doc_to_tasks", ctx, { file: "giao-ban" })).content).toContain("Chị Bích chốt hợp đồng.");
    const items = await run("extract_action_items", ctx, { file: "giao-ban.pdf" });
    expect(items.content).toContain("Anh An gửi báo giá cho khách trước thứ Sáu.");
    expect(items.content).toContain("ghi kèm trang");
    await expect(run("read_office_file", ctx, { file: "scan.pdf" })).rejects.toThrow(/no text layer.*as images/);
    await expect(run("summarize_document", ctx, {})).rejects.toThrow(/Name the page/);
  });

  it("saves a table read from a picture as a workbook: typed numbers, a totals row, unreadable cells kept as ?", async () => {
    const made = await run("image_to_spreadsheet", ctxOf(lan), {
      fileName: "Hóa đơn tháng 11",
      columns: [{ header: "Ngày", type: "date" }, { header: "Cửa hàng" }, { header: "Số tiền", type: "currency" }, { header: "Đơn giá", type: "currency" }],
      rows: [
        ["2026-11-03", "Highlands Coffee", "125.000 ₫", 62500],
        ["2026-11-05", '=HYPERLINK("http://x")', 480000, 480000],
        ["?", "Văn phòng phẩm Hồng Hà", "?", "?"],
      ],
      totals: true,
      unclear: ["dòng 3, Ngày", "dòng 3, Số tiền"],
    });
    expect(made.content).toContain("Hóa đơn tháng 11.xlsx");
    expect(made.content).toContain('ghi "?": dòng 3, Ngày; dòng 3, Số tiền');
    const read = (await run("read_office_file", ctxOf(lan), { file: fileIdOf(made.sources[0]!.url) })).content;
    expect(read).toContain("C2=125000");
    expect(read).toContain("A4=? · B4=Văn phòng phẩm Hồng Hà · C4=? · D4=?");
    // Text in a photo never becomes a formula; the totals row adds the amounts, not the unit prices.
    expect(read).toContain(`B3='=HYPERLINK("http://x")`);
    expect(read).toMatch(/C5=605000 \{=SUM\(C2:C4\)\}$/m);
  });
});
