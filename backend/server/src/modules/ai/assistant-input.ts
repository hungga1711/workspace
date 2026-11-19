import { BadRequestException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { z } from "zod";
import { newId, type Principal } from "@workspace/shared";
import { logger, officeText } from "@workspace/service-kit";
import type { ModelImage, ModelMessage } from "./providers.js";
import { untrusted, type Deps } from "./runtime.js";
import type { BriefTaskDetail } from "./task-brief.js";
import { taskBrief } from "./task-chat.js";
import type { TraceItem } from "./mcp/chat.js";
import { executeTool, type Tool } from "./tools.js";
import { pdfAsText, readPdf } from "./office/pdf.js";
import { OfficeRefused } from "./office/guard.js";
import { READ as REPORT_READ } from "./tools-reports.js";

let reports: Map<string, Tool> | null = null;
/** The report tools by name, made on first use (the area files load after this one). */
const reportTools = () => (reports ??= new Map(REPORT_READ.map((t) => [t.name, t])));

/**
 * Hỏi đáp's extras on a question: images and files the person attached, and the work they pointed at with @ (a task,
 * document, project or meeting). Files are read here (PDF and text); the work is read from the work module as the
 * asker, so @ never shows the model anything the person could not open themselves.
 */

/** Whole request at most ~8 MB of files (the browser downscales images first); the gateway allows 12 MB of JSON. */
const MAX_BYTES = 8 * 1024 * 1024;
/** What the model reads of one file, and of all files of a question. */
const FILE_CHARS = 60_000;
const TOTAL_CHARS = 120_000;
/** What a follow-up question still carries of an earlier turn's file. */
const HISTORY_FILE_CHARS = 6_000;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const TEXT_TYPE = /^(text\/|application\/(json|xml|x-yaml|yaml|javascript|typescript|x-sh|sql|csv|x-ndjson))/;
/** The Office formats read as text; the legacy binary ones (.doc, .xls, .ppt) are not. */
const OFFICE_EXT = /\.(docx|xlsx|pptx)$/i;
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|ndjson|xml|ya?ml|html?|log|ini|toml|js|jsx|ts|tsx|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|sql|sh|css|scss|vue|svelte)$/i;

export const AttachmentInput = z.object({
  name: z.string().trim().min(1).max(200),
  contentType: z.string().max(120),
  /** Base64 of the file (an image already downscaled). */
  data: z.string().max(12_000_000),
});
/**
 * What a question points at. Besides the @ picker's kinds, the ask panel (⌘J) sends the screen the person is on
 * (`page`: true) and what they dragged in: a chat channel (with `thread`, a thread in it), a message, a person, or an
 * AI report screen (`report`, id = which one). Only ids travel; every record is read here, as the asker.
 */
export const REF_KINDS = ["task", "document", "project", "meeting", "workflow", "file", "channel", "message", "person", "report"] as const;
export const RefInput = z.object({
  kind: z.enum(REF_KINDS),
  id: z.string().min(1).max(60),
  label: z.string().trim().max(200),
  /** The screen the question was asked on (the ask panel), not something the person picked. */
  page: z.boolean().optional(),
  /** A channel ref only: the thread (its root message) the person has open. */
  thread: z.string().length(26).optional(),
});
export type Ref = z.infer<typeof RefInput>;
/** The AI report screens a page ref may name. */
const REPORTS: Record<string, string> = {
  progress: "the AI › Progress screen (who does what, progress per person and department)",
  adoption: "the AI › Adoption screen (who uses AI and how, next to the work done)",
  insights: "the AI insights screen (what staff ask AI about, spend)",
};

export interface ReadFile {
  name: string;
  contentType: string;
  size: number;
  kind: "image" | "file";
  data: Buffer | null;
  text: string;
}

/** The attachments as the model will see them; refuses a type it cannot read rather than sending it silently. */
export async function readAttachments(list: z.infer<typeof AttachmentInput>[]): Promise<ReadFile[]> {
  const out: ReadFile[] = [];
  let bytes = 0;
  let chars = 0;
  for (const a of list) {
    const buf = Buffer.from(a.data, "base64");
    bytes += buf.length;
    if (bytes > MAX_BYTES) throw new BadRequestException({ error: "files_too_large", message: "attachments are larger than 8 MB together" });
    const type = a.contentType.toLowerCase();
    if (IMAGE_TYPES.includes(type)) {
      out.push({ name: a.name, contentType: type, size: buf.length, kind: "image", data: buf, text: "" });
      continue;
    }
    let text: string;
    if (type === "application/pdf" || /\.pdf$/i.test(a.name)) text = await pdfText(buf, a.name);
    else if (OFFICE_EXT.test(a.name)) {
      // Word, Excel and PowerPoint as text (a workbook as CSV per sheet), so every model can read them.
      const office = officeText(buf, a.name);
      if (office === null) throw new BadRequestException({ error: "file_unreadable", message: `cannot read ${a.name}` });
      text = office;
    } else if (TEXT_TYPE.test(type) || TEXT_EXT.test(a.name)) text = buf.toString("utf8");
    else throw new BadRequestException({ error: "file_unsupported", message: `cannot read ${a.name}` });
    text = text.replaceAll("\u0000", "").slice(0, Math.max(0, Math.min(FILE_CHARS, TOTAL_CHARS - chars)));
    chars += text.length;
    // Office files and tables keep their bytes: the Office tools open them again (formulas, sheets, a template to fill).
    const keep = OFFICE_EXT.test(a.name) || /\.(csv|tsv|pdf)$/i.test(a.name);
    out.push({ name: a.name, contentType: type || "text/plain", size: buf.length, kind: "file", data: keep ? buf : null, text });
  }
  return out;
}

