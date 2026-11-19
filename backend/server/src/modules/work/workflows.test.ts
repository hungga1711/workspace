import { describe, expect, it } from "vitest";
import {
  LOG_ENTRIES,
  canApprove,
  cleanInputs,
  endAttempt,
  inputsSatisfied,
  logAttempt,
  logNote,
  normalizeConfig,
  runnerOf,
  slug,
  unfence,
  validSteps,
  validateWorkflow,
  workMs,
  type RunStep,
  type WorkflowStep,
} from "./workflows.js";
import {
  PREVIOUS_MAX,
  checkPrompt,
  checklistItems,
  commandIssues,
  lastResult,
  parseVerdict,
  placeholdersIn,
  previousText,
  renderPrompt,
  resultTitle,
  reworkText,
  runnerNote,
  type PromptParts,
} from "./workflows/render.js";
import { composeResources } from "./workflows/resources.js";
import { readableAs, textOf, unzip } from "./workflows/extract.js";
import { linkTarget } from "./workflows/links.js";
import type { Principal } from "@workspace/shared";

const task = { code: "T-1", title: "Launch post", description: "Write it" };
const parts = (over: Partial<PromptParts> = {}): PromptParts => ({ task, context: "", steps: [], index: 0, fields: [], inputs: {}, resources: "", ...over });
const ai = (key: string, output?: string): RunStep => ({ key, title: key, kind: "ai", prompt: "{{task}}", state: output ? "done" : "pending", output });

