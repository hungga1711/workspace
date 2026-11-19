import { describe, expect, it } from "vitest";
import { csvCell, diffText, htmlToText, lineDiff, pageDigest, parseCsv, parseDue, planImport, sectionsOf, toCsv } from "./content-lib.js";
import { cardOf } from "./tools-content.js";

const people = [
  { userId: "u1", displayName: "Nguyễn Thị Lan", email: "lan@acme.vn" },
  { userId: "u2", displayName: "Tran Minh", email: "minh@acme.vn" },
];

describe("sections", () => {
  it("splits Markdown at headings, ignoring # inside code fences", () => {
    const s = sectionsOf("intro\n# One\na\n```\n# not a heading\n```\n## Two\nb", "markdown");
    expect(s.map((x) => [x.heading, x.level])).toEqual([
      ["", 0],
      ["One", 1],
      ["Two", 2],
    ]);
    expect(s[1]!.text).toContain("# not a heading");
  });
  it("reads HTML headings and list items", () => {
    expect(htmlToText("<h2>Plan</h2><ul><li>A &amp; B</li></ul>")).toBe("## Plan\n\n- A & B");
    expect(sectionsOf("<h1>T</h1><p>x</p>", "html")).toEqual([{ heading: "T", level: 1, text: "x" }]);
  });
  it("gives the outline and cut sections when the page is long", () => {
    const long = sectionsOf(`# A\n${"word ".repeat(3000)}\n# B\nshort`, "markdown");
    const d = pageDigest(long, 2000);
    expect(d).toMatch(/^Outline:\n- A \(\d+ chars\)\n- B/);
    expect(d).toContain("more chars");
    expect(pageDigest(sectionsOf("# A\nhi", "markdown"))).toBe("# A\nhi");
  });
});

describe("lineDiff", () => {
  it("marks added and removed lines with context", () => {
    const d = diffText(lineDiff("a\nb\nc\nd\ne\nf\ng", "a\nb\nC\nd\ne\nf\ng\nh"), 1);
    expect(d.added).toBe(2);
    expect(d.removed).toBe(1);
    expect(d.text).toBe("  b\n- c\n+ C\n  d\n…\n  g\n+ h");
  });
  it("is empty for equal texts", () => {
    expect(diffText(lineDiff("x\ny", "x\ny")).text).toBe("");
  });
});

describe("csv", () => {
  it("round-trips quoted cells and neutralises formulas", () => {
    expect(parseCsv('a,b\n"x, y","say ""hi"""\n')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
    ]);
    expect(csvCell("=SUM(A1)")).toBe(`"'=SUM(A1)"`);
    expect(toCsv(["h"], [["a,b"], [null]])).toBe('h\n"a,b"\n');
  });
  it("reads ; separated files", () => {
    expect(parseCsv("a;b\n1;2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("planImport", () => {
  it("reads a Jira CSV, matching people by email then name", () => {
    const plan = planImport(
      "Issue key,Summary,Status,Priority,Assignee,Due date\nAB-1,Fix login,In Progress,Highest,lan@acme.vn,15/Oct/26 10:00 AM\nAB-2,Docs,Done,Low,Tran Minh,\nAB-3,,To Do,,,\nAB-4,Ghost,To Do,,Nobody,",
      people,
    );
    expect(plan.system).toBe("jira");
    expect(plan.skipped).toBe(1);
    expect(plan.tasks.map((t) => [t.title, t.status, t.priority, t.assigneeId])).toEqual([
      ["Fix login", "in_progress", "urgent", "u1"],
      ["Docs", "done", "low", "u2"],
      ["Ghost", "todo", "medium", null],
    ]);
    expect(plan.tasks[0]!.dueAt).toBe("2026-10-15T10:00:00.000Z");
    expect(plan.unknownPeople).toEqual(["Nobody"]);
  });
  it("reads Trello's JSON export", () => {
    const plan = planImport(
      JSON.stringify({
        lists: [{ id: "l1", name: "Doing" }],
        members: [{ id: "m1", fullName: "Nguyễn Thị Lan" }],
        cards: [{ name: "Card", idList: "l1", idMembers: ["m1"], idShort: 7, labels: [{ name: "ux" }] }],
      }),
      people,
    );
    expect(plan.system).toBe("trello");
    expect(plan.tasks[0]).toMatchObject({ title: "Card", status: "in_progress", assigneeId: "u1", key: "#7", labels: ["ux"] });
  });
  it("keeps subtasks one level deep", () => {
    const plan = planImport("Task ID,Task Name,Parent ID,List Name\n1,A,,L\n2,B,1,L\n3,C,2,L", []);
    expect(plan.tasks.map((t) => t.parentKey)).toEqual([null, "1", "1"]);
  });
  it("parses Vietnamese day-first dates", () => {
    expect(parseDue("05/11/2026")).toBe("2026-11-05T10:00:00.000Z");
    expect(parseDue("2026-11-05")).toBe("2026-11-05T10:00:00.000Z");
    expect(parseDue("nonsense")).toBeNull();
  });
});

describe("cards", () => {
  it("import card counts the tasks it will create", () => {
    const c = cardOf("import_tasks", { project: "P-001", text: "Title\nA\nB" }, "en");
    expect(c?.title).toBe("Import 2 tasks into P-001");
  });
  it("diagram card lists the boxes", () => {
    const c = cardOf(
      "create_whiteboard_diagram",
      {
        title: "Onboarding",
        kind: "flow",
        nodes: [
          { id: "a", label: "Start" },
          { id: "b", label: "Sign" },
        ],
      },
      "vi",
    );
    expect(c?.title).toBe("Tạo bảng trắng có sơ đồ");
    expect(c?.fields.find((f) => f.label === "Các ô")?.value).toBe("Start · Sign");
  });
});