/**
 * A PDF's text with its page numbers, so answers can cite pages. A scan reads as a note telling the model to ask for
 * the pages as pictures; a password-protected file is refused with that reason.
 */
async function pdfText(buf: Buffer, name: string): Promise<string> {
  try {
    return pdfAsText(await readPdf(buf, name), name);
  } catch (e) {
    logger.warn({ err: e, name }, "assistant: unreadable pdf");
    throw new BadRequestException({ error: "file_unreadable", message: e instanceof OfficeRefused ? e.message : `cannot read ${name}` });
  }
}

/** Files as text the model reads with the question; images go beside it. */
export function filesBlock(files: { name: string; kind: string; text: string }[], cap = FILE_CHARS): string {
  return files
    .filter((f) => f.kind === "file")
    .map((f) => `Attached file "${f.name}":\n${untrusted(f.text.slice(0, cap))}`)
    .join("\n\n");
}

export const imagesOf = (files: { kind: string; contentType: string; data: Buffer | null }[]): ModelImage[] =>
  files.filter((f) => f.kind === "image" && f.data).map((f) => ({ mediaType: f.contentType, data: f.data!.toString("base64") }));

/** The text of each @-pointed record, read as the asker; one the person cannot open (or that is gone) is left out. */
export async function refsBlock(d: Deps, p: Principal, refs: Ref[], lang: "en" | "vi"): Promise<string> {
  const parts = await Promise.all(
    refs.map(async (r) => {
      const text = await refText(d, p, r, lang).catch(() => null);
      return text && r.page ? `${onScreen(r)}\n${text}` : text;
    }),
  );
  return parts.filter((x): x is string => !!x).join("\n\n");
}

/** The line that tells the model the person has this open: "this", "here" and "it" mean it, unless they say otherwise. */
export function onScreen(r: Pick<Ref, "kind" | "label">): string {
  return `(The asker has ${r.kind} "${r.label}" open on screen while asking: "this", "here" and "it" mean it unless the question names something else. Prefer it as the context of the answer.)`;
}