describe("a step's instruction", () => {
  it("fills {{task}} and {{previous}}", () => {
    const steps = [ai("draft", "the draft")];
    expect(renderPrompt("Do: {{task}} / {{previous}}", parts({ steps, index: 1 }))).toBe("Do: T-1 · Launch post\n\nWrite it / the draft");
    expect(renderPrompt("{{previous}}", parts())).toBe("—");
  });

  it("adds the workspace context to {{task}} and caps {{previous}}", () => {
    expect(renderPrompt("{{task}}", parts({ context: "Context from the workspace:\nProject: P-1 · Launch" }))).toContain(
      "Write it\n\nContext from the workspace:\nProject: P-1 · Launch",
    );
    const long = [ai("a", "x".repeat(PREVIOUS_MAX + 500))];
    expect(renderPrompt("{{previous}}", parts({ steps: long, index: 1 })).length).toBeLessThan(PREVIOUS_MAX + 10);
  });

  it("reads any earlier step's result by its key, never a later one", () => {
    const steps = [ai("facts", "FACTS"), ai("draft", "DRAFT"), ai("later", "LATER")];
    expect(renderPrompt("{{steps.facts}} + {{previous}} + {{steps.later}} + {{steps.nope}}", parts({ steps, index: 2 }))).toBe("FACTS + DRAFT + — + —");
  });

  it("carries what was filled in at Run with the task, unless the prompt places it", () => {
    const fields = [
      { key: "audience", label: "Audience", type: "text" as const },
      { key: "tone", label: "Tone", type: "text" as const },
    ];
    const inputs = { audience: "CFOs" };
    expect(renderPrompt("{{task}}", parts({ fields, inputs }))).toContain("Details given when this run was started:\n- Audience: CFOs");
    const placed = renderPrompt("For {{input.audience}} in a {{input.tone}} tone.\n\n{{task}}", parts({ fields, inputs }));
    expect(placed).toContain("For CFOs in a — tone.");
    expect(placed).not.toContain("Details given");
    expect(renderPrompt("{{inputs}}", parts({ fields, inputs }))).toMatch(/^- Audience: CFOs\n\nT-1/);
  });

  it("puts the reference material first unless the prompt places it", () => {
    expect(renderPrompt("Do it.\n\n{{task}}", parts({ resources: "## Playbook\nBe brief." }))).toMatch(
      /^Reference material from the company[\s\S]*<reference>\n## Playbook\nBe brief.\n<\/reference>\n\nDo it\.\n\nT-1/,
    );
    expect(renderPrompt("Rules:\n{{resources}}\n\n{{task}}", parts({ resources: "R" }))).toMatch(/^Rules:\nR\n\nT-1/);
  });

  it("gives an instruction that places nothing to work on the task after it", () => {
    expect(renderPrompt("Draft a reply to the customer.", parts())).toBe("Draft a reply to the customer.\n\nT-1 · Launch post\n\nWrite it");
    // One that works from an earlier result does not need it.
    expect(renderPrompt("Tidy this:\n{{previous}}", parts({ steps: [ai("a", "A")], index: 1 }))).toBe("Tidy this:\nA");
  });

  it("leaves {{answers}} and unknown placeholders as written", () => {
    expect(renderPrompt("{{task}} {{answers}} {{whatever}}", parts())).toBe("T-1 · Launch post\n\nWrite it {{answers}} {{whatever}}");
    expect(placeholdersIn("{{task}} {{ steps.plan }} {{input.x}} {{task}}")).toEqual(["task", "steps.plan", "input.x"]);
  });

  it("{{previous}} is the last result, then any approver note given since; checks and approvals are not results", () => {
    const steps: RunStep[] = [
      ai("draft", "DRAFT"),
      { key: "check", title: "Check", kind: "check", criteria: "x", state: "done" },
      { key: "ok", title: "Approve", kind: "approval", state: "done", output: "use option B" },
    ];
    expect(lastResult(steps, 3)).toEqual({ text: "DRAFT", from: 0 });
    expect(previousText(steps, 3)).toBe("DRAFT\n\nNote from the approver:\nuse option B");
  });

  it("tells a step sent back what to change: an approver's request or a check's issues", () => {
    expect(reworkText({ note: "shorter", previous: "OLD" })).toMatch(/approver sent your previous result back[\s\S]*Their request:\nshorter[\s\S]*Your previous result:\nOLD/);
    expect(reworkText({ note: "- no price list", previous: "OLD", check: "Prices" })).toMatch(/automatic check \("Prices"\) did not pass[\s\S]*Issues:\n- no price list/);
    expect(reworkText(undefined)).toBe("");
  });

  it("tells an agent on a runner where its files are", () => {
    expect(runnerNote({ assets: true, out: true })).toContain("{{assets_dir}}");
    expect(runnerNote({ assets: true, out: true })).toContain("{{out_dir}}");
    expect(runnerNote({ assets: false, out: false })).toBe("");
  });
});

describe("checks", () => {
  it("asks a judge with the requirements, the result and the task", () => {
    const p = checkPrompt("Under 200 words\nNo prices", "the result", "Draft", "T-1 · Launch");
    expect(p).toContain("Requirements:\nUnder 200 words\nNo prices");
    expect(p).toContain('made by the step "Draft"');
    expect(p).toContain("workspace-check");
  });

  it("reads a verdict from the block, bare JSON or a PASS/FAIL line; never passes what it cannot read", () => {
    expect(parseVerdict('```workspace-check\n{"pass": true, "issues": []}\n```')).toEqual({ pass: true, issues: [] });
    expect(parseVerdict('Here you go:\n```workspace-check\n{"pass": false, "issues": ["Too long", "Has a price",]}\n```')).toEqual({
      pass: false,
      issues: ["Too long", "Has a price"],
    });
    expect(parseVerdict('{"pass": "false", "issues": [{"issue": "Missing CTA"}]}')).toEqual({ pass: false, issues: ["Missing CTA"] });
    expect(parseVerdict('```json\n{"pass": true}\n```')).toEqual({ pass: true, issues: [] });
    expect(parseVerdict("PASS")).toEqual({ pass: true, issues: [] });
    expect(parseVerdict("FAIL\n- too long\n- no source")).toEqual({ pass: false, issues: ["too long", "no source"] });
    // A fail with no reason still fails, with something for the author to read.
    expect(parseVerdict('{"pass": false}')?.issues).toHaveLength(1);
    expect(parseVerdict("Looks good to me!")).toBeNull();
    expect(parseVerdict("")).toBeNull();
    expect(parseVerdict('{"issues": ["x"]}')).toBeNull();
  });

  it("turns a failed command into issues: its exit code and the end of its output", () => {
    expect(commandIssues("…\n2 tests failed", 1)).toBe("The command exited with 1.\n\n…\n2 tests failed");
  });
});

