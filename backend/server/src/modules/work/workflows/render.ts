import type { InputField, WorkflowStep } from "./model.js";

/**
 * How a step's instruction is put together, for both runners (the server asks the company's AI with it; a runner hands
 * the same text to its agent). Pure: no database, unit-tested in render.test.ts.
 *
 *   {{task}}          the task (code, title, description), what was filled in when the run started, its workspace context
 *   {{previous}}      the last result made before the step, then any approver notes given since
 *   {{steps.<key>}}   the result of that earlier step
 *   {{input.<key>}}   one value filled in when the run started; {{inputs}} all of them
 *   {{resources}}     the workflow's reference material (added before the instruction when the prompt does not place it)
 *   {{answers}}       people's answers to the step's questions (agent-ask.ts composePrompt)
 */

/** A small local model given 20k characters takes minutes for one step: results are passed on capped. */
export const PREVIOUS_MAX = 8000;
/** How much of the task's description {{task}} carries. */
export const DESCRIPTION_MAX = 4000;
/** The reference block's budget in characters (about 5k tokens): the playbook whole, the rest shared between the sources. */
export const RESOURCES_MAX = 20_000;

export interface RunStepLike extends WorkflowStep {
  output?: string | undefined;
}

export interface PromptParts {
  task: { code: string; title: string; description: string | null };
  /** The task's workspace context (workflow-context.ts), "" when the workflow leaves it out. */
  context: string;
  /** The run's steps so far; `index` is the step being rendered. */
  steps: RunStepLike[];
  index: number;
  fields: InputField[];
  inputs: Record<string, string>;
  /** The reference block as read for this run ("" when there is none or the step leaves it out). */
  resources: string;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…` : s);

/** A step makes a result later steps read: an AI step's answer, a command's output. An approval or a check does not. */
export const makesResult = (s: Pick<WorkflowStep, "kind">) => s.kind === "ai" || s.kind === "command";

/** The last result made before step `index`. */
export function lastResult(steps: RunStepLike[], index: number): { text: string; from: number } | null {
  for (let i = Math.min(index, steps.length) - 1; i >= 0; i--) if (makesResult(steps[i]!) && steps[i]!.output) return { text: steps[i]!.output!, from: i };
  return null;
}

/**
 * What {{previous}} is: the last result, then any note an approver gave since, so the next step works from both.
 */
export function previousText(steps: RunStepLike[], index: number): string {
  const last = lastResult(steps, index);
  const notes = steps
    .slice(last ? last.from + 1 : 0, index)
    .filter((s) => s.kind === "approval" && s.output)
    .map((s) => s.output!);
  const out = last?.text ?? "";
  return notes.length ? `${out}\n\nNote from the approver:\n${notes.join("\n")}`.trim() : out;
}

/** What was filled in when the run started, as lines the model reads; "" without values. */
export function inputsText(fields: InputField[], inputs: Record<string, string>): string {
  const lines = fields.filter((f) => inputs[f.key]).map((f) => `- ${f.label}: ${inputs[f.key]}`);
  return lines.length ? lines.join("\n") : "";
}

/**
 * A command with the answers given at Run. An answer never becomes part of the command's text (it would be run as
 * shell): each is handed over as an environment variable INPUT_<KEY>, and {{input.key}} in the command becomes a
 * reference to it, quoted for where it stands (bare: "${X}", so a space or a * stays one word; inside double quotes:
 * ${X}; inside single quotes, where nothing expands: the quote is closed around "${X}").
 */
export function commandWithInputs(command: string, inputs: Record<string, string>): { command: string; env: Record<string, string> } {
  const name = (key: string) => `INPUT_${key.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}`;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(inputs)) env[name(k)] = String(v ?? "").slice(0, 8000);
  const re = /\{\{\s*input\.([a-zA-Z0-9_-]+)\s*\}\}/y;
  let out = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length;) {
    re.lastIndex = i;
    const m = re.exec(command);
    if (m) {
      const ref = `\${${name(m[1]!)}}`;
      out += quote === '"' ? ref : quote === "'" ? `'"${ref}"'` : `"${ref}"`;
      i = re.lastIndex;
      continue;
    }
    const ch = command[i]!;
    if (ch === "\\" && quote !== "'") {
      out += command.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') quote = quote === ch ? null : (quote ?? ch);
    out += ch;
    i++;
  }
  return { command: out, env };
}

const PLACEHOLDER = /\{\{\s*([a-zA-Z_]+(?:\.[a-zA-Z0-9_-]+)?)\s*\}\}/g;

/** Every placeholder a prompt uses, as written without the braces ("task", "steps.plan", "input.audience"). */
export function placeholdersIn(prompt: string): string[] {
  return [...new Set([...(prompt ?? "").matchAll(PLACEHOLDER)].map((m) => m[1]!))];
}

/**
 * The step's instruction with its placeholders filled in. A placeholder the engine does not know stays as written
 * (the editor's analysis points it out). The reference block goes first when the prompt does not place it.
 */
export function renderPrompt(prompt: string, x: PromptParts): string {
  const used = placeholdersIn(prompt);
  const placesInputs = used.some((u) => u === "inputs" || u.startsWith("input."));
  const given = inputsText(x.fields, x.inputs);
  const task = [
    `${x.task.code} · ${x.task.title}`,
    (x.task.description || "").slice(0, DESCRIPTION_MAX).trim(),
    // Inputs travel with the task unless the prompt places them itself, so a workflow's form never goes unread.
    !placesInputs && given ? `Details given when this run was started:\n${given}` : "",
    x.context,
  ]
    .filter(Boolean)
    .join("\n\n");
  const body = prompt.replace(PLACEHOLDER, (whole, name: string) => {
    if (name === "task") return task;
    if (name === "previous") return clip(previousText(x.steps, x.index) || "—", PREVIOUS_MAX);
    if (name === "inputs") return given || "—";
    if (name === "resources") return x.resources || "—";
    if (name === "answers") return whole; // composePrompt fills it.
    if (name.startsWith("input.")) return x.inputs[name.slice(6)] || "—";
    if (name.startsWith("steps.")) {
      const key = name.slice(6);
      const at = x.steps.findIndex((s) => s.key === key);
      return at >= 0 && at < x.index && x.steps[at]!.output ? clip(x.steps[at]!.output!, PREVIOUS_MAX) : "—";
    }
    return whole;
  });
  // An instruction that places nothing to work on (no task, no earlier result) gets the task after it: someone who
  // only writes "Draft a reply to the customer" means the task's customer, and should not need a placeholder to say so.
  const grounded = used.some((u) => u === "task" || u === "previous" || u.startsWith("steps."));
  const whole = grounded ? body : `${body.trimEnd()}\n\n${task}`;
  return x.resources && !used.includes("resources") ? `${referenceBlock(x.resources)}\n\n${whole}` : whole;
}

export const referenceBlock = (text: string) =>
  `Reference material from the company. Use it; where it speaks, it outranks your own assumptions.\n<reference>\n${text}\n</reference>`;

/**
 * What a step sent back for changes is told on its next run: the request (an approver's, or a failed check's issues),
 * then the result it replaces.
 */
export function reworkText(rework: { note: string; previous: string; check?: string | undefined } | undefined): string {
  if (!rework) return "";
  const who = rework.check
    ? `An automatic check ("${rework.check}") did not pass on your previous result. Fix every issue it lists`
    : "The approver sent your previous result back. Apply their request";
  return `${who} and return the full revised result, not a list of changes.\n\n${rework.check ? "Issues" : "Their request"}:\n${rework.note}\n\nYour previous result:\n${rework.previous}`;
}

// ── Checks ───────────────────────────────────────────────────────────────────────────────────────────

export const CHECK_HINT = [
  "Reply with only this block:",
  "```workspace-check",
  '{"pass": <true or false>, "issues": ["<what does not meet a requirement, and where>"]}',
  "```",
  '"pass" is true only when every requirement is met. With "pass": false, list each unmet requirement as one short, specific issue the author can fix (at most 6), in the language of the result. Judge only what is written; do not rewrite the result.',
].join("\n");