async function refText(d: Deps, p: Principal, r: Ref, lang: "en" | "vi"): Promise<string | null> {
  const work = <T>(path: string) => d.services.work.request<T>("GET", path, undefined, p);
  const id = encodeURIComponent(r.id);
  // Chat, a message and a person are read through the same tools @AI uses, so the module's own rules apply.
  const tool = async (name: string, input: Record<string, unknown>, lookup?: Map<string, Tool>) => {
    const res = await executeTool(d.pool, { principal: p, agentId: null, services: d.services, lang }, name, input, lookup);
    return res.ok ? res.content : null;
  };
  switch (r.kind) {
    case "channel": {
      if (r.thread) {
        const thread = await tool("get_thread", { messageId: r.thread });
        if (thread)
          return `Workspace chat thread in channel "${r.label}" (channel ${r.id}, thread ${r.thread}; for summarize_channel, extract_action_items or draft_reply pass thread ${r.thread}):\n${untrusted(thread.slice(0, 8000))}`;
      }
      const recent = await tool("recent_channel_messages", { channelId: r.id });
      return recent
        ? `Workspace chat channel "${r.label}" (channel ${r.id}; for summarize_channel or extract_action_items pass channel ${r.id}). Its latest messages:\n${untrusted(recent.slice(0, 6000))}`
        : null;
    }
    case "message": {
      // A message is read with its thread: what it answers and what came after it.
      const thread = await tool("get_thread", { messageId: r.id });
      return thread ? `Workspace chat message "${r.label}" (message ${r.id}) and its thread:\n${untrusted(thread.slice(0, 6000))}` : null;
    }
    case "person": {
      // Who they are for everyone; their progress only for someone who may see it (the report tool refuses otherwise).
      const [who, progress] = await Promise.all([tool("find_people", { query: r.label.slice(0, 200) }), tool("person_progress", { person: r.label }, reportTools())]);
      const text = [who, progress].filter(Boolean).join("\n\n");
      return text ? `Workspace person "${r.label}":\n${untrusted(text.slice(0, 8000))}` : null;
    }
    case "report": {
      const what = REPORTS[r.id];
      return what ? `(The asker is on ${what}. Questions about people's progress, workload or AI use mean the company's data on that screen: use the report tools.)` : null;
    }
    case "task": {
      const detail = await work<BriefTaskDetail>(`/tasks/${id}`);
      const b = await taskBrief(d, p, detail, lang);
      return `Workspace data about task ${detail.task.code} (read with the asker's access):\n${untrusted(b.brief.text.slice(0, 9000))}`;
    }
    case "document": {
      const doc = await work<{ document: { code?: string; title: string }; text?: string; content?: string }>(`/docs/${id}?track=0`);
      const body = (doc.text ?? doc.content ?? "").slice(0, 12_000);
      return `Workspace document ${doc.document.code ?? ""} "${doc.document.title}":\n${untrusted(body)}`;
    }
    case "project": {
      const [pr, board] = await Promise.all([
        work<{ code: string; name: string; description: string; status: string; dueAt: string | null }>(`/projects/${id}`),
        work<{ columns: { name: string; tasks: { code: string; title: string; dueAt: string | null; progress?: number | null; blockedReason?: string | null }[] }[] }>(
          `/projects/${id}/board`,
        ).catch(() => null),
      ]);
      const lines = (board?.columns ?? []).flatMap((c) =>
        c.tasks
          .slice(0, 25)
          .map((t) => `- [${c.name}] ${t.code} ${t.title}${t.dueAt ? ` (due ${t.dueAt.slice(0, 10)})` : ""}${t.blockedReason ? ` · blocked: ${t.blockedReason}` : ""}`),
      );
      const text = [
        `${pr.code} ${pr.name} · status ${pr.status}${pr.dueAt ? ` · due ${String(pr.dueAt).slice(0, 10)}` : ""}`,
        pr.description,
        "Tasks by column:",
        ...lines.slice(0, 120),
      ]
        .filter(Boolean)
        .join("\n");
      return `Workspace project ${pr.code}:\n${untrusted(text)}`;
    }
    case "meeting": {
      const m = await work<{
        event: { code: string | null; title: string; startsAt: string; endsAt: string; location: string; agenda: string; notes: string };
        attendees: { userId: string; response: string }[];
        actionItems: { code: string; title: string; status: string }[];
      }>(`/meetings/${id}`);
      const e = m.event;
      const text = [
        `${e.title} · ${String(e.startsAt).slice(0, 16)} → ${String(e.endsAt).slice(11, 16)}${e.location ? ` · ${e.location}` : ""}`,
        `Attendees: ${m.attendees.length}`,
        e.agenda ? `Agenda:\n${e.agenda}` : "",
        e.notes ? `Minutes:\n${e.notes}` : "",
        m.actionItems.length ? `Action items:\n${m.actionItems.map((t) => `- ${t.code} ${t.title} (${t.status})`).join("\n")}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      return `Workspace meeting ${e.code ?? ""}:\n${untrusted(text.slice(0, 12_000))}`;
    }
    case "workflow": {
      // Pointed at to be run, or asked about: what it is for and what it asks at the start (run_workflow takes its id).
      const w = await work<{
        id: string;
        name: string;
        description: string;
        steps: { title: string; kind: string }[];
        config?: { inputs?: { key: string; label: string; required?: boolean; options?: string[] }[] };
      }>(`/workflows/${id}`);
      const asks = (w.config?.inputs ?? []).map((f) => `- ${f.key}: ${f.label}${f.required ? " (required)" : ""}${f.options?.length ? ` [${f.options.join(" | ")}]` : ""}`);
      const text = [
        `Workflow "${w.name}" (id ${w.id})`,
        w.description,
        `Steps: ${w.steps.map((s) => s.title).join(" → ")}`,
        asks.length ? `It asks at the start:\n${asks.join("\n")}` : "It asks nothing at the start.",
      ];
      return `Workspace agent workflow:\n${untrusted(text.filter(Boolean).join("\n").slice(0, 4000))}`;
    }
    case "file": {
      // A file in the Drive: its indexed text, read with the asker's access.
      const r = await d.services.chat.request<{ passages: { title: string; text?: string }[] }>("GET", `/search/passages/around?type=file&id=${id}&seq=5&radius=5`, undefined, p);
      if (!r.passages.length) return null;
      return `Workspace file "${r.passages[0]!.title}":\n${untrusted(
        r.passages
          .map((x) => x.text ?? "")
          .join("\n")
          .slice(0, 12_000),
      )}`;
    }
  }
}

/** Keeps a question's files and @ references with the message, for the reopened conversation and later turns. */
export async function saveExtras(c: PoolClient, userId: string, messageId: string, files: ReadFile[], refs: Ref[]) {
  for (const f of files)
    await c.query("INSERT INTO ai_message_files (id, message_id, user_id, name, content_type, size, kind, data, text) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)", [
      newId(),
      messageId,
      userId,
      f.name,
      f.contentType,
      f.size,
      f.kind,
      f.data,
      f.text,
    ]);
  if (refs.length) await c.query("UPDATE ai_messages SET refs = $2 WHERE id = $1", [messageId, JSON.stringify(refs)]);
}

/**
 * The conversation so far for the model: each earlier question with what it carried, so "and section 2?" after a file
 * still has the file. Older files are cut short, images only named (the model saw them when they were asked about).
 */
export async function historyFor(c: PoolClient, conversationId: string, limit: number): Promise<{ id: string; role: "user" | "assistant"; content: string }[]> {
  const rows = (
    await c.query<{ id: string; role: "user" | "assistant"; content: string; refs: Ref[] | null; trace: TraceItem[] | null }>(
      "SELECT id, role, content, refs, trace FROM (SELECT id, role, content, refs, tool_trace AS trace, at FROM ai_messages WHERE conversation_id = $1 ORDER BY at DESC LIMIT $2) x ORDER BY at",
      [conversationId, limit],
    )
  ).rows;
  const ids = rows.filter((r) => r.role === "user").map((r) => r.id);
  const files = ids.length
    ? (
        await c.query<{ message_id: string; name: string; kind: string; text: string }>(
          "SELECT message_id, name, kind, text FROM ai_message_files WHERE message_id = ANY($1) ORDER BY at",
          [ids],
        )
      ).rows
    : [];
  // The lookups behind the last two answers ride with them; older ones would only cost tokens.
  const answers = rows.filter((r) => r.role === "assistant").slice(-2);
  return rows.map((r, i) => {
    const own = files.filter((f) => f.message_id === r.id);
    const asked = r.role === "assistant" && answers.includes(r) ? rows[i - 1] : undefined;
    const extra = [
      filesBlock(own, HISTORY_FILE_CHARS),
      own
        .filter((f) => f.kind === "image")
        .map((f) => `(Attached image "${f.name}")`)
        .join("\n"),
      r.refs?.length ? `(Pointed at: ${r.refs.map((x) => `${x.page ? "on screen: " : ""}${x.kind} ${x.label}`).join(", ")})` : "",
      asked?.role === "user" && asked.trace?.length ? traceNote(asked.trace) : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    return { id: r.id, role: r.role, content: extra ? `${r.content}\n\n${extra}` : r.content };
  });
}

/**
 * What an earlier answer looked up, for the model only: each tool with the input it was given and the start of what
 * came back, so "only Engineering" or "compared with last month" reruns the same tool with changed input.
 */
export function traceNote(trace: TraceItem[]): string {
  const lines = trace.slice(0, 6).map((t) => {
    const head = t.head.replace(/\s+/g, " ").trim().slice(0, 240);
    return `- ${t.tool} ${JSON.stringify(t.input).slice(0, 300)}${t.ok ? "" : " (failed)"}${head ? ` → ${head}${t.head.length > 240 ? "…" : ""}` : ""}`;
  });
  // What the tools returned is workspace data: marked as such, so nothing in it is taken as an instruction.
  return `(To write this answer the assistant used these tools:\n${untrusted(lines.join("\n"))}\nA follow-up that narrows, widens or compares this answer should call the same tool again with the changed input.)`;
}

/** The question as the model reads it: the text, then the @ records and the files; images ride along. */
export function questionMessage(content: string, refsText: string, files: ReadFile[]): ModelMessage {
  const text = [content, refsText, filesBlock(files)].filter(Boolean).join("\n\n");
  const images = imagesOf(files);
  return images.length ? { role: "user", content: text, images } : { role: "user", content: text };
}

export { imagesRefused } from "./providers.js";

/** The files a stored question carried, for regenerating its answer. */
export async function storedExtras(c: PoolClient, messageId: string): Promise<{ files: ReadFile[]; refs: Ref[] }> {
  const files = (
    await c.query<{ name: string; content_type: string; size: number; kind: "image" | "file"; data: Buffer | null; text: string }>(
      "SELECT name, content_type, size, kind, data, text FROM ai_message_files WHERE message_id = $1 ORDER BY at",
      [messageId],
    )
  ).rows.map((f) => ({ name: f.name, contentType: f.content_type, size: f.size, kind: f.kind, data: f.data, text: f.text }));
  const refs = (await c.query<{ refs: Ref[] | null }>("SELECT refs FROM ai_messages WHERE id = $1", [messageId])).rows[0]?.refs ?? [];
  return { files, refs };
}