describe("results", () => {
  it("unwraps a result fenced whole as markdown, nothing else", () => {
    expect(unfence("```markdown\n# Title\n\nBody\n```")).toBe("# Title\n\nBody");
    expect(unfence("Intro\n```js\ncode\n```")).toBe("Intro\n```js\ncode\n```");
    expect(unfence("```\na\n```\ntext\n```\nb\n```")).toBe("```\na\n```\ntext\n```\nb\n```");
  });

  it("finds the open checklist lines that become subtasks", () => {
    const text = "## Plan\n- [ ] **Set up** the account — Lan\n- [x] Done already\n* [ ] Order the laptop\n1. [ ] Book the intro\n- [ ] Order the laptop\nnot a - [ ] line";
    expect(checklistItems(text)).toEqual(["Set up the account — Lan", "Order the laptop", "Book the intro"]);
    expect(checklistItems("- [ ] a\n- [ ] b\n- [ ] c", 2)).toEqual(["a", "b"]);
  });

  it("titles a saved page from the result's first heading", () => {
    expect(resultTitle("intro\n## **Q3 plan**\nbody", "fallback")).toBe("Q3 plan");
    expect(resultTitle("no heading", "T-1 · Spec")).toBe("T-1 · Spec");
  });
});

describe("resources", () => {
  it("keeps the playbook whole and shares the rest of the budget between pages and files", () => {
    const text = composeResources(
      "Be brief.",
      [
        { head: "Page: Voice", body: "v".repeat(5000) },
        { head: "File: prices.csv", body: "p".repeat(5000) },
      ],
      ["## Links\n- https://example.com"],
      3000,
    );
    expect(text.startsWith("## Playbook\nBe brief.")).toBe(true);
    expect(text).toContain("## Page: Voice");
    expect(text).toContain("## File: prices.csv");
    expect(text.endsWith("## Links\n- https://example.com")).toBe(true);
    expect(text.length).toBeLessThanOrEqual(3100);
    expect(composeResources("", [], [])).toBe("");
  });

  it("knows which files it can read the text of", () => {
    expect(readableAs("prices.csv", "application/octet-stream", 1000)).toBe("text");
    expect(readableAs("guide.md", "text/markdown", 1000)).toBe("text");
    expect(readableAs("deck.pdf", "application/pdf", 1000)).toBe("pdf");
    expect(readableAs("Quote.DOCX", "application/octet-stream", 1000)).toBe("office");
    expect(readableAs("budget.xlsx", "", 1000)).toBe("office");
    expect(readableAs("photo.png", "image/png", 1000)).toBeNull();
    expect(readableAs("big.csv", "text/csv", 10_000_000)).toBeNull();
  });

  it("reads Word, Excel and PowerPoint files", async () => {
    const docx = zip({
      "word/document.xml":
        '<w:document><w:body><w:p><w:r><w:t>Refund policy</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Within 30 days </w:t></w:r><w:r><w:t>&amp; with a receipt.</w:t></w:r></w:p></w:body></w:document>',
    });
    expect(await textOf(docx, "policy.docx", "")).toBe("Refund policy\nWithin 30 days & with a receipt.");
    const xlsx = zip({
      "xl/workbook.xml": '<workbook><sheets><sheet name="Prices" sheetId="1"/></sheets></workbook>',
      "xl/sharedStrings.xml": "<sst><si><t>Plan</t></si><si><t>Price</t></si><si><r><t>Team, </t></r><r><t>yearly</t></r></si></sst>",
      "xl/worksheets/sheet1.xml":
        '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>290</v></c></row></sheetData></worksheet>',
    });
    expect(await textOf(xlsx, "prices.xlsx", "")).toBe('Sheet: Prices\nPlan,Price\n"Team, yearly",,290');
    const pptx = zip({
      "ppt/slides/slide2.xml": "<p:sld><a:p><a:r><a:t>Second</a:t></a:r></a:p></p:sld>",
      "ppt/slides/slide1.xml": "<p:sld><a:p><a:r><a:t>Launch plan</a:t></a:r></a:p></p:sld>",
    });
    expect(await textOf(pptx, "deck.pptx", "")).toBe("Slide 1\nLaunch plan\n\nSlide 2\nSecond");
    // A damaged file has no text; it never throws.
    expect(await textOf(Buffer.from("not a zip"), "broken.docx", "")).toBeNull();
    expect(unzip(Buffer.from("PK")).size).toBe(0);
  });

  it("reads a Google link through its export address, and knows a folder is not a file", () => {
    expect(linkTarget("https://docs.google.com/document/d/1AbCdEfGhIjKlMnOp/edit?usp=sharing")).toEqual({
      kind: "gdoc",
      fetch: "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOp/export?format=txt",
    });
    expect(linkTarget("https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOp/edit#gid=42")).toEqual({
      kind: "gsheet",
      fetch: "https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOp/export?format=csv&gid=42",
    });
    expect(linkTarget("https://docs.google.com/presentation/d/1AbCdEfGhIjKlMnOp/edit").kind).toBe("gslides");
    expect(linkTarget("https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view")).toEqual({
      kind: "gdrive",
      fetch: "https://drive.google.com/uc?export=download&id=1AbCdEfGhIjKlMnOp",
    });
    expect(linkTarget("https://drive.google.com/open?id=1AbCdEfGhIjKlMnOp").kind).toBe("gdrive");
    expect(linkTarget("https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOp")).toEqual({ kind: "gfolder", fetch: null });
    expect(linkTarget("https://example.com/pricing")).toEqual({ kind: "web", fetch: "https://example.com/pricing" });
    expect(linkTarget("file:///etc/passwd").fetch).toBeNull();
    expect(linkTarget("not a link").fetch).toBeNull();
  });
});