/**
 * The judge's instruction: the requirements, the result under review, the task it was made for and, when the workflow
 * has reference material, that too (so a requirement can be "every price is in the price list").
 */
export function checkPrompt(criteria: string, result: string, from: string, task: string, resources = ""): string {
  return [
    "Check the result below against the requirements. You are the reviewer, not the author.",
    `Requirements:\n${criteria.trim()}`,
    `Result under review (made by the step "${from}"):\n<result>\n${clip(result, PREVIOUS_MAX)}\n</result>`,
    `The task it was made for:\n${task}`,
    resources ? referenceBlock(resources) : "",
    CHECK_HINT,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export interface Verdict {
  pass: boolean;
  issues: string[];
}

const CHECK_BLOCK = /```[ \t]*workspace-check[^\n]*\n([\s\S]*?)(?:```|$)/i;
const ANY_FENCE = /^```(?:json)?[ \t]*\n([\s\S]*?)\n```$/i;

function tryJson(s: string): unknown {
  for (const text of [s, s.replace(/,\s*([}\]])/g, "$1")]) {
    try {
      return JSON.parse(text);
    } catch {
      // The next form, then give up.
    }
  }
  return undefined;
}

/**
 * The verdict a judge's answer gives, or null when it cannot be read (the check then runs again; never a silent pass).
 * Accepts the `workspace-check` block, a bare or fenced JSON object with "pass", and a first line that is PASS or FAIL.
 */
