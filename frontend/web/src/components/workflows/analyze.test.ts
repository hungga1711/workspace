import { describe, expect, it } from "vitest";
import { analyze, describeModel, placeholders, slug, stepKeys } from "./analyze";
import { defaultConfig, type ModelCatalog, type RunnerInfo, type WorkflowConfig, type WorkflowStep } from "./types";

const catalog: Pick<ModelCatalog, "models" | "defaults"> = {
  models: [
    { route: "c_1:claude-sonnet-5-5", vendor: "anthropic", label: "Claude", model: "claude-sonnet-5-5", tier: "smart" },
    { route: "c_1:claude-haiku-5-5", vendor: "anthropic", label: "Claude", model: "claude-haiku-5-5", tier: "fast" },
  ],
  defaults: {
    smart: { route: "c_1:claude-sonnet-5-5", label: "Claude", model: "claude-sonnet-5-5" },
    fast: { route: "c_1:claude-haiku-5-5", label: "Claude", model: "claude-haiku-5-5" },
  },
};
const ai = (key: string, prompt: string, extra: Partial<WorkflowStep> = {}): WorkflowStep => ({ key, title: key, kind: "ai", prompt, ...extra });
const approval: WorkflowStep = { key: "ok", title: "ok", kind: "approval" };
const codes = (x: ReturnType<typeof analyze>) => x.findings.map((f) => `${f.step}:${f.code}`);

describe("placeholders", () => {
  it("finds the filled ones and the unknown ones", () => {
    expect(placeholders("Do {{task}} then {{ previous }} and {{foo}}")).toMatchObject({ task: true, previous: true, answers: false, resources: false, unknown: ["foo"] });
    expect(placeholders("{{steps.plan}} {{input.tone}} {{inputs}} {{resources}} {{steps.}} {{other.x}}")).toMatchObject({
      steps: ["plan"],
      input: ["tone"],
      inputs: true,
      resources: true,
      unknown: ["steps.", "other.x"],
    });
  });
});

describe("describeModel", () => {
  it("reads default, fast, a picked route and one no longer connected", () => {
    expect(describeModel({}, "server", catalog)).toMatchObject({ kind: "default", model: "claude-sonnet-5-5" });
    expect(describeModel({ model: "fast" }, "server", catalog)).toMatchObject({ kind: "fast", model: "claude-haiku-5-5" });
    expect(describeModel({ model: "c_1:claude-haiku-5-5" }, "server", catalog)).toMatchObject({ kind: "picked", label: "Claude" });
    expect(describeModel({ model: "c_9:gpt-5" }, "server", catalog)).toMatchObject({ kind: "missing", model: "gpt-5" });
    expect(describeModel({}, "server", null).kind).toBe("none");
    expect(describeModel({ model: "opus" }, "local", null)).toEqual({ kind: "agent", model: "opus" });
  });
});