/** A zip archive with stored (uncompressed) entries: enough to stand in for an Office file. */
function zip(files: Record<string, string>): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const n = Buffer.from(name);
    const data = Buffer.from(text);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt32LE(data.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(n.length, 26);
    local.push(head, n, data);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(n.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, n);
    offset += 30 + n.length + data.length;
  }
  const dirs = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dirs.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, dirs, end]);
}

describe("the workflow model", () => {
  const step = (s: Partial<WorkflowStep>): WorkflowStep => ({ key: "", title: "Step", kind: "ai", prompt: "{{task}}", ...s });

  it("refuses commands on the company's AI and empty AI steps", () => {
    expect(() => validSteps([step({ kind: "command", command: "ls" })], "server")).toThrow(/sandbox or on a computer/);
    expect(() => validSteps([step({ prompt: " " })], "server")).toThrow(/instruction/);
    expect(validSteps([step({ kind: "command", command: "ls" })], "local")[0]!.key).toBe("step");
  });

  it("keeps each kind's own fields, trimmed, and tools off only on the server", () => {
    const s = step({ model: " fast ", role: " An editor. ", tools: false, command: "rm -rf", criteria: "x", maxOutput: 4000, retries: 9 });
    expect(validSteps([s], "server")[0]).toEqual({
      key: "step",
      title: "Step",
      kind: "ai",
      prompt: "{{task}}",
      model: "fast",
      role: "An editor.",
      tools: false,
      maxOutput: 4000,
      retries: 3,
    });
    expect(validSteps([{ ...s, model: "opus" }], "local")[0]).toEqual({
      key: "step",
      title: "Step",
      kind: "ai",
      prompt: "{{task}}",
      model: "opus",
      role: "An editor.",
      retries: 3,
    });
    expect(validSteps([step({}), step({ kind: "approval", prompt: "x", model: "fast", role: "r" })], "server")[1]).toEqual({ key: "step-2", title: "Step", kind: "approval" });
  });

  it("gives steps unique, typable keys", () => {
    const keys = validSteps([step({ title: "Kế hoạch" }), step({ title: "Kế hoạch" }), step({ key: "Fact Sheet!" })], "server").map((s) => s.key);
    expect(keys).toEqual(["ke-hoach", "ke-hoach-2", "fact-sheet"]);
    expect(slug("Đối tượng đọc", "x")).toBe("doi-tuong-doc");
  });

  it("a check needs something to check, and what to check it against", () => {
    expect(() => validateWorkflow([step({ kind: "check", criteria: "short" })], {})).toThrow(/nothing before it/);
    expect(() => validateWorkflow([step({}), step({ kind: "check", criteria: " " })], {})).toThrow(/what to check/);
    // A command check exists only where commands run.
    expect(() => validateWorkflow([step({}), step({ kind: "check", command: "npm test" })], {})).toThrow(/what to check/);
    const v = validateWorkflow([step({}), step({ kind: "check", command: "npm test", criteria: "ignored" })], { environment: { kind: "computer" } });
    expect(v.steps[1]).toEqual({ key: "step-2", title: "Step", kind: "check", command: "npm test", attempts: 2, onFail: "stop" });
    expect(v.runner).toBe("local");
  });

  it("an approval by one person names the person", () => {
    expect(() => validateWorkflow([step({}), step({ kind: "approval", approver: "person" })], {})).toThrow(/needs a person/);
    expect(validateWorkflow([step({}), step({ kind: "approval", approver: "owner", approverId: "u1" })], {}).steps[1]).toEqual({
      key: "step-2",
      title: "Step",
      kind: "approval",
      approver: "owner",
    });
  });

  it("fills a config in with safe defaults", () => {
    const c = normalizeConfig({});
    expect(c.environment).toEqual({ kind: "assistant" });
    expect(c.guardrails).toEqual({ maxMinutes: 60, stepMinutes: 10, maxTokens: 0, ask: "allowed" });
    expect(c.output).toEqual({ comment: true, doc: false, files: false, subtasks: false, status: "" });
    expect(c.resources.taskContext).toBe(true);
    // A workflow from before the config existed says only where it ran.
    expect(normalizeConfig({}, "local").environment).toEqual({ kind: "computer" });
    expect(runnerOf(normalizeConfig({ environment: { kind: "sandbox" } }).environment)).toBe("local");
  });

  it("cleans a sandbox: image, network, limits, variable names; nothing a shell could misread", () => {
    const c = normalizeConfig({
      environment: {
        kind: "sandbox",
        host: "company",
        isolation: "container",
        image: " python:3.12-slim ",
        network: "off",
        cpus: 99,
        memoryMb: 5,
        env: ["OPENAI_API_KEY", "bad name", "OPENAI_API_KEY"],
        setup: " pip install pandas ",
        keep: true,
      },
    });
    expect(c.environment).toEqual({
      kind: "sandbox",
      host: "company",
      isolation: "container",
      image: "python:3.12-slim",
      network: "off",
      cpus: 16,
      memoryMb: 128,
      env: ["OPENAI_API_KEY"],
      setup: "pip install pandas",
      keep: true,
    });
    const one = [step({})];
    expect(() => validateWorkflow(one, { environment: { kind: "sandbox", isolation: "container", image: "x; rm -rf /" } })).toThrow(/image/);
    expect(() => validateWorkflow(one, { environment: { kind: "sandbox", repo: "/etc/passwd" } })).toThrow(/repository/);
    expect(() => validateWorkflow(one, { environment: { kind: "sandbox", repo: "https://github.com/a/b.git; curl evil" } })).toThrow(/repository/);
    expect(() => validateWorkflow(one, { environment: { kind: "sandbox", repo: "https://github.com/a/b.git", branch: "--upload-pack=x y" } })).toThrow(/branch/);
    expect(validateWorkflow(one, { environment: { kind: "sandbox", repo: "git@github.com:a/b.git", branch: "release/1.2" } }).config.environment.repo).toBe(
      "git@github.com:a/b.git",
    );
  });

  it("files are handed back only by a runner; a run starts by itself only where nobody's computer is needed", () => {
    expect(normalizeConfig({ output: { files: true } }).output.files).toBe(false);
    expect(normalizeConfig({ environment: { kind: "sandbox" }, output: { files: true } }).output.files).toBe(true);
    expect(normalizeConfig({ autoStart: true }).autoStart).toBe(true);
    expect(normalizeConfig({ autoStart: true, environment: { kind: "computer" } }).autoStart).toBe(false);
    expect(normalizeConfig({ autoStart: true, environment: { kind: "sandbox", host: "person" } }).autoStart).toBe(false);
    expect(normalizeConfig({ autoStart: true, environment: { kind: "sandbox", host: "company" } }).autoStart).toBe(true);
  });

  it("keeps inputs with typable keys and checks what a run is started with", () => {
    const c = normalizeConfig({
      inputs: [
        { label: "Đối tượng", type: "text", required: true },
        { label: "Tone", type: "choice", options: ["Formal", "Friendly", "Formal"], default: "Friendly" },
        { label: "Budget", type: "number" },
        { label: "", type: "text" },
      ],
    });
    expect(c.inputs.map((f) => f.key)).toEqual(["doi-tuong", "tone", "budget"]);
    expect(c.inputs[1]!.options).toEqual(["Formal", "Friendly"]);
    expect(cleanInputs(c.inputs, { "doi-tuong": " CFOs ", budget: 500, extra: "x" })).toEqual({ "doi-tuong": "CFOs", tone: "Friendly", budget: "500" });
    expect(() => cleanInputs(c.inputs, {})).toThrow(/"Đối tượng" is required/);
    expect(() => cleanInputs(c.inputs, { "doi-tuong": "x", tone: "Rude" })).toThrow(/one of its options/);
    expect(() => cleanInputs(c.inputs, { "doi-tuong": "x", budget: "a lot" })).toThrow(/number/);
    expect(inputsSatisfied(c.inputs)).toBe(false);
    expect(inputsSatisfied(c.inputs.slice(1))).toBe(true);
    expect(() => validateWorkflow([step({})], { inputs: [{ label: "Tone", type: "choice", options: ["One"] }] })).toThrow(/two options/);
  });
});

