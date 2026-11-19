import { describe, expect, it } from "vitest";
import { fastModelSuggestions, suggest, summarize, RULES, type RunFacts, type StepFacts, type WorkflowInsight } from "./insights.js";

const T0 = Date.parse("2026-11-10T08:00:00Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
let n = 0;
const run = (steps: StepFacts[], more: Partial<RunFacts> = {}): RunFacts => ({
  id: `r${++n}`,
  workflow_id: "wf1",
  workflow_name: "Launch post",
  runner: "server",
  status: "done",
  created_at: new Date(T0),
  finished_at: new Date(T0 + 30 * 60_000),
  steps,
  ...more,
});
const attempt = (i?: number, t?: number, o = "done", m = "main-1") => ({ k: "attempt", o, ...(i === undefined ? {} : { i, m, ...(t === undefined ? {} : { t }) }) });
const ai = (key: string, more: Partial<StepFacts> = {}): StepFacts => ({
  key,
  title: key,
  kind: "ai",
  state: "done",
  startedAt: at(0),
  finishedAt: at(4),
  h: [attempt(1000, 200)],
  outChars: 800,
  ...more,
});

describe("summarize", () => {
  it("adds up tokens per attempt and per model, and splits working time from waiting for people", () => {
    const r = summarize(
      [
        run([
          // Sent back once: two attempts, both paid for; four minutes of its ten were spent waiting for answers.
          ai("draft", { finishedAt: at(10), waitedMs: 4 * 60_000, h: [attempt(1000, 200), { k: "sent_back" }, attempt(1500, 300), { k: "answered" }] }),
          { key: "ok", title: "Approve", kind: "approval", state: "done", startedAt: at(10), finishedAt: at(30) },
          { key: "move", title: "Move", kind: "status", state: "done" },
        ]),
      ],
      30,
    );
    const w = r.workflows[0]!;
    expect(w).toMatchObject({ runs: 1, done: 1, tokens: { input: 2500, output: 500 }, tokensUnknownRuns: 0, sentBack: 1, avgSec: 1800, avgWorkSec: 360, avgWaitSec: 1440 });
    expect(w.models).toEqual([{ provider: null, model: "main-1", input: 2500, output: 500 }]);
    // The status step is the engine's own: it is not a step anyone waits on or pays for.
    expect(w.steps.map((s) => s.key)).toEqual(["draft", "ok"]);
    expect(w.steps[0]).toMatchObject({ sentBack: 1, avgSec: 360, avgWaitSec: 240, tokens: { input: 2500, output: 500 }, models: ["main-1"] });
    expect(w.steps[1]).toMatchObject({ kind: "approval", avgSec: null, avgWaitSec: 1200 });
    expect(r.totals).toMatchObject({ runs: 1, done: 1, tokens: { input: 2500, output: 500 }, workSec: 360, waitSec: 1440, sentBack: 1 });
    expect(r.daily).toEqual([{ day: "2026-11-10", runs: 1, failed: 0, tokens: 3000 }]);
  });

  it("says tokens are unknown when an AI step ran and reported none, never zero", () => {
    const r = summarize([run([ai("code", { h: [{ k: "attempt", o: "done" }] })], { runner: "local" }), run([ai("code")])], 30);
    expect(r.workflows[0]).toMatchObject({ tokens: { input: 1000, output: 200 }, tokensUnknownRuns: 1 });
    expect(r.workflows[0]!.steps[0]).toMatchObject({ runs: 2, tokensUnknown: 1 });
    expect(r.totals.tokensUnknownRuns).toBe(1);
  });

  it("counts a check's failed verdicts, a step's failures, and leaves steps that never started out", () => {
    const check = (bad: number, state = "done"): StepFacts => ({
      key: "check",
      title: "Reads well",
      kind: "check",
      state,
      startedAt: at(4),
      finishedAt: at(5),
      ranModel: "fast-1",
      h: [
        ...Array.from({ length: bad }, () => [attempt(300, 20, "done", "fast-1"), { k: "checked", o: "failed" }]).flat(),
        attempt(300, 20, "done", "fast-1"),
        { k: "checked", o: "done" },
      ],
    });
    const r = summarize(
      [
        run([ai("draft"), check(2)]),
        run([ai("draft"), check(0)]),
        run([ai("draft", { state: "failed", h: [attempt(undefined, undefined, "failed")] }), { key: "check", title: "Reads well", kind: "check", state: "pending" }], {
          status: "failed",
        }),
      ],
      30,
    );
    const [draft, c] = r.workflows[0]!.steps;
    expect(draft).toMatchObject({ runs: 3, done: 2, failed: 1 });
    expect(c).toMatchObject({ runs: 2, notPassed: 1, sentBack: 2, tokens: { input: 1200, output: 80 } });
    expect(r.workflows[0]).toMatchObject({ runs: 3, done: 2, failed: 1 });
  });

  it("orders workflows by what they spend and keeps a deleted workflow's runs under its name", () => {
    const r = summarize([run([ai("a")], { workflow_id: null, workflow_name: "Gone" }), run([ai("a", { h: [attempt(9000, 900)] })])], 7, true);
    expect(r.workflows.map((w) => [w.id, w.name])).toEqual([
      ["wf1", "Launch post"],
      [null, "Gone"],
    ]);
    expect(r).toMatchObject({ days: 7, capped: true });
  });
});

describe("suggestions", () => {
  const flow = (steps: Partial<WorkflowInsight["steps"][number]>[], more: Partial<WorkflowInsight> = {}): Omit<WorkflowInsight, "suggestions"> => ({
    id: "wf1",
    name: "W",
    runs: 10,
    done: 10,
    failed: 0,
    cancelled: 0,
    active: 0,
    tokens: { input: 0, output: 0 },
    tokensUnknownRuns: 0,
    models: [],
    avgSec: 600,
    avgWorkSec: 300,
    avgWaitSec: 300,
    sentBack: 0,
    steps: steps.map((s, i) => ({
      key: `s${i}`,
      title: `Step ${i}`,
      kind: "ai",
      runs: 10,
      done: 10,
      failed: 0,
      sentBack: 0,
      notPassed: 0,
      retried: 0,
      avgSec: 60,
      avgWaitSec: null,
      tokens: { input: 0, output: 0 },
      tokensUnknown: 0,
      avgOutputTokens: null,
      avgOutChars: null,
      models: [],
      ...s,
    })),
    ...more,
  });

  it("says nothing about a workflow with too few runs", () => {
    expect(suggest(flow([{ kind: "check", notPassed: 3, runs: 3 }], { runs: RULES.MIN_RUNS - 1 }))).toEqual([]);
  });

  it("names the step to tighten when a check keeps sending its work back", () => {
    expect(suggest(flow([{ title: "Draft" }, { kind: "check", title: "On brand", notPassed: 6 }]))).toEqual([
      { rule: "check_sends_back", stepKey: "s1", step: "On brand", author: "Draft", pct: 60 },
    ]);
    expect(suggest(flow([{ title: "Draft" }, { kind: "check", notPassed: 4 }]))).toEqual([]);
  });

  it("flags a step that fails often, time lost to waiting, a step that reads most of the tokens and one that takes most of the time", () => {
    expect(suggest(flow([{ failed: 3 }]))).toEqual([{ rule: "step_fails", stepKey: "s0", step: "Step 0", pct: 30 }]);
    expect(suggest(flow([{ failed: 1, runs: 4 }]))).toEqual([]);
    expect(suggest(flow([{}], { avgWorkSec: 300, avgWaitSec: 3600 }))).toEqual([{ rule: "waits_for_people", minutes: 60 }]);
    expect(suggest(flow([{}], { avgWorkSec: 100, avgWaitSec: 400 }))).toEqual([]);
    expect(suggest(flow([{ tokens: { input: 400_000, output: 10_000 } }, { tokens: { input: 20_000, output: 5000 } }], { tokens: { input: 420_000, output: 15_000 } }))).toEqual([
      { rule: "step_reads_much", stepKey: "s0", step: "Step 0", pct: 94 },
    ]);
    expect(suggest(flow([{ avgSec: 900 }, { avgSec: 60 }]))).toEqual([{ rule: "step_slow", stepKey: "s0", step: "Step 0", minutes: 15 }]);
  });

  it("offers the fast model only for short answers of the company's main model that were never sent back", () => {
    const w = {
      ...flow([
        { avgOutputTokens: 120, avgOutChars: 500 },
        { avgOutputTokens: 120, avgOutChars: 500 },
        { avgOutputTokens: 2000, avgOutChars: 9000 },
        { avgOutputTokens: 100, avgOutChars: 300, sentBack: 2 },
      ]),
      suggestions: [],
    };
    const asks = new Map<string, string | undefined>([
      ["s0", undefined],
      ["s1", "fast"],
      ["s2", ""],
      ["s3", ""],
    ]);
    expect(fastModelSuggestions(w, asks, 10)).toEqual([{ rule: "fast_model", stepKey: "s0", step: "Step 0" }]);
    // Runs on people's computers pick their own model: nothing to suggest.
    expect(fastModelSuggestions(w, asks, 0)).toEqual([]);
  });
});
