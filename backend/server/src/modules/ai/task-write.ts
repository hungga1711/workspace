import { Body, Controller, HttpCode, HttpException, Inject, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { assertAllowed, kv, logger, parse, requirePrincipal } from "@workspace/service-kit";
import { DEPS } from "./ai.controller.js";
import { guardAi } from "./budgets.js";
import { detectLang, type Lang } from "./local-model.js";
import { meteredGenerate, parseJson, SYSTEM_RULES, untrusted, type Deps, type Subject } from "./runtime.js";

/**
 * "AI viết giúp" on a task: drafts a task's description from its title, or rewrites the title and
 * description the person has in front of them (the task page, its peek, the new-task window). The text comes from
 * the page, since it may not be saved yet; for an existing task the caller must be able to open it (read through the
 * work module AS them), and the use is metered on that task as feature `task_write`. Nothing is written here: the
 * page shows the proposal next to the current text and applies it through the normal task PATCH.
 * docs/architecture/task-ai-write.md.
 */

export const WRITE_MODES = ["draft", "improve", "shorter", "longer", "criteria", "checklist", "custom"] as const;
export type WriteMode = (typeof WRITE_MODES)[number];

/** Characters of description the model reads; the rest is cut (and the answer says so). */
export const MAX_INPUT = 12000;
/** Calls per person per minute: a burst of Regenerate clicks, not a loop. */
const PER_MINUTE = 20;

const SECTIONS: Record<Lang, { goal: string; todo: string; done: string; notes: string }> = {
  vi: { goal: "Mục tiêu", todo: "Việc cần làm", done: "Tiêu chí hoàn thành", notes: "Ghi chú / Rủi ro" },
  en: { goal: "Goal", todo: "To do", done: "Done when", notes: "Notes / Risks" },
};

/** The structured skeleton the draft follows (the page's non-AI "Mẫu mô tả" inserts the same headings). */
export const sectionsFor = (lang: Lang) => SECTIONS[lang];

export interface WriteInput {
  mode: WriteMode;
  title: string;
  description: string;
  instruction?: string | undefined;
  /** The project's name and a short excerpt of its description, when the task has one the caller can read. */
  project?: { name: string; description?: string } | null;
  labels?: string[];
  subtasks?: string[];
  /** Titles of related documents and similar finished tasks, best effort. */
  related?: string[];
}

/** The language to write in: the text's own when it shows one, else the reader's interface language. */
export function writeLanguage(title: string, description: string, uiLang: Lang): Lang {
  return detectLang(`${title}\n${description}`.slice(0, 2000)) ?? uiLang;
}

/**
 * Mentions are stored as <@id>: the model sees numbered placeholders (never ids it could copy or change) and the
 * answer gets the real mentions back; a placeholder the model made up is dropped.
 */
export function maskMentions(text: string): { text: string; ids: string[] } {
  const ids: string[] = [];
  const out = text.replace(/<@((?:agent:)?[\w-]{1,64})>/g, (_m, id: string) => {
    let i = ids.indexOf(id);
    if (i < 0) i = ids.push(id) - 1;
    return `@P${i + 1}`;
  });
  return { text: out, ids };
}
export function unmaskMentions(text: string, ids: string[]): string {
  return text
    .replace(/@P(\d{1,3})\b/g, (_m, n: string) => {
      const id = ids[Number(n) - 1];
      return id ? `<@${id}>` : "";
    })
    .replace(/(\S) {2,}(?=\S)/g, "$1 ");
}

const TASKS: Record<WriteMode, (s: (typeof SECTIONS)[Lang]) => string> = {
  draft: (s) =>
    `Write the task's description from its title (and any notes already in the description). Use exactly these Markdown sections: "## ${s.goal}" (1-2 sentences), "## ${s.todo}" (3-7 checklist items "- [ ] …", verb first), "## ${s.done}" (2-4 checklist items "- [ ] …", each one checkable), "## ${s.notes}" (only real risks or open questions; leave the section out if there are none). Keep anything already written in the description. Return the title unchanged.`,
  improve: (s) =>
    `Improve the title and the description. Title: clear, action first (start with a verb), under 80 characters, no trailing period. Description: same facts, clearer and better structured (short paragraphs, lists, checklists for steps; the sections "${s.goal}", "${s.todo}", "${s.done}" when they fit), fix spelling and grammar. Keep every fact, name, link, image and checklist state ([x] stays [x]).`,
  shorter: () => `Make the description shorter and tighter: keep every fact, step, link and checklist state, drop repetition and filler. Return the title unchanged.`,
  longer: (s) =>
    `Make the description more detailed: spell out the steps as a checklist and what "done" means ("## ${s.done}"), using only what the title and description imply. Keep everything already written. Return the title unchanged.`,
  criteria: (s) =>
    `Add a "## ${s.done}" section with 2-5 checkable items ("- [ ] …") to the end of the description (or complete the one that exists). Keep the rest of the description exactly as it is. Return the title unchanged.`,
  checklist: () =>
    `Turn the steps in the description into a Markdown checklist ("- [ ] …", one action per line, verb first; keep [x] for steps already done). Keep any context sentences above the list. Return the title unchanged.`,
  custom: (s) =>
    `Rewrite the title and/or the description as the person asks in <request>. Use the sections "${s.goal}", "${s.todo}", "${s.done}" only if the request calls for structure. Change the title only if the request is about it; otherwise return it unchanged.`,
};

/** The system and user messages for one call. Pure: unit-tested in task-write.test.ts. */
export function buildWritePrompt(input: WriteInput, lang: Lang): { system: string; user: string; truncated: boolean; mentions: string[] } {
  const s = SECTIONS[lang];
  const masked = maskMentions(input.description);
  const truncated = masked.text.length > MAX_INPUT;
  const description = truncated ? masked.text.slice(0, MAX_INPUT) : masked.text;
  const system = `${SYSTEM_RULES}
TASK_WRITE:${input.mode}
You help a person write a task in their company's work app. ${TASKS[input.mode](s)}
Rules:
- Write in ${lang === "en" ? "English" : "Vietnamese"} only (no words or characters from other languages).
- Never invent facts: no dates, deadlines, people, numbers, amounts, links or names that are not in the input. If something is unknown, leave it out.
${masked.ids.length ? "- Keep @P1, @P2… exactly as written: they are people. Do not add other @P names.\n" : "- Do not mention or @-tag people; nobody is named in the input.\n"}- The description is Markdown (headings "##", lists, "- [ ]" checklists). No HTML, no code fences around the whole text.
Return ONLY JSON: {"title": string, "description": string}.`;
  const context = {
    ...(input.project ? { project: input.project.name, projectAbout: (input.project.description ?? "").slice(0, 500) || undefined } : {}),
    ...(input.labels?.length ? { labels: input.labels.slice(0, 20) } : {}),
    ...(input.subtasks?.length ? { subtasks: input.subtasks.slice(0, 20) } : {}),
    ...(input.related?.length ? { related: input.related.slice(0, 8) } : {}),
  };
  const parts = [
    Object.keys(context).length ? `<context>${JSON.stringify(context).replaceAll("<", "‹")}</context>` : "",
    untrusted(`TITLE: ${input.title.trim() || "(none)"}\n\nDESCRIPTION:\n${description.trim() || "(empty)"}${truncated ? "\n…(cut)" : ""}`),
    input.mode === "custom" && input.instruction ? `<request>${input.instruction.replaceAll("<", "‹")}</request>` : "",
  ];
  return { system, user: parts.filter(Boolean).join("\n"), truncated, mentions: masked.ids };
}

/** Strips what models wrap text in: a fence around the whole answer, quotes around a title. */
const unfence = (t: string) => t.replace(/^\s*```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i, "$1");
export const cleanTitle = (t: string) =>
  t
    .replace(/[\r\n]+/g, " ")
    .replace(/^\s*#+\s*/, "")
    .replace(/^\s*["'“”«]+|["'“”»]+\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.$/, "")
    .slice(0, 300);

/**
 * The proposal from the model's text: JSON first; a plain Markdown answer counts as the description. The title is
 * only proposed when it differs from the current one (and only by modes allowed to touch it). Null when unusable.
 */
export function parseWriteOutput(
  text: string,
  mode: WriteMode,
  current: { title: string; description: string },
  mentions: string[],
): { title?: string; description: string } | null {
  const x = parseJson<{ title?: unknown; description?: unknown }>(text);
  let description: string;
  let title: string | undefined;
  if (x && (typeof x.description === "string" || typeof x.title === "string")) {
    description = typeof x.description === "string" ? x.description : current.description;
    title = typeof x.title === "string" ? x.title : undefined;
  } else {
    const raw = unfence(text).trim();
    if (!raw || raw.startsWith("{")) return null;
    description = raw;
  }
  description = unmaskMentions(unfence(description).replace(/\r\n/g, "\n").trim(), mentions).slice(0, 20000);
  const titleOk = mode === "improve" || mode === "custom";
  const t = title !== undefined && titleOk ? cleanTitle(unmaskMentions(title, mentions)) : "";
  if (!description && !t) return null;
  return { ...(t && t !== current.title.trim() ? { title: t } : {}), description: description || current.description };
}

/**
 * What the answer states that the input did not: numbers with two or more digits, dates and times, links and
 * mentions. The page shows them so the person checks before applying (the prompt forbids them; models slip).
 */
export function addedFacts(input: string, output: string): string[] {
  const facts = (t: string) => new Set(t.match(/https?:\/\/[^\s)>\]]+|<@[\w:-]+>|\d+(?:[.,:/-]\d+)+|\d{2,}/g) ?? []);
  const had = facts(input);
  return [...facts(output)].filter((f) => !had.has(f)).slice(0, 10);
}

@Controller()
export class TaskWriteController {
  constructor(@Inject(DEPS) private readonly d: Deps) {}

  @Post("tasks/write")
  @HttpCode(200)
  async write(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "ai.use");
    const b = parse(
      z.object({
        mode: z.enum(WRITE_MODES),
        title: z.string().max(300).default(""),
        description: z.string().max(20000).default(""),
        /** The task being edited (id or code), when it exists: read access is checked and the use counts on it. */
        taskRef: z.string().min(1).max(40).optional(),
        /** The new-task window's project, for context. */
        projectId: z.string().min(10).max(40).nullish(),
        labels: z.array(z.string().max(60)).max(20).default([]),
        instruction: z.string().trim().max(500).optional(),
      }),
      body,
    );
    if (!b.title.trim() && !b.description.trim()) throw new HttpException({ error: "empty", message: "write a title first" }, 400);
    if (b.mode === "custom" && !b.instruction) throw new HttpException({ error: "instruction_required" }, 400);
    if (kv().incr(`ai:task-write:${p.id}`, 60_000) > PER_MINUTE) throw new HttpException({ error: "rate_limited" }, 429);
    const uiLang: Lang = req.headers["x-locale"] === "vi" ? "vi" : "en";
    return guardAi(async () => {
      const work = this.d.services.work;
      let subject: Subject | null = null;
      let projectId = b.projectId ?? null;
      let subtasks: string[] = [];
      let related: string[] = [];
      if (b.taskRef) {
        // 403/404 from the work module become 404 (guardAi): the caller cannot write about a task they cannot open.
        const t = await work.request<{ task: { id: string; projectId?: string | null }; subtasks?: { title: string }[] }>(
          "GET",
          `/tasks/${encodeURIComponent(b.taskRef)}`,
          undefined,
          p,
        );
        subject = { type: "task", id: t.task.id };
        projectId = t.task.projectId ?? projectId;
        subtasks = (t.subtasks ?? []).map((x) => x.title);
        // A draft benefits from what the workspace already knows about this kind of work; best effort and quick.
        if (b.mode === "draft") {
          const rel = await Promise.race([
            work.request<{ docs?: { title: string }[]; similar?: { title: string }[] }>("GET", `/tasks/${t.task.id}/related`, undefined, p).catch(() => null),
            new Promise<null>((r) => setTimeout(() => r(null), 2500).unref()),
          ]);
          related = [...(rel?.docs ?? []).slice(0, 4), ...(rel?.similar ?? []).slice(0, 4)].map((x) => x.title);
        }
      }
      const project = projectId
        ? await work.request<{ name: string; description?: string }>("GET", `/projects/${encodeURIComponent(projectId)}`, undefined, p).catch(() => null)
        : null;
      const lang = writeLanguage(b.title, b.description, uiLang);
      const prompt = buildWritePrompt({ ...b, project, subtasks, related }, lang);
      const r = await meteredGenerate(
        this.d,
        { principal: p, agentId: null, feature: "task_write", subject },
        { tier: "fast", system: prompt.system, maxTokens: 1800, messages: [{ role: "user", content: prompt.user }] },
      );
      // The built-in extractive model cannot write: say so rather than offer its notice as a description.
      if (r.model.startsWith("local")) throw new HttpException({ error: "ai_unavailable" }, 503);
      const out = parseWriteOutput(r.text, b.mode, b, prompt.mentions);
      if (!out) {
        logger.warn({ mode: b.mode }, "task write: malformed model output");
        throw new HttpException({ error: "ai_malformed_output" }, 502);
      }
      // What the model was given counts as known: the project's own text and related titles are sources, not inventions.
      const input = [b.title, b.description, project?.name, project?.description?.slice(0, 500), ...b.labels, ...subtasks, ...related, b.instruction].filter(Boolean).join("\n");
      return { ...out, language: lang, truncated: prompt.truncated, added: addedFacts(input, `${out.title ?? ""}\n${out.description}`) };
    });
  }
}
