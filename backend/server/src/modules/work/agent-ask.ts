/**
 * Agent questions (docs/architecture/agent-questions.md): an AI step that lacks something essential asks
 * the people on the task instead of guessing, like a coding agent asking before it acts. One protocol for both
 * runners: the step's instruction ends with ASK_HINT, the model (the company's AI, or a coding agent on the
 * assignee's computer) replies with a fenced `workspace-ask` block and stops, and the server reads that block from
 * the step's output (parseAsk). The answers go back into the same step's instruction (composePrompt) and it runs
 * again. Pure functions, no database: unit-tested in agent-ask.test.ts.
 */

export interface AskQuestion {
  id: string;
  text: string;
  kind: "text" | "choice";
  options?: string[] | undefined;
  required?: boolean | undefined;
  /** The model's best guess from the task's context, prefilled in the form so a person only corrects it. */
  default?: string | undefined;
}
/** One round of questions on a step, as composePrompt needs it. */
export interface AskRound {
  /** The step that asked (task_agent_run_questions.step_index). */
  step?: number | undefined;
  questions: AskQuestion[];
  answers: Record<string, string> | null;
  outcome: "answered" | "skipped" | "cancelled" | null;
}

/**
 * Rounds of questions: any AI step may ask, and ask again after the
 * answers when they raise something new, up to MAX_STEP_ROUNDS on one step and MAX_RUN_ROUNDS in the whole run, so a
 * run never waits on people without end. One round holds several questions, with options per choice question.
 */
export const MAX_STEP_ROUNDS = 3;
export const MAX_RUN_ROUNDS = 6;
export const MAX_QUESTIONS = 5;
const MAX_OPTIONS = 6;

export const ASK_HINT = [
  "If something essential to this step is unclear and you cannot make a reasonable assumption, do not guess. Instead reply with only this block and stop:",
  "```workspace-ask",
  // Placeholders, not sample questions: a model given concrete examples asks them back word for word (seen live).
  '{"questions": [{"text": "<your question>", "options": ["<answer A>", "<answer B>"], "default": "<answer A>"}, {"text": "<another question>", "default": "<your best guess>"}]}',
  "```",
  `At most ${MAX_QUESTIONS} short questions, in the language of the task, all at once. Ask again after the answers only about something new they raise. First use the context above and the answers so far; never ask what they already say. Give "options" when the possible answers are known, and "default" with your best guess from the context, so people only correct it. The people on the task answer, then this step runs again with their answers. Ask only when it matters; otherwise do the step.`,
].join("\n");
export const DECIDE_HINT = "Do not ask any more questions: where something is still unclear, make a reasonable assumption, say which, and do the step.";

const clip = (s: unknown, n: number) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, n) : "");

/** Normalizes whatever the model wrote for its questions; null when nothing usable is left. */
export function normalizeQuestions(raw: unknown): AskQuestion[] | null {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? ((raw as Record<string, unknown>).questions ?? (raw as Record<string, unknown>).ask ?? (raw as Record<string, unknown>).workspace_ask)
      : null;
  if (!Array.isArray(list)) return null;
  const out: AskQuestion[] = [];
  for (const item of list) {
    if (out.length >= MAX_QUESTIONS) break;
    const o = typeof item === "string" ? { text: item } : item && typeof item === "object" ? (item as Record<string, unknown>) : null;
    if (!o) continue;
    const text = clip(o.text ?? o.question ?? o.q, 500);
    // The hint's placeholders copied back are not questions.
    if (!text || /^<[^>]*>$/.test(text)) continue;
    const opts = Array.isArray(o.options ?? o.choices) ? ((o.options ?? o.choices) as unknown[]) : [];
    const options = [...new Set(opts.map((x) => clip(x, 120)).filter((x) => x && !/^<[^>]*>$/.test(x)))].slice(0, MAX_OPTIONS);
    const guess = clip(o.default ?? o.suggested ?? o.guess, 500);
    out.push({
      id: `q${out.length + 1}`,
      text,
      kind: options.length >= 2 ? "choice" : "text",
      ...(options.length >= 2 ? { options } : {}),
      ...(o.required === false ? { required: false } : {}),
      ...(guess && !/^<[^>]*>$/.test(guess) ? { default: guess } : {}),
    });
  }
  return out.length ? out : null;
}