describe("a run's record", () => {
  it("logs each attempt of a step and what happened to it, capped", () => {
    let s: RunStep = { key: "a", title: "A", kind: "ai", state: "pending" };
    s = endAttempt({ ...logAttempt(s, "in 1"), state: "running" }, "asked", { output: "ask" });
    s = logNote(s, "answered", "u1", "Q\n→ A");
    s = endAttempt({ ...logAttempt(s, "in 2"), state: "running" }, "done", { output: "out", ran: { model: "m" } });
    s = logNote(s, "checked", "check", "- too long", "failed");
    expect(s.history!.map((h) => [h.kind, h.outcome ?? null])).toEqual([
      ["attempt", "asked"],
      ["answered", null],
      ["attempt", "done"],
      ["checked", "failed"],
    ]);
    expect(s.history![2]).toMatchObject({ input: "in 2", output: "out", ran: { model: "m" } });
    for (let i = 0; i < 30; i++) s = logNote(s, "rework", "u1", `n${i}`);
    expect(s.history).toHaveLength(LOG_ENTRIES);
  });

  it("ends an attempt that never opened (runs from before the log)", () => {
    const s = endAttempt({ key: "a", title: "A", kind: "ai", state: "running", startedAt: "2026-11-01T00:00:00.000Z" }, "failed", { text: "boom" });
    expect(s.history).toHaveLength(1);
    expect(s.history![0]).toMatchObject({ kind: "attempt", outcome: "failed", at: "2026-11-01T00:00:00.000Z", text: "boom" });
  });

  it("counts working time from the attempts, never the waits for people", () => {
    const at = (m: number) => new Date(Date.UTC(2026, 10, 1, 9, m)).toISOString();
    const steps: RunStep[] = [
      {
        key: "a",
        title: "A",
        kind: "ai",
        state: "done",
        history: [
          { at: at(0), kind: "attempt", end: at(2), outcome: "asked" },
          { at: at(30), kind: "attempt", end: at(33), outcome: "done" },
        ],
      },
      { key: "ok", title: "OK", kind: "approval", state: "done", startedAt: at(33), finishedAt: at(59) },
      { key: "b", title: "B", kind: "ai", state: "running", history: [{ at: at(59), kind: "attempt" }] },
    ];
    expect(workMs({ steps }, Date.parse(at(60)))).toBe(6 * 60_000);
  });
});