export function parseVerdict(output: string): Verdict | null {
  const text = (output ?? "").trim();
  if (!text) return null;
  const inner = CHECK_BLOCK.exec(text)?.[1] ?? ANY_FENCE.exec(text)?.[1] ?? text;
  const start = inner.indexOf("{");
  const end = inner.lastIndexOf("}");
  const json = start >= 0 && end > start ? tryJson(inner.slice(start, end + 1)) : undefined;
  if (json && typeof json === "object" && !Array.isArray(json)) {
    const o = json as Record<string, unknown>;
    const raw = o.pass ?? o.passed ?? o.ok;
    const pass = raw === true || raw === "true" ? true : raw === false || raw === "false" ? false : null;
    if (pass !== null) {
      const issues = (Array.isArray(o.issues) ? o.issues : [])
        .map((i) => (typeof i === "string" ? i : i && typeof i === "object" ? String((i as Record<string, unknown>).issue ?? (i as Record<string, unknown>).text ?? "") : ""))
        .map((i) => i.replace(/\s+/g, " ").trim().slice(0, 500))
        .filter((i) => i && !/^<[^>]*>$/.test(i))
        .slice(0, 6);
      // A fail without a reason gives the author nothing to fix: it still fails, with a generic issue.
      return { pass, issues: pass ? [] : issues.length ? issues : ["The check did not pass and gave no reason."] };
    }
  }
  const first = text.split("\n")[0]!.trim();
  if (/^pass(ed)?\b/i.test(first)) return { pass: true, issues: [] };
  if (/^fail(ed)?\b/i.test(first))
    return {
      pass: false,
      issues: text
        .split("\n")
        .slice(1)
        .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
        .filter(Boolean)
        .slice(0, 6)
        .concat([])
        .map((l) => l.slice(0, 500)),
    };
  return null;
}

/** A failed command check's issues: the end of its output, where a test runner says what broke. */
export function commandIssues(output: string, exitCode: number | undefined): string {
  const tail = (output ?? "").trim().slice(-3000);
  return `The command exited with ${exitCode ?? "an error"}.${tail ? `\n\n${tail}` : ""}`;
}

/** The issues as the author reads them. */
export const issuesText = (issues: string[]) => issues.map((i) => `- ${i}`).join("\n");

// ── Results ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * A result the model wrapped whole in a ```markdown fence (small models do, seen live): the text inside, so the task
 * comment and the approver see the document rendered, not a code block. Any other result is left as it is.
 */
export function unfence(text: string): string {
  const m = /^```(?:markdown|md)?[ \t]*\n([\s\S]*?)\n```[ \t]*$/i.exec(text.trim());
  return m && !m[1]!.includes("\n```") ? m[1]!.trim() : text;
}

/** Open checklist lines of a result ("- [ ] Title"), as subtask titles: trimmed of trailing owner/size notes. */
export function checklistItems(text: string, max = 20): string[] {
  const out: string[] = [];
  for (const line of (text ?? "").split("\n")) {
    const m = /^\s*(?:[-*]|\d+[.)])\s*\[ \]\s+(.+)$/.exec(line);
    if (!m) continue;
    const title = m[1]!
      .replace(/\*\*|__|`/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200);
    if (title && !out.includes(title)) out.push(title);
    if (out.length >= max) break;
  }
  return out;
}

/** A page title from a result: its first heading, else the workflow's name with the task's code. */
export function resultTitle(text: string, fallback: string): string {
  const m = /^\s{0,3}#{1,3}\s+(.+)$/m.exec(text ?? "");
  const t = (m?.[1] ?? "").replace(/[*_`#]/g, "").trim();
  return (t || fallback).slice(0, 200);
}

/**
 * The note that tells an agent on a runner where its files are. The runner replaces {{assets_dir}} and {{out_dir}}
 * with the real folders (a sandbox's ../assets and ../out, a temp folder on a person's computer).
 */
export function runnerNote(o: { assets: boolean; out: boolean }): string {
  return [
    o.assets ? "Reference files for this run are in the folder {{assets_dir}} (read them; do not change them)." : "",
    o.out ? "Write every file you want to hand back (reports, charts, exports) into the folder {{out_dir}}; they are attached to the task when the run ends." : "",
  ]
    .filter(Boolean)
    .join("\n");
}
