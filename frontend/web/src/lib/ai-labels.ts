import type { T } from "@/lib/i18n/core";

/** Labels for AI activity values that come from the server (unknown values fall back to "other"). */
const TOPICS = ["code", "writing", "analysis", "translation", "research", "sales", "hr", "design", "planning", "other"] as const;
const SOURCES = [
  "company",
  "chatgpt",
  "claude",
  "gemini",
  "copilot",
  "perplexity",
  "deepseek",
  "grok",
  "meta",
  "poe",
  "qwen",
  "kimi",
  "doubao",
  "you",
  "huggingchat",
  "zai",
  "duckai",
  "local",
  "import",
  "other",
] as const;
const SENSITIVE = ["personal_id", "card", "secret", "contacts", "bank_account", "keyword"] as const;

const pick = <V extends string>(list: readonly V[], v: string, fallback: V): V => ((list as readonly string[]).includes(v) ? (v as V) : fallback);

/** `custom`: the company's labels (Admin › AI › Chủ đề) by key, already in the reader's language. */
export const topicLabel = (t: T, v: string, custom?: Record<string, string>) => custom?.[v] || t(`aiw.topic.${pick(TOPICS, v, "other")}`);

/** The company's topic labels for the reader's language, from GET ai/insights/topics. */
export function topicLabels(topics: { key: string; labelVi: string; labelEn: string }[], locale: string): Record<string, string> {
  return Object.fromEntries(topics.map((x) => [x.key, (locale === "vi" ? x.labelVi || x.labelEn : x.labelEn || x.labelVi) || ""]).filter(([, l]) => l));
}
export const sourceLabel = (t: T, v: string) => t(`aiw.source.${pick(SOURCES, v, "other")}`);
export const sensitiveLabel = (t: T, v: string) => t(`aiw.sensitive.${pick(SENSITIVE, v, "secret")}`);

/** What a company-AI call was for (ai_usage.feature); unknown features show their raw name. */
const FEATURES = (tx: T): Record<string, string> => ({
  catchup: tx("aiw.feature.catchup"),
  brief: tx("aiw.feature.brief"),
  summarize: tx("aiw.feature.summarize"),
  ask: tx("aiw.feature.ask"),
  agent: "Agent",
  extract_meeting: tx("aiw.feature.extract_meeting"),
  extract_document: tx("aiw.feature.extract_document"),
  task_summarize: tx("aiw.feature.task_summarize"),
  task_subtasks: tx("aiw.feature.task_subtasks"),
  task_description: tx("aiw.feature.task_description"),
  task_priority: tx("aiw.feature.task_priority"),
  task_assignee: tx("aiw.feature.task_assignee"),
  task_update: tx("aiw.feature.task_update"),
  task_write: tx("aiw.feature.task_write"),
  doc_summarize: tx("aiw.feature.doc_summarize"),
  doc_ask: tx("aiw.feature.doc_ask"),
  doc_actions: tx("aiw.feature.doc_actions"),
  doc_changes: tx("aiw.feature.doc_changes"),
  doc_draft: tx("aiw.feature.doc_draft"),
  translate: tx("aiw.feature.translate"),
  assistant: tx("aiw.feature.assistant"),
  ai_activity_summary: tx("aiw.feature.ai_activity_summary"),
  thread_summary: tx("aiw.feature.thread_summary"),
  task_chat: tx("aiw.feature.task_chat"),
  workflow_step: tx("aiw.feature.workflow_step"),
  ai_topics: tx("aiw.feature.ai_topics"),
  progress_brief: tx("aiw.feature.progress_brief"),
  task_propose: tx("aiw.feature.task_propose"),
  adoption_ideas: tx("aiw.feature.adoption_ideas"),
});
/** A feature this list does not know yet still reads as words ("meeting_notes" → "Meeting notes"), never a code. */
const humanize = (v: string) => {
  const w = v.replace(/[_.-]+/g, " ").trim();
  return w ? w[0]!.toUpperCase() + w.slice(1) : v;
};
export const featureLabel = (t: T, v: string) => FEATURES(t)[v] ?? (v.startsWith("agent") ? "Agent" : humanize(v));
