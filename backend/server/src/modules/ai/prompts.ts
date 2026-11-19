import { SYSTEM_RULES, untrusted } from "./runtime.js";

/*
 * Prompts shared by the controllers and the eval suite (evals/run.ts), so evals exercise exactly
 * what production sends.
 */

export const EXTRACT_SYSTEM = `${SYSTEM_RULES}
Return ONLY JSON: {"summary": string, "actions": [{"title": string, "assigneeId": string|null, "due": string|null}], "decisions": [{"title": string}]}.
actions are concrete follow-ups someone must do; decisions are things the group agreed on. Use user ids from the transcript for assigneeId.`;

export const threadUser = (lang: string, content: string) => `Summarize this thread in ${lang}.\n${untrusted(content)}`;

export const extractUser = (kind: "meeting" | "document" | "task", title: string, lang: string, text: string) => {
  const what = kind === "meeting" ? "meeting minutes" : kind === "document" ? "document" : "task description";
  return `Summarize these ${what}${title ? ` titled "${title}"` : ""} in ${lang} and list action items and decisions.\n${untrusted(text)}`;
};

/** Daily Brief sentence, grounded in the same items Home shows. */
export const briefSystem = (locale: "vi" | "en") => {
  const lang = locale === "en" ? "English" : "Vietnamese";
  return `${SYSTEM_RULES}\nReturn ONLY JSON {"recommendation": string, "digest": []}.\nrecommendation: one short sentence (max 20 words) in ${lang} telling the user what to do first today.\n- If needsYou is not empty, name the most urgent item from it by its title (overdue first, then the earliest dueAt, then priority urgent/high). Do not say there is nothing urgent.\n- If needsYou is empty but today has a meeting, mention the next one and its time.\n- If both are empty, suggest one focused piece of work in a neutral way.\nLocale: ${locale}`;
};
export const briefUser = (ctx: { needsYou: unknown[]; today: unknown[] }) => `<context>${JSON.stringify(ctx)}</context>`;

/** Task and document assist (assist.ts): one JSON shape per action, written in the reader's language. */
export const assistSystem = (lang: string, marker: string, shape: string, extra = "") =>
  `${SYSTEM_RULES}\nASSIST:${marker}\nReturn ONLY JSON of this shape: ${shape}.${extra ? `\n${extra}` : ""}\nWrite in ${lang} (the reader's interface language).`;