describe("who approves", () => {
  const editor = { type: "user", id: "ed", teamIds: [], departmentId: null, grants: [{ permission: "task.edit", scope: "WORKSPACE" }] } as Principal;
  const lan = { type: "user", id: "lan", teamIds: [], departmentId: null, grants: [] } as Principal;
  const t = { owner_id: "minh", assignee_id: "lan", team_id: null, project_id: null };
  const run = (approver?: WorkflowStep["approver"], approverId?: string) => ({ started_by: "huy", current_step: 0, steps: [{ approver, approverId }] });

  it("anyone who may edit the task, unless the step names someone", () => {
    expect(canApprove(editor, run(), t)).toBe(true);
    expect(canApprove(lan, run(), t)).toBe(false);
    expect(canApprove(lan, run("assignee"), t)).toBe(true);
    expect(canApprove(editor, run("assignee"), t)).toBe(false);
    expect(canApprove({ ...lan, id: "minh" }, run("owner"), t)).toBe(true);
    expect(canApprove({ ...lan, id: "huy" }, run("starter"), t)).toBe(true);
    expect(canApprove(lan, run("person", "lan"), t)).toBe(true);
    expect(canApprove(editor, run("person", "lan"), t)).toBe(false);
  });

  it("falls back to the editors when the step names someone the task does not have", () => {
    expect(canApprove(editor, run("assignee"), { ...t, assignee_id: null })).toBe(true);
  });
});

describe("a command and the answers given at Run", () => {
  it("hands each answer over as a variable; none becomes text of the command", async () => {
    const { commandWithInputs } = await import("./workflows/render.js");
    const r = commandWithInputs('python report.py --who "{{input.who}}" --q {{ input.quarter-no }}', { who: "Lan; rm -rf /", "quarter-no": "3" });
    expect(r.command).toBe('python report.py --who "${INPUT_WHO}" --q "${INPUT_QUARTER_NO}"');
    expect(r.env).toEqual({ INPUT_WHO: "Lan; rm -rf /", INPUT_QUARTER_NO: "3" });
    // Inside single quotes nothing expands: the quote is closed around the reference. An escaped quote does not count.
    expect(commandWithInputs("echo 'city: {{input.city}}!' \\\" {{input.city}}", { city: "x" }).command).toBe(`echo 'city: '"\${INPUT_CITY}"'!' \\" "\${INPUT_CITY}"`);
  });
});
