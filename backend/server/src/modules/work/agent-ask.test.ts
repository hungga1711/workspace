import { describe, expect, it } from "vitest";
import {
  ASK_HINT,
  DECIDE_HINT,
  MAX_QUESTIONS,
  MAX_RUN_ROUNDS,
  MAX_STEP_ROUNDS,
  answersText,
  cleanAnswers,
  composePrompt,
  mayAsk,
  mayAskInRun,
  parseAsk,
  partialAnswers,
  type AskRound,
} from "./agent-ask.js";

describe("parseAsk", () => {
  it("reads a workspace-ask block with JSON", () => {
    const out = 'Before I start:\n```workspace-ask\n{"questions": [{"text": "Which market?", "options": ["VN", "SG"]}, {"text": "Deadline?"}]}\n```\n';
    expect(parseAsk(out)).toEqual([
      { id: "q1", text: "Which market?", kind: "choice", options: ["VN", "SG"] },
      { id: "q2", text: "Deadline?", kind: "text" },
    ]);
  });

  it("accepts a bare array, strings, trailing commas and an unclosed fence", () => {
    expect(parseAsk('```workspace-ask\n["Who signs off?", "Budget?",]\n')).toEqual([
      { id: "q1", text: "Who signs off?", kind: "text" },
      { id: "q2", text: "Budget?", kind: "text" },
    ]);
  });

  it("falls back to one question per line when the block is not JSON", () => {
    expect(parseAsk("```workspace-ask\n1. Which repo?\n- Which branch?\n```")?.map((q) => q.text)).toEqual(["Which repo?", "Which branch?"]);
  });

  it("reads a reply that is only {ask: [...]} (bare or in a json fence)", () => {
    expect(parseAsk('{"ask": [{"question": "Tone?", "choices": ["formal", "casual", "formal"]}]}')).toEqual([
      { id: "q1", text: "Tone?", kind: "choice", options: ["formal", "casual"] },
    ]);
    expect(parseAsk('```json\n{"questions": ["Logo?"]}\n```')?.[0]?.text).toBe("Logo?");
  });

  it("ignores the hint's placeholders copied back", () => {
    expect(parseAsk('```workspace-ask\n{"questions": [{"text": "<your question>", "options": ["<answer A>", "<answer B>"]}]}\n```')).toBeNull();
    expect(parseAsk('```workspace-ask\n{"questions": [{"text": "Real?", "options": ["<answer A>", "yes"]}]}\n```')).toEqual([{ id: "q1", text: "Real?", kind: "text" }]);
  });

  it("leaves ordinary results alone", () => {
    expect(parseAsk("Here is the plan:\n1. Do X\n2. Do Y")).toBeNull();
    expect(parseAsk('{"title": "not a question"}')).toBeNull();
    expect(parseAsk("```json\n[1, 2]\n```")).toBeNull();
    expect(parseAsk("```workspace-ask\n{}\n```")).toBeNull();
    expect(parseAsk("")).toBeNull();
  });

  it("caps the number of questions and a choice needs two options", () => {
    const many = JSON.stringify({ questions: Array.from({ length: 9 }, (_, i) => ({ text: `Q${i}`, options: ["only one"] })) });
    const qs = parseAsk(`\`\`\`workspace-ask\n${many}\n\`\`\``)!;
    expect(qs).toHaveLength(MAX_QUESTIONS);
    expect(qs.every((q) => q.kind === "text" && !q.options)).toBe(true);
  });
});

