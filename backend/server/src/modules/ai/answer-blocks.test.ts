import { describe, expect, it } from "vitest";
import { addBlocks, cleanBlock, parseBlocks, MAX_BLOCKS, type AnswerBlock } from "./answer-blocks.js";
import { departmentTable, flowChart, lateTable, spendCharts, workloadChart } from "./tool-blocks.js";

const chart = (id: string, values: number[]): AnswerBlock => ({ kind: "chart", id, title: id, chart: "bars", rows: values.map((v, i) => ({ label: `r${i}`, value: v })) });

describe("answer blocks", () => {
  it("keeps only the app's own screens as links and drops empty charts", () => {
    const b = cleanBlock({
      kind: "chart",
      id: "x",
      title: "t",
      chart: "bars",
      rows: [
        { label: "a", value: 1, drill: { url: "https://evil.example/x" } },
        { label: "b", value: 2, drill: { url: "/app/work/people/u1" } },
        { label: "c", value: 3, drill: { url: "javascript:alert(1)", ask: "  why?  " } },
      ],
    });
    expect(b?.kind === "chart" && b.rows.map((r) => r.drill)).toEqual([undefined, { url: "/app/work/people/u1" }, { ask: "why?" }]);
    expect(cleanBlock(chart("zero", [0, 0]))).toBeNull();
  });

  it("one id draws once (the latest wins) and an answer carries a few blocks at most", () => {
    const into: AnswerBlock[] = [];
    addBlocks(into, [chart("a", [1]), chart("a", [5])]);
    expect(into).toHaveLength(1);
    expect(into[0]!.kind === "chart" && into[0]!.rows[0]!.value).toBe(5);
    addBlocks(
      into,
      Array.from({ length: 9 }, (_, i) => chart(`c${i}`, [i + 1])),
    );
    expect(into).toHaveLength(MAX_BLOCKS);
  });

  it("reads back only well-formed blocks", () => {
    expect(parseBlocks(null)).toEqual([]);
    expect(parseBlocks([{ kind: "chart" }, { kind: "table", columns: [], rows: [] }, "x", chart("ok", [2])])).toHaveLength(1);
    expect(parseBlocks([{ kind: "table", columns: [{ key: "a", label: "A" }], rows: [{ nope: 1 }] }])).toEqual([]);
  });

  it("cuts long tables and says how many rows were left out", () => {
    const b = cleanBlock({ kind: "table", id: "t", title: "t", columns: [{ key: "a", label: "A" }], rows: Array.from({ length: 55 }, (_, i) => ({ cells: { a: i } })) });
    expect(b?.kind === "table" && [b.rows.length, b.more]).toEqual([40, 15]);
  });
});

describe("tool blocks", () => {
  it("a trend needs two weeks; labels are day/month", () => {
    expect(flowChart({ vi: true, id: "f", of: "Lan" }, [{ week: "2026-11-09", done: 2, added: 3 }])).toBeNull();
    const f = flowChart({ vi: false, id: "f", of: "Lan" }, [
      { week: "2026-11-02", done: 1, added: 2 },
      { week: "2026-11-09", done: 4, added: 1 },
    ]);
    expect(f?.rows).toEqual([
      { label: "02/11", value: 1, compare: 2 },
      { label: "09/11", value: 4, compare: 1 },
    ]);
    expect(f?.series).toEqual(["Done", "Added"]);
  });

  it("workload: most loaded first, overloaded highlighted, a bar opens the person", () => {
    const w = workloadChart({ vi: true }, [
      { userId: "a", displayName: "An", open: 2, dueSoon: 1, load: "normal" },
      { userId: "b", displayName: "Bình", open: 9, dueSoon: 4, load: "overloaded" },
    ]);
    expect(w?.rows.map((r) => [r.label, r.highlight ?? false, r.drill?.url])).toEqual([
      ["Bình", true, "/app/work/people/b"],
      ["An", false, "/app/work/people/a"],
    ]);
  });

  it("late table: overdue before at risk, longest late first, rows open the task", () => {
    const now = Date.parse("2026-11-17T00:00:00Z");
    const t = lateTable({ vi: false, now, day: (iso) => iso?.slice(5, 10) ?? "" }, [
      { code: "T-2", title: "risk", assignee: "An", dueAt: "2026-11-20T00:00:00Z", overdue: false, progress: 10 },
      { code: "T-1", title: "a bit", assignee: "An", dueAt: "2026-11-15T00:00:00Z", overdue: true, progress: null },
      { code: "T-3", title: "long", assignee: "Bình", dueAt: "2026-11-01T00:00:00Z", overdue: true, progress: 50 },
    ]);
    expect(t?.rows.map((r) => [r.cells.task, r.cells.late, r.drill?.url])).toEqual([
      ["T-3 long", "16d", "/app/work/tasks/T-3"],
      ["T-1 a bit", "2d", "/app/work/tasks/T-1"],
      ["T-2 risk", "at risk", "/app/work/tasks/T-2"],
    ]);
  });

  it("departments ask about themselves; spend leaves out what cost nothing", () => {
    const d = departmentTable({ vi: true, weeks: 2 }, [
      { name: "Kỹ thuật", people: 5, done: 9, open: 12, overdue: 4, overdueShare: 33, blocked: 1, onTimeRate: 80, health: "risk" },
    ]);
    expect(d?.rows[0]).toMatchObject({ highlight: true, drill: { ask: "Phòng Kỹ thuật đang thế nào?" }, cells: { overdue: "4 (33%)", onTime: "80%" } });
    const s = spendCharts({ vi: false }, [{ name: "Sales", costUsd: 0 }], [{ model: "m", costUsd: null, tokens: 9 }]);
    expect(s).toEqual([]);
  });
});
