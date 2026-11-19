import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import type { INestApplication } from "@nestjs/common";
import pg from "pg";
import { migrate, PRINCIPAL_HEADER, S3Storage, ServiceCallError, signInternalToken, type ServiceClient } from "@workspace/service-kit";
import { newId, type Principal } from "@workspace/shared";
import { DEFAULT_ROLES } from "../../src/modules/identity/catalog.js";
import { createWorkApp } from "../../src/modules/work/app.js";
import { READ, WRITE } from "../../src/modules/ai/tools-office.js";
import { ToolProblem, type AttachedFile, type Tool, type ToolContext } from "../../src/modules/ai/tools.js";
import { buildXlsx } from "../../src/modules/ai/office/write-xlsx.js";
import { buildDocx } from "../../src/modules/ai/office/write-docx.js";
import { resetTestDatabase } from "../test-db.js";

/**
 * The Office tools against the real work module, storage and permissions: a file the tools make is saved
 * on a task or in the asker's Drive as the asker; another person cannot open a private Drive file through them; an
 * edit leaves the original as it was; an attachment of the question is read without being stored anywhere.
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
const tool = (name: string): Tool => READ.find((t) => t.name === name) ?? WRITE.find((w) => w.tool.name === name)!.tool;
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

describe("the Office tools with the real work module", () => {
  it("makes a spreadsheet on a task, reads its formulas back, analyses it and edits it into a new file", async () => {
    const task = await client.request<{ id: string; code: string }>("POST", "/tasks", { title: "Bảng lương tháng 11", assigneeId: lan.id }, lan);
    const made = await run("create_spreadsheet", ctxOf(lan), {
      fileName: "Bảng lương 11-2026",
      task: task.code,
      sheets: [
        {
          name: "Lương",
          columns: [{ header: "Họ tên" }, { header: "Phòng" }, { header: "Lương", type: "currency" }],
          rows: [
            ["An", "IT", 20_000_000],
            ["Bình", "IT", 18_000_000],
            ["Chi", "HR", 15_000_000],
          ],
          totals: true,
        },
      ],
    });
    expect(made.ok).toBe(true);
    expect(made.content).toContain(`đã gắn vào việc ${task.code}`);
    expect(made.sources[0]).toMatchObject({ type: "file", title: "Bảng lương 11-2026.xlsx", url: expect.stringMatching(/^\/app\/files\/[0-9A-Z]{26}$/) });

    const read = await run("read_office_file", ctxOf(lan), { file: "bảng lương", task: task.code });
    // The total's formula, with its result stored so a preview shows it before Excel recalculates.
    expect(read.content).toContain("C5=53000000 {=SUM(C2:C4)}");
    const sums = await run("analyze_sheet", ctxOf(lan), { file: "Bảng lương 11-2026.xlsx", task: task.code, groupBy: ["phong"], measures: [{ fn: "sum", column: "luong" }] });
    expect(sums.content).toContain("| IT | 38000000 |");
    expect(sums.content).toContain("left out");
    expect(sums.blocks?.map((b) => b.kind)).toEqual(["table", "chart"]);

    const edited = await run("edit_spreadsheet", ctxOf(lan), { file: "Bảng lương 11-2026.xlsx", task: task.code, ops: [{ op: "sort", column: "C" }] });
    expect(edited.content).toContain("(sửa).xlsx");
    const files = (await pool.query("SELECT name FROM files WHERE attached_type = 'task' AND attached_id = $1 AND status = 'active' ORDER BY created_at", [task.id])).rows.map(
      (r) => r.name,
    );
    expect(files).toEqual(["Bảng lương 11-2026.xlsx", "Bảng lương 11-2026 (sửa).xlsx"]);
  });

  it("saves to the asker's own Drive, where another person cannot open it through the tools", async () => {
    const made = await run("create_word_document", ctxOf(lan), { fileName: "Biên bản họp riêng", markdown: "# Nội dung\n- Bí mật" });
    expect(made.content).toContain("Drive của bạn");
    const item = (await pool.query("SELECT owner_id, visibility FROM drive_items WHERE name = 'Biên bản họp riêng.docx' AND trashed_at IS NULL")).rows[0];
    expect(item).toEqual({ owner_id: lan.id, visibility: "private" });
    // Lan finds it by name, without accents; Huy does not.
    expect((await run("read_office_file", ctxOf(lan), { file: "bien ban hop rieng" })).content).toContain("Bí mật");
    await expect(run("read_office_file", ctxOf(huy), { file: "Biên bản họp riêng" })).rejects.toThrow(ToolProblem);
    // Nor by the file's id.
    const fileId = /files\/([0-9A-Z]{26})/.exec(made.sources[0]!.url)![1]!;
    await expect(run("read_office_file", ctxOf(huy), { file: fileId })).rejects.toThrow();
  });

  it("works on a file attached to the question, fills a template and makes a deck, without other people's rights", async () => {
    const tpl = await buildDocx({ markdown: "Kính gửi {{ho_ten}}, phòng {{phong}}." });
    const book = await buildXlsx([
      {
        name: "DS",
        columns: [{ header: "ho_ten" }, { header: "phong" }],
        rows: [
          ["An", "IT"],
          ["Bình", "HR"],
        ],
      },
    ]);
    const ctx = ctxOf(lan, [
      { name: "thu-moi.docx", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", data: tpl },
      { name: "danh-sach.xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", data: book },
    ]);
    const one = await run("fill_word_template", ctx, { template: "thu-moi.docx", values: { "Họ tên": "Chi", phong: "Kế toán" } });
    expect(one.content).toContain("thu-moi - filled.docx");
    const merged = await run("fill_word_template", ctx, { template: "thu-moi", rowsFrom: "danh-sach.xlsx" });
    expect(merged.content).toContain("2 tài liệu");
    const deck = await run("create_presentation", ctx, { fileName: "Giới thiệu", outline: "# Dự án\n## Mục tiêu\n- Ra mắt\n## Lịch\n- Tháng 12" });
    expect(deck.content).toContain("3 trang chiếu");
    const huyCtx = ctxOf(huy);
    await expect(run("analyze_sheet", huyCtx, { file: "danh-sach.xlsx" })).rejects.toThrow(/No file called/);
  });

  it("refuses a macro workbook named in the question", async () => {
    const ctx = ctxOf(lan, [{ name: "bao-cao.xlsm", contentType: "application/vnd.ms-excel.sheet.macroEnabled.12", data: Buffer.from("PK") }]);
    await expect(run("read_office_file", ctx, { file: "bao-cao.xlsm" })).rejects.toThrow(/macros/);
  });
});