const BLOCK = /```[ \t]*workspace-ask[^\n]*\n([\s\S]*?)(?:```|$)/i;
const JSON_FENCE = /^```(?:json)?[ \t]*\n([\s\S]*?)\n```$/i;

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    // Models often leave a trailing comma; one more try without them.
    try {
      return JSON.parse(s.replace(/,\s*([}\]])/g, "$1"));
    } catch {
      return undefined;
    }
  }
}

/**
 * The questions a step's output asks, or null when it does the work. Accepts the `workspace-ask` block (JSON, or one
 * question per line when the model forgot the JSON), and a reply that is only `{"ask": [...]}` / `{"questions": [...]}`.
 */
export function parseAsk(output: string): AskQuestion[] | null {
  const text = (output ?? "").trim();
  if (!text) return null;
  const block = BLOCK.exec(text);
  if (block) {
    const body = block[1]!.trim();
    const json = tryJson(body);
    if (json !== undefined) return normalizeQuestions(json);
    const lines = body
      .split("\n")
      .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
      .filter(Boolean);
    return normalizeQuestions(lines);
  }
  // The whole reply as JSON (bare or in a ```json fence) with an "ask"/"questions" list: never prose that mentions it.
  const inner = JSON_FENCE.exec(text)?.[1] ?? text;
  if (!inner.trimStart().startsWith("{")) return null;
  const json = tryJson(inner.trim());
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const o = json as Record<string, unknown>;
  return Array.isArray(o.ask) || Array.isArray(o.questions) ? normalizeQuestions(o) : null;
}

/** Whether a step may still ask, given its own rounds: under the step's cap, and nobody told it to decide for itself. */
export const mayAsk = (stepRounds: AskRound[]) => stepRounds.length < MAX_STEP_ROUNDS && !stepRounds.some((r) => r.outcome === "skipped");

/**
 * Whether step `index` may ask, given every round of the run (any step): the run is under its cap and the step under
 * its own. "Let the AI decide" stops that step asking, not the steps after it.
 */
export const mayAskInRun = (runRounds: AskRound[], index: number) => runRounds.length < MAX_RUN_ROUNDS && mayAsk(runRounds.filter((r) => r.step === index));

/** The earlier rounds' questions and answers as text the model reads. */
export function answersText(rounds: AskRound[]): string {
  const done = rounds.filter((r) => r.outcome === "answered" || r.outcome === "skipped");
  if (!done.length) return "";
  // "Let the AI decide" keeps what was already answered: only the gaps are the model's call.
  const parts = done.map((r) =>
    r.questions
      .map((q) => {
        const a = r.answers?.[q.id]?.trim();
        return `Q: ${q.text}\nA: ${a || (r.outcome === "skipped" ? "(not answered: decide yourself and say what you assumed)" : "(no answer: decide yourself)")}`;
      })
      .join("\n"),
  );
  return `Answers from the people on the task to your earlier questions:\n${parts.join("\n\n")}`;
}

/**
 * A step's full instruction: the rendered prompt, the answers so far (at `{{answers}}` when the workflow placed it,
 * else at the end) and how it may ask.
 */
export function composePrompt(rendered: string, rounds: AskRound[], may: boolean): string {
  const answers = answersText(rounds);
  const body = rendered.includes("{{answers}}") ? rendered.replaceAll("{{answers}}", answers || "—") : answers ? `${rendered}\n\n${answers}` : rendered;
  return `${body}\n\n${may ? ASK_HINT : DECIDE_HINT}`;
}

/** What a person sent with "Let the AI decide": the answers they had filled in, never a required-answer check. */
export function partialAnswers(questions: AskQuestion[], answers: Record<string, string> | undefined): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const q of questions) {
    const a = typeof answers?.[q.id] === "string" ? answers[q.id]!.trim().slice(0, 4000) : "";
    if (a) out[q.id] = a;
  }
  return Object.keys(out).length ? out : null;
}

/** Checks a person's answers against the round: every required question answered, choices free-form allowed. */
export function cleanAnswers(questions: AskQuestion[], answers: Record<string, string>): { ok: true; answers: Record<string, string> } | { ok: false; missing: string[] } {
  const out: Record<string, string> = {};
  const missing: string[] = [];
  for (const q of questions) {
    const a = typeof answers[q.id] === "string" ? answers[q.id]!.trim().slice(0, 4000) : "";
    if (a) out[q.id] = a;
    else if (q.required !== false) missing.push(q.id);
  }
  return missing.length ? { ok: false, missing } : { ok: true, answers: out };
}
