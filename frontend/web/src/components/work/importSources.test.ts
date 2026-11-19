import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { flattenParents, parseDue, planClickUpJson, planImport, type ImportTask } from "./importTasks";
import { cleanNotionMarkdown, notionName, planNotion } from "./notionExport";

const FIX = fileURLToPath(new URL("./__fixtures__", import.meta.url));
const people = [
  { userId: "u-lan", displayName: "Nguyễn Lan", email: "lan@congty.vn" },
  { userId: "u-huy", displayName: "Trần Huy", email: "huy@congty.vn" },
];

/** Zips a fixture folder the way Notion does (one root folder), optionally wrapped in a second zip. */
function zipFolder(dir: string, root: string, nested = false): ArrayBuffer {
  const files: Record<string, Uint8Array> = {};
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else files[`${root}/${relative(dir, p)}`] = new Uint8Array(readFileSync(p));
    }
  };
  walk(dir);
  const z = zipSync(files);
  const out = nested ? zipSync({ "Export-part-1.zip": z, "__MACOSX/._x": strToU8("") }) : z;
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

describe("ClickUp CSV", () => {
  const p = planImport(readFileSync(join(FIX, "clickup.csv"), "utf8"), people);
  it("is recognised and keeps statuses, priorities, people, tags and dates (month first)", () => {
    expect(p.system).toBe("clickup");
    expect(p.tasks.map((x) => x.status)).toEqual(["in_progress", "todo", "done", "review"]);
    expect(p.tasks.map((x) => x.priority)).toEqual(["high", "medium", "low", "urgent"]);
    expect(p.tasks[0]).toMatchObject({ assigneeId: "u-lan", labels: ["web", "launch"], key: "86a1", group: "Website" });
    expect(p.tasks[0]!.dueAt?.slice(0, 10)).toBe("2026-10-25");
    expect(p.tasks[1]).toMatchObject({ assigneeId: "u-huy", labels: [] });
    expect(p.tasks[1]!.dueAt?.slice(0, 10)).toBe("2026-10-30");
    expect(p.tasks[3]!.dueAt).toBe(new Date(1793318400000).toISOString());
    expect(p.unknownPeople).toEqual(["someone@else.com"]);
  });
  it("uses the list as a group, not as the status", () => {
    expect([...new Set(p.tasks.map((x) => x.group))]).toEqual(["Website", "Sales"]);
  });
  it("hangs a sub-subtask from its top-level ancestor", () => {
    expect(p.tasks.map((x) => x.parentKey)).toEqual([null, "86a1", "86a1", null]);
  });
});

describe("ClickUp JSON", () => {
  it("reads the API's tasks, follows custom ids for parents and skips untitled ones", () => {
    const p = planClickUpJson(readFileSync(join(FIX, "clickup.json"), "utf8"), people)!;
    expect(p.system).toBe("clickup");
    expect(p.skipped).toBe(1);
    expect(p.tasks[0]).toMatchObject({ title: "Sửa lỗi đăng nhập", status: "done", priority: "urgent", assigneeId: "u-huy", key: "WEB-12", labels: ["bug"], group: "Website" });
    expect(p.tasks[0]!.dueAt).toBe(new Date(1793318400000).toISOString());
    expect(p.tasks[1]).toMatchObject({ status: "in_progress", key: "86c2", parentKey: "WEB-12", assigneeId: null });
  });
  it("is not taken for something else", () => {
    expect(planClickUpJson('{"cards":[]}', people)).toBeNull();
    expect(planClickUpJson("not json", people)).toBeNull();
  });
});

describe("manual column mapping", () => {
  const csv = "Việc cần làm,Ai,Khi nào\nGọi khách,lan@congty.vn,01/11/2026";
  it("lets a person point fields at columns the guess missed, or drop one", () => {
    expect(planImport(csv, people).columns.title).toBeUndefined();
    const p = planImport(csv, people, { columns: { title: 0, assignee: 1, due: 2 } });
    expect(p.tasks[0]).toMatchObject({ title: "Gọi khách", assigneeId: "u-lan" });
    expect(p.tasks[0]!.dueAt?.slice(0, 10)).toBe("2026-11-01");
    expect(planImport(csv, people, { columns: { title: 0, assignee: -1 } }).tasks[0]!.assigneeId).toBeNull();
  });
});

describe("dates and parents", () => {
  it("parses Notion ranges (the end is the due date) and US long dates", () => {
    // The calendar day stays whatever the machine's time zone.
    expect(parseDue("October 1, 2026 → October 20, 2026")).toBe("2026-10-20T10:00:00.000Z");
    expect(parseDue("Friday, October 30th 2026")).toBe("2026-10-30T10:00:00.000Z");
    expect(parseDue("Not a date")).toBeNull();
    expect(parseDue("02/03/2026")?.slice(0, 10)).toBe("2026-03-02");
    expect(parseDue("02/03/2026", true)?.slice(0, 10)).toBe("2026-02-03");
  });
  it("drops a parent that is not in the import and survives a cycle", () => {
    const t = (key: string, parentKey: string | null) => ({ key, parentKey }) as ImportTask;
    expect(flattenParents([t("a", "zz"), t("b", "c"), t("c", "b")]).map((x) => x.parentKey)).toEqual([null, expect.any(String), expect.any(String)]);
  });
});

describe("Notion export", () => {
  const dir = join(FIX, "notion");
  it("finds the database (preferring the _all file) and the pages, without the database's own row pages", () => {
    const n = planNotion(zipFolder(dir, "Export-abc"));
    expect(n.databases).toHaveLength(1);
    expect(n.databases[0]).toMatchObject({ name: "Tasks", rows: 3 });
    expect(n.pages.map((p) => p.title)).toEqual(["Sổ tay nhân viên", "Nghỉ phép"]);
    expect(n.pages[1]!.parentPath).toBe(n.pages[0]!.path);
    expect(n.pages[0]!.parentPath).toBeNull();
    expect(n.images).toBe(1);
  });
  it("turns the database into tasks with Notion's status, people and date range", () => {
    const n = planNotion(zipFolder(dir, "Export-abc"));
    const p = planImport(n.databases[0]!.csv, people, { system: "notion" });
    expect(p.system).toBe("notion");
    expect(p.tasks.map((x) => [x.title, x.status, x.assigneeId])).toEqual([
      ["Chuẩn bị họp quý", "in_progress", "u-lan"],
      ["Gửi báo cáo", "done", "u-huy"],
      ["Lên lịch tuyển dụng", "todo", null],
    ]);
    expect(p.tasks[0]!.labels).toEqual(["họp", "quý"]);
    expect(p.tasks[0]!.dueAt).not.toBeNull();
  });
  it("reads a zip of zips", () => {
    expect(planNotion(zipFolder(dir, "Export-abc", true)).pages).toHaveLength(2);
  });
  it("cleans the Markdown: title out, images out, links to exported pages become text", () => {
    const c = cleanNotionMarkdown(readFileSync(join(dir, "Handbook 11112222333344445555666677778888.md"), "utf8"));
    expect(c.title).toBe("Sổ tay nhân viên");
    expect(c.images).toBe(1);
    expect(c.body).toBe("Chào mừng bạn.\n\nXem Nghỉ phép và [trang chủ](https://example.com).");
    expect(notionName("Roadmap 2026 0a1b2c3d4e5f60718293a4b5c6d7e8f9")).toBe("Roadmap 2026");
  });
});
