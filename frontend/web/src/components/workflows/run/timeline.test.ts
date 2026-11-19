import { describe, expect, it } from "vitest";
import { buildTimeline, momentAt, momentFor, playClock } from "./timeline";
import type { StepActivity } from "../types";

const T0 = Date.parse("2026-11-13T09:00:00.000Z");
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
let id = 0;
const ev = (step: number, sec: number, kind: StepActivity["kind"], tool: string | null = null, text = ""): StepActivity => ({ id: ++id, step, at: at(sec), kind, tool, text });

const run = {
  id: "r1",
  status: "done" as const,
  startedBy: "minh",
  createdAt: at(0),
  finishedAt: at(4000),
  error: null,
  inputs: { tone: "warm" },
  config: { inputs: [{ key: "tone", label: "Tone" }] } as never,
  env: { state: "ready" as const, startedAt: at(1), finishedAt: at(3) },
  asks: [
    {
      id: "q1",
      runId: "r1",
      stepIndex: 0,
      round: 1,
      questions: [],
      answers: {},
      outcome: "answered" as const,
      askedAt: at(20),
      answeredBy: "lan",
      answeredAt: at(3620),
      closedAt: at(3620),
    },
  ],
  steps: [
    {
      kind: "ai" as const,
      state: "done" as const,
      startedAt: at(5),
      history: [
        { at: at(5), kind: "attempt" as const, outcome: "asked" as const, end: at(20) },
        { at: at(3620), kind: "answered" as const, by: "lan", text: "Tone: warm" },
        { at: at(3621), kind: "attempt" as const, outcome: "done" as const, end: at(3640), output: "Draft" },
        { at: at(3700), kind: "sent_back" as const, by: "check", text: "too long" },
        { at: at(3701), kind: "attempt" as const, outcome: "done" as const, end: at(3720), output: "Shorter" },
      ],
    },
    {
      kind: "check" as const,
      state: "done" as const,
      history: [
        { at: at(3650), kind: "attempt" as const, outcome: "done" as const, end: at(3700) },
        { at: at(3700), kind: "checked" as const, by: "check", outcome: "failed" as const, text: "too long" },
        { at: at(3725), kind: "attempt" as const, outcome: "done" as const, end: at(3730) },
        { at: at(3730), kind: "checked" as const, by: "check", outcome: "done" as const },
      ],
    },
    { kind: "approval" as const, state: "done" as const, startedAt: at(3731), history: [{ at: at(3990), kind: "approved" as const, by: "minh" }] },
  ],
};
const events = [
  ev(0, 5, "start"),
  ev(0, 7, "tool", "Read", "brief.md"),
  ev(0, 8, "result", "Read", "12 lines"),
  ev(0, 9, "say", null, "I need the tone."),
  ev(0, 3621, "start"),
  ev(0, 3625, "tool", "Bash", "wc -w draft.md"),
  ev(0, 3626, "error", "Bash", "no such file"),
  ev(0, 3627, "result", "Other", "orphan"),
  ev(0, 3630, "draft"),
  ev(0, 3701, "start"),
];

describe("buildTimeline", () => {
  const tl = buildTimeline(run, events);
  const shape = tl.map((m) => `${m.step}:${m.kind}${m.kind === "attempt" || m.kind === "ended" ? m.n : ""}`);

  it("puts everything that happened to a run in the order it happened", () => {
    expect(shape).toEqual([
      "-1:started",
      "-1:env",
      "0:attempt1",
      "0:activity",
      "0:activity",
      "0:asked",
      "0:ended1",
      "0:gap",
      "0:note",
      "0:attempt2",
      "0:activity",
      "0:ended2",
      "1:attempt1",
      "1:note",
      "0:note",
      "0:attempt3",
      "0:ended3",
      "1:attempt2",
      "1:note",
      "2:awaiting",
      "2:gap",
      "2:note",
      "-1:finished",
    ]);
  });

  it("keeps an action and how it ended as one row, and leaves out drafts and results with no action", () => {
    const rows = tl.filter((m) => m.kind === "activity").map((m) => (m.kind === "activity" ? m.events.map((e) => e.kind) : []));
    expect(rows).toEqual([["tool", "result"], ["say"], ["tool", "error"]]);
  });

  it("names what the run was started with by the input's label", () => {
    expect(tl[0]).toMatchObject({ kind: "started", by: "minh", inputs: [["Tone", "warm"]] });
  });

  it("says a long quiet stretch, and whether people were being waited for", () => {
    expect(tl.filter((m) => m.kind === "gap")).toMatchObject([
      { ms: 3600_000, people: true },
      { ms: 259_000, people: true },
    ]);
  });

  it("gives an attempt only the history knows its own start (runs from before the activity lines)", () => {
    const old = buildTimeline({ ...run, asks: [], env: null }, []);
    expect(old.filter((m) => m.kind === "attempt")).toHaveLength(5);
  });
});

describe("the playback clock", () => {
  it("plays at the run's pace but never waits longer than the cap", () => {
    const clock = playClock([{ at: 0 }, { at: 400 }, { at: 400 }, { at: 90_000 }, { at: 90_100 }], 1500);
    expect(clock).toEqual({ at: [0, 400, 400, 1900, 2000], total: 2000 });
    expect(momentAt(clock, 0)).toBe(0);
    expect(momentAt(clock, 450)).toBe(2);
    expect(momentAt(clock, 1899)).toBe(2);
    expect(momentAt(clock, 99_999)).toBe(4);
  });

  it("finds the moment a link points at", () => {
    const ms = [{ at: 10 }, { at: 20 }, { at: 20 }, { at: 30 }];
    expect(momentFor(ms, 5)).toBe(0);
    expect(momentFor(ms, 20)).toBe(2);
    expect(momentFor(ms, 999)).toBe(3);
  });
});