describe("analyze", () => {
  it("traces each result to the step that reads it, the approval that reviews it, and the final comment", () => {
    const x = analyze([ai("a", "Summarize the request.\n\n{{task}}"), ai("b", "Draft the quote from this.\n\n{{previous}}"), approval], "server", catalog);
    expect(x.flows[0]).toMatchObject({ readBy: [1], reviewedBy: null, final: false, mayAsk: true });
    expect(x.flows[1]).toMatchObject({ previousFrom: 0, reviewedBy: 2, final: true, mayAsk: true });
    expect(x.flows[2]).toMatchObject({ previousFrom: 1 });
    expect(x.findings).toEqual([]);
    expect(x.summary).toMatchObject({ ai: 2, approvals: 1, final: 1, calls: { min: 2, max: 14 } });
  });

  it("carries approval notes into the next step's {{previous}}", () => {
    const x = analyze([ai("a", "Five directions for this task.\n\n{{task}}"), approval, ai("c", "Develop the chosen direction.\n\n{{previous}}")], "server", catalog);
    expect(x.flows[2]).toMatchObject({ previousFrom: 0, notesFrom: [1] });
    expect(codes(x)).toEqual(["2:afterApproval"]);
  });

  it("flags a step with no input, an empty {{previous}}, unknown placeholders, short prompts and dropped results", () => {
    const x = analyze(
      [ai("a", "Write the summary now please, thanks."), ai("b", "{{previous}} {{foo}}"), ai("c", "Write a one page report from the task.\n\n{{task}}")],
      "server",
      catalog,
    );
    // The first step places nothing: the engine gives it the task, so that is not a finding.
    expect(codes(x)).toEqual(["1:unknownPlaceholder", "1:shortPrompt", "1:resultUnused", "2:finalUnreviewed"]);
    expect(codes(analyze([ai("a", "Plan the change carefully please.\n\n{{previous}}")], "server", catalog))).toContain("0:previousEmpty");
  });

  it("flags approvals with nothing to approve, twice in a row, missing models and no company AI", () => {
    expect(codes(analyze([approval, ai("a", "Write a one page report from the task.\n\n{{task}}")], "server", catalog))).toEqual(["0:approvalNothing", "1:afterApproval"]);
    const twice = analyze([ai("a", "Write a one page report from the task.\n\n{{task}}"), approval, approval], "server", catalog);
    expect(codes(twice)).toEqual(["2:approvalTwice"]);
    expect(codes(analyze([ai("a", "Write a one page report from the task.\n\n{{task}}", { model: "c_9:gpt-5" }), approval], "server", catalog))).toEqual(["0:modelMissing"]);
    expect(codes(analyze([ai("a", "Write a one page report from the task.\n\n{{task}}"), approval], "server", null))).toEqual(["null:noAi"]);
  });

  it("is gentler with a coding agent, which works on the folder", () => {
    const x = analyze([ai("a", "Plan the change: files, approach, risks.\n\n{{task}}"), ai("b", "Review the changes on this branch and fix what needs fixing.")], "local", null);
    expect(x.findings.map((f) => `${f.severity}:${f.code}`)).toEqual(["info:resultUnused", "info:finalUnreviewed"]);
    expect(x.summary.calls).toEqual({ min: 2, max: 2 });
  });

  it("reads earlier results by key and refuses keys that are unknown, later or not a result", () => {
    const x = analyze(
      [
        ai("Facts", "List the facts of the task.\n\n{{task}}"),
        ai("draft", "Write the post from {{steps.facts}} and {{steps.nope}} and {{steps.check}} and {{steps.ok}}."),
        approval,
        ai("check", "Check the post against the facts.\n\n{{previous}}"),
      ],
      "server",
      catalog,
    );
    expect(x.keys).toEqual(["facts", "draft", "ok", "check"]);
    expect(x.flows[1]).toMatchObject({ reads: [0] });
    expect(x.flows[0]!.readBy).toEqual([1]);
    expect(codes(x)).toEqual(["1:unknownStep", "1:laterStep", "1:unknownStep", "3:afterApproval"]);
  });

  it("gives keys the way the server does: slugged, unique", () => {
    expect(slug("Bản nháp Đầu tiên!", "s1")).toBe("ban-nhap-dau-tien");
    expect(
      stepKeys([
        { key: "", title: "Draft" },
        { key: "", title: "Draft" },
        { key: "", title: "!!!" },
      ]),
    ).toEqual(["draft", "draft-2", "s3"]);
  });

  const cfg = (patch: Partial<WorkflowConfig> = {}): WorkflowConfig => ({ ...defaultConfig(), ...patch });
  const check = (extra: Partial<WorkflowStep> = {}): WorkflowStep => ({ key: "chk", title: "chk", kind: "check", criteria: "Every claim has a source.", ...extra });

  it("a check judges the last result, sends it back to the AI step that made it, and counts as looking at the final result", () => {
    const x = analyze([ai("a", "Write a one page report from the task.\n\n{{task}}"), check()], "server", catalog, { config: cfg() });
    expect(x.flows[1]).toMatchObject({ previousFrom: 0, sendsBackTo: 0 });
    expect(x.flows[0]!.checkedBy).toEqual([1]);
    expect(x.findings).toEqual([]);
    expect(x.summary).toMatchObject({ checks: 1, calls: { min: 2, max: 8 } });
    expect(codes(analyze([check(), ai("a", "Write a one page report from the task.\n\n{{task}}")], "server", catalog))).toEqual(["0:checkNothing", "1:afterApproval"]);
    expect(codes(analyze([ai("a", "Write a one page report from the task.\n\n{{task}}"), check({ criteria: " " })], "server", catalog))).toEqual(["1:checkEmpty"]);
    // A command step without its command cannot be saved: said before Save.
    expect(codes(analyze([ai("a", "Fix the bug in the task.\n\n{{task}}"), { key: "c", title: "c", kind: "command", command: " " }, approval], "local", null))).toContain(
      "1:commandEmpty",
    );
    // A command decides on a runner; on the company's AI a command is refused.
    expect(codes(analyze([ai("a", "Fix the bug in the task.\n\n{{task}}"), check({ criteria: "", command: "npm test" })], "local", null))).toEqual([]);
    expect(codes(analyze([ai("a", "Fix the bug in the task.\n\n{{task}}"), { key: "c", title: "c", kind: "command", command: "ls" }, approval], "server", catalog))).toContain(
      "1:commandOnAssistant",
    );
  });

  it("checks inputs: unknown keys, declared but unused, required with auto-start", () => {
    const inputs = [
      { key: "tone", label: "Tone", type: "text" as const },
      { key: "", label: "Audience", type: "text" as const, required: true },
    ];
    const x = analyze([ai("a", "Write it in a {{input.tone}} tone for {{input.who}}.\n\n{{task}}"), approval], "server", catalog, { config: cfg({ inputs, autoStart: true }) });
    expect(codes(x)).toEqual(["0:unknownInput", "null:autoStartInput"]);
    expect(x.findings.map((f) => f.section)).toEqual(["steps", "start"]);
    // The same holds when a trigger starts it: nobody is there to answer.
    const triggered = analyze([ai("a", "{{inputs}}\n\n{{task}}"), approval], "server", catalog, {
      config: cfg({ inputs, triggers: [{ id: "start-1", kind: "schedule", every: "day", days: [], time: "09:00", projectId: "", title: "" }] }),
    });
    expect(codes(triggered)).toContain("null:autoStartInput");
    // {{inputs}} reads them all.
    expect(codes(analyze([ai("a", "Write the brief.\n\n{{inputs}}"), approval], "server", catalog, { config: cfg({ inputs }) }))).toEqual([]);
  });

  it("checks the environment, the output and the limits", () => {
    const steps = [ai("a", "Analyse the data in ../assets and write the report.\n\n{{task}}", { timeoutMin: 90 }), approval];
    const runner = (r: Partial<RunnerInfo>): RunnerInfo => ({
      id: "r",
      device: "mac",
      shared: false,
      mine: true,
      online: true,
      docker: false,
      agent: "claude -p",
      lastSeenAt: "",
      ...r,
    });
    expect(codes(analyze(steps, "server", catalog, { config: cfg({ output: { ...defaultConfig().output, files: true } }) }))).toEqual([
      "0:stepOverRun",
      "null:filesNoRunner",
      "null:overTime",
    ]);
    const box = cfg({ environment: { kind: "sandbox", host: "company", isolation: "container", image: "python:3.12-slim", network: "off", agent: "claude -p" } });
    expect(codes(analyze([steps[0]!, approval], "local", null, { config: { ...box, guardrails: { ...box.guardrails, maxMinutes: 120 } }, runners: [runner({})] }))).toEqual([
      "null:agentNoNetwork",
      "null:noCompanyRunner",
    ]);
    const mine = cfg({
      environment: { kind: "sandbox", host: "person", isolation: "container", image: "node:22-slim" },
      guardrails: { ...defaultConfig().guardrails, maxMinutes: 120 },
    });
    expect(codes(analyze(steps, "local", null, { config: mine, runners: [runner({})] }))).toEqual(["null:noDocker"]);
    expect(codes(analyze(steps, "local", null, { config: mine, runners: [runner({ docker: true })] }))).toEqual([]);
  });

  it("an approval by a named person needs the person; asking can be turned off", () => {
    const x = analyze([ai("a", "Write a one page report from the task.\n\n{{task}}", { ask: false }), { ...approval, approver: "person" }], "server", catalog, {
      config: cfg({ guardrails: { ...defaultConfig().guardrails, ask: "never" } }),
    });
    expect(codes(x)).toEqual(["1:approverMissing"]);
    expect(x.flows[0]!.mayAsk).toBe(false);
  });

  it("a step limit longer than the whole run is pointed out", () => {
    const base = defaultConfig();
    const x = analyze([{ key: "a", title: "a", kind: "ai", prompt: "Write a one page report from the task.\n\n{{task}}" }], "server", null, {
      config: { ...base, guardrails: { ...base.guardrails, maxMinutes: 5, stepMinutes: 60 } },
    });
    expect(x.findings.map((f) => f.code)).toContain("stepLimitOverRun");
  });
});