describe("composePrompt", () => {
  const q = [{ id: "q1", text: "Market?", kind: "text" as const }];
  it("adds the ask hint while the step may ask, the decide hint when it may not", () => {
    expect(composePrompt("Do it", [], true)).toBe(`Do it\n\n${ASK_HINT}`);
    const answered: AskRound = { questions: q, answers: { q1: "Vietnam" }, outcome: "answered" };
    const p = composePrompt("Do it", [answered], true);
    expect(p).toContain("Q: Market?\nA: Vietnam");
    expect(p.endsWith(ASK_HINT)).toBe(true);
    expect(composePrompt("Do it", [answered], false).endsWith(DECIDE_HINT)).toBe(true);
  });

  it("a skipped round tells the AI to decide and stops further questions", () => {
    const skipped: AskRound = { questions: q, answers: null, outcome: "skipped" };
    expect(mayAsk([skipped])).toBe(false);
    const p = composePrompt("Do it", [skipped], mayAsk([skipped]));
    expect(p).toContain("decide yourself");
    expect(p.endsWith(DECIDE_HINT)).toBe(true);
  });

  it("puts the answers where the workflow placed {{answers}}", () => {
    const p = composePrompt("A\n{{answers}}\nB", [{ questions: q, answers: { q1: "VN" }, outcome: "answered" }], true);
    expect(p.startsWith("A\nAnswers from")).toBe(true);
    expect(composePrompt("A {{answers}} B", [], true)).toContain("A — B");
  });
});

describe("cleanAnswers", () => {
  it("requires every required question", () => {
    const qs = [
      { id: "q1", text: "A?", kind: "text" as const },
      { id: "q2", text: "B?", kind: "text" as const, required: false },
    ];
    expect(cleanAnswers(qs, { q1: "  ", q2: "x" })).toEqual({ ok: false, missing: ["q1"] });
    expect(cleanAnswers(qs, { q1: " yes ", q3: "ignored" })).toEqual({ ok: true, answers: { q1: "yes" } });
  });
});

describe("rounds of questions (2026-11-10: several, capped per step and per run)", () => {
  const q = [
    { id: "q1", text: "Market?", kind: "text" as const },
    { id: "q2", text: "Tone?", kind: "choice" as const, options: ["formal", "casual"] },
  ];
  const round = (step: number, outcome: AskRound["outcome"] = "answered"): AskRound => ({ step, questions: q, answers: { q1: "VN" }, outcome });
  it("any step may ask, and ask again, up to the step's and the run's caps", () => {
    expect(mayAskInRun([], 0)).toBe(true);
    expect(mayAskInRun([], 3)).toBe(true);
    expect(mayAskInRun([round(1)], 1)).toBe(true);
    expect(
      mayAskInRun(
        Array.from({ length: MAX_STEP_ROUNDS }, () => round(1)),
        1,
      ),
    ).toBe(false);
    expect(
      mayAskInRun(
        Array.from({ length: MAX_STEP_ROUNDS }, () => round(1)),
        2,
      ),
    ).toBe(true);
    expect(
      mayAskInRun(
        Array.from({ length: MAX_RUN_ROUNDS }, (_, i) => round(i)),
        99,
      ),
    ).toBe(false);
  });

  it("letting the AI decide stops that step asking, not the steps after it", () => {
    expect(mayAskInRun([round(1, "skipped")], 1)).toBe(false);
    expect(mayAskInRun([round(1, "skipped")], 2)).toBe(true);
  });

  it("keeps the model's best guess as the question's default", () => {
    const out = '```workspace-ask\n{"questions": [{"text": "Market?", "default": "Vietnam"}, {"text": "Tone?", "options": ["formal", "casual"], "default": "<answer A>"}]}\n```';
    expect(parseAsk(out)).toEqual([
      { id: "q1", text: "Market?", kind: "text", default: "Vietnam" },
      { id: "q2", text: "Tone?", kind: "choice", options: ["formal", "casual"] },
    ]);
  });
});

describe("Let the AI decide keeps what was answered (ai review B6)", () => {
  const q = [
    { id: "q1", text: "Market?", kind: "text" as const },
    { id: "q2", text: "Tone?", kind: "text" as const },
  ];
  it("partialAnswers keeps filled answers and drops blanks and unknown ids", () => {
    expect(partialAnswers(q, { q1: " Vietnam ", q2: "  ", q9: "x" })).toEqual({ q1: "Vietnam" });
    expect(partialAnswers(q, {})).toBeNull();
    expect(partialAnswers(q, undefined)).toBeNull();
  });

  it("a skipped round with answers passes them on and leaves only the gaps to the AI", () => {
    const text = answersText([{ questions: q, answers: { q1: "Vietnam" }, outcome: "skipped" }]);
    expect(text).toContain("Q: Market?\nA: Vietnam");
    expect(text).toContain("Q: Tone?\nA: (not answered: decide yourself");
  });
});
