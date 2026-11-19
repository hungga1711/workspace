import { describe, expect, it } from "vitest";
import { actionsFor, cardsOf, nextSteps, readBlocks } from "./types";

const ok = (tool: string) => ({ serverId: "workspace", tool, outcome: "ok" });

describe("readBlocks", () => {
  it("keeps well-formed charts and tables and drops the rest", () => {
    const blocks = readBlocks([
      {
        kind: "chart",
        id: "w",
        title: "Load",
        chart: "bars",
        rows: [
          { label: "An", value: 3, drill: { url: "/app/work/people/a" } },
          { label: "bad", value: "x" },
        ],
      },
      { kind: "table", id: "t", title: "T", columns: [{ key: "a", label: "A", num: true }], rows: [{ cells: { a: 2, b: 9 } }, { nope: 1 }] },
      { kind: "chart", rows: [] },
      { kind: "pie", rows: [{ label: "x", value: 1 }] },
      "text",
      null,
    ]);
    expect(blocks).toEqual([
      { kind: "chart", id: "w", title: "Load", chart: "bars", rows: [{ label: "An", value: 3, drill: { url: "/app/work/people/a" } }] },
      { kind: "table", id: "t", title: "T", columns: [{ key: "a", label: "A", num: true }], rows: [{ cells: { a: 2 } }] },
    ]);
  });

  it("never links out of the app and survives anything", () => {
    expect(readBlocks([{ kind: "chart", id: "x", chart: "bars", rows: [{ label: "a", value: 1, drill: { url: "https://x.example" } }] }])[0]).toMatchObject({
      rows: [{ label: "a", value: 1 }],
    });
    expect(readBlocks(undefined)).toEqual([]);
    expect(readBlocks({ kind: "chart" })).toEqual([]);
  });
});

describe("actionsFor", () => {
  it("next steps follow the workspace tools that worked, three at most, each once", () => {
    expect(actionsFor([ok("workload_balance"), ok("overdue_tasks"), ok("summarize_channel"), ok("extract_action_items"), ok("ai_spend")]).map((a) => a.key)).toEqual([
      "rebalance",
      "nudgeOwners",
      "makeTasks",
    ]);
    expect(
      actionsFor([
        { serverId: "workspace", tool: "workload_balance", outcome: "denied" },
        { serverId: "github", tool: "overdue_tasks", outcome: "ok" },
      ]),
    ).toEqual([]);
    expect(actionsFor(undefined)).toEqual([]);
  });
});

describe("cardsOf", () => {
  it("tasks first, then people, pages and meetings; four at most, each once", () => {
    const s = (type: string, id: string) => ({ type, id, title: id, url: `/app/${id}` });
    expect(cardsOf([s("document", "d"), s("message", "m"), s("task", "t1"), s("employee", "e"), s("task", "t1"), s("meeting", "x"), s("task", "t2")]).map((x) => x.id)).toEqual([
      "t1",
      "t2",
      "e",
      "d",
    ]);
  });
});

describe("nextSteps", () => {
  const text = (key: string) => ({ label: `L:${key}`, ask: key === "rebalance" ? "Suggest which tasks to move from the overloaded people to those with room." : `ask ${key}` });
  it("actions first, then questions; a question with the same intent and a repeat are left out; four at most", () => {
    const steps = nextSteps(
      [ok("workload_balance"), ok("ai_spend")],
      ["Which tasks should move from the overloaded people?", "Who has the most overdue work?", "Who has the most overdue work?", "How was last month?", "And the month before?"],
      text,
      true,
    );
    expect(steps.map((s) => [s.kind, s.label])).toEqual([
      ["action", "L:rebalance"],
      ["action", "L:openAdoption"],
      ["question", "Who has the most overdue work?"],
      ["question", "How was last month?"],
    ]);
    expect(steps[1]!.url).toBe("/app/ai/adoption");
  });
  it("without a box to fill only screens to open remain", () => {
    expect(nextSteps([ok("workload_balance"), ok("ai_spend")], ["Anything?"], text, false).map((s) => s.id)).toEqual(["a:openAdoption"]);
  });
});
