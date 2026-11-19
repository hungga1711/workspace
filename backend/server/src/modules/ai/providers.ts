import type { Step } from "./progress.js";
import Anthropic from "@anthropic-ai/sdk";
import {
  answerFrom,
  draftSection,
  findPerson,
  fold,
  keywords,
  looksLikeAction,
  overlap,
  parseTaskRequest,
  planSteps,
  plainLines,
  plainSentences,
  replyLang,
  suggestAssignee,
  type Lang,
  type RosterEntry,
} from "./local-model.js";
import { clusterNotes, suggestIdeas, summarizeBoard } from "./whiteboard-local.js";
import { localAdoption, localProgress, localTaskPrompt } from "./hub-local.js";
import { callWithWebTools } from "./anthropic-web.js";

/**
 * Model providers. Two tiers:
 *   fast  → summaries, extraction, briefs (cheap)
 *   smart → agent tool use, Q&A
 * Providers never see authorization decisions: tools enforce them.
 */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON schema
}

/** An image the person attached in Hỏi đáp (base64, already downscaled in the browser). */
/** A text-only model refused the images (Ollama: "does not support multimodal"; others name images or vision). */
export const imagesRefused = (e: unknown) =>
  /multimodal|(does not|doesn't|cannot|can't) (support|read|accept|process) (images?|vision)|image input/i.test((e as Error)?.message ?? "");

export interface ModelImage {
  mediaType: string;
  data: string;
}
export interface ModelMessage {
  role: "user" | "assistant";
  content: string;
  /** Only on user turns, for models that read images; a text-only model refuses the request (400). */
  images?: ModelImage[];
}

export interface ModelRequest {
  tier: "fast" | "smart";
  /** Metering feature (e.g. "ask", "thread_summary"); lets the gateway route one feature to its own model. */
  feature?: string;
  system: string;
  messages: ModelMessage[];
  tools?: ToolSpec[];
  maxTokens: number;
  /** "provider:model" the caller picked (Trợ lý AI's model menu); tried first when that vendor is configured. */
  route?: string;
  /** The person the call is for: their own AI answers when this is their own request (personal-ai.ts). */
  person?: string;
  /**
   * Hỏi đáp's live answer: the text as the model writes it. With tools too: a turn that ends in tool
   * calls voids what it wrote (`reset`), since that was not the answer. A backend that cannot stream ignores it.
   */
  stream?: ModelStream;
  /**
   * The provider's own web and cloud tools this request may use (web-need.ts): search, reading a page, its code sandbox.
   * Set only when the question needs them; a backend without such tools ignores it. Never local files or a shell.
   */
  web?: WebTools;
  /** A web/cloud tool of the provider's own starting or ending, for the answer's steps and the audit (as it happens). */
  onServerTool?: (e: ServerToolEvent) => void;
}

export interface WebTools {
  search?: boolean;
  fetch?: boolean;
  code?: boolean;
}

/** One use of a provider's own tool: `start` when it is called, `end` with what it found. */
export type ServerToolEvent =
  | { phase: "start"; id: string; name: "web_search" | "web_fetch" | "code_execution"; input: Record<string, unknown> }
  | { phase: "end"; id: string; ok: boolean; found?: number; pages?: WebPage[] };

/** A web page an answer used: cited as a "web" source (an outside link). */
export interface WebPage {
  url: string;
  title: string;
}

/** Where a streamed answer goes as it is written (stream.ts sends it on to the browser). */
export interface ModelStream {
  /** More of the answer. */
  text(delta: string): void;
  /** What was written so far is void: that backend failed part-way and the next one starts over. */
  reset(): void;
  /** The person pressed stop, or left: a streaming backend ends with what it has (`stopped`). */
  signal: AbortSignal;
  /** What the answer is doing (a tool call starting or ending, progress.ts), shown above the text as it happens. */
  step?(s: Step): void;
}

export interface ModelResponse {
  text: string;
  toolCalls: { id: string; name: string; input: Record<string, unknown> }[];
  usage: { inputTokens: number; outputTokens: number };
  model: string;
  /** Gateway backend that answered ("c_<connection id>", "openai", "local"…): prices are per backend and model. */
  provider?: string;
  /** Streamed and stopped part-way (ModelStream.signal): `text` is what was written until then. */
  stopped?: boolean;
  /** The web pages the provider's own tools searched or read (WebTools): the answer cites them. */
  pages?: WebPage[];
  /** The provider's own tools it used, for a backend that reports them only at the end (a computer's AI). */
  serverTools?: { name: "web_search" | "web_fetch" | "code_execution"; input: Record<string, unknown> }[];
}

/** Where the answer is written as it comes, when the caller wants it live. */
export const streamOf = (req: ModelRequest) => req.stream ?? null;

/** An answer cut short by stop: what was written, with a rough token count (4 characters a token) the vendor never sent. */
export function stoppedAnswer(req: ModelRequest, text: string, model: string): ModelResponse {
  const asked = req.system.length + req.messages.reduce((n, m) => n + m.content.length, 0);
  return { text, toolCalls: [], usage: { inputTokens: Math.ceil(asked / 4), outputTokens: Math.ceil(text.length / 4) }, model, stopped: true };
}

export interface ModelProvider {
  readonly name: string;
  generate(req: ModelRequest): Promise<ModelResponse>;
  /** Gateway only: whether the main model is currently failing over. */
  status?(): { degraded: boolean; reason?: "rate_limited" | "failing"; since?: string };
}

/** One vendor API. The gateway (gateway.ts) picks the model per request and calls `call`. */
export interface ModelBackend {
  readonly name: string;
  call(model: string, req: ModelRequest): Promise<ModelResponse>;
}

export class AnthropicProvider implements ModelBackend {
  readonly name = "anthropic";
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey, timeout: 30_000, maxRetries: 2 });
  }

  async call(model: string, req: ModelRequest): Promise<ModelResponse> {
    const params = {
      model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: req.messages.map((m) =>
        m.images?.length
          ? {
              role: m.role,
              content: [
                ...m.images.map((i) => ({ type: "image" as const, source: { type: "base64" as const, media_type: i.mediaType as "image/png", data: i.data } })),
                { type: "text" as const, text: m.content },
              ],
            }
          : { role: m.role, content: m.content },
      ),
      ...(req.tools?.length ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema as Anthropic.Tool.InputSchema })) } : {}),
    };
    // The question needs Claude's own web or code tools (web-need.ts): they run on Anthropic's side.
    if (req.web && (req.web.search || req.web.fetch || req.web.code)) return callWithWebTools(this.client, model, params, req);
    const live = streamOf(req);
    if (live) {
      const s = this.client.messages.stream(params, { signal: live.signal });
      let written = "";
      s.on("text", (delta) => {
        written += delta;
        live.text(delta);
      });
      try {
        const r = await s.finalMessage();
        const calls = r.content
          .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
          .map((b) => ({ id: b.id, name: b.name, input: b.input as Record<string, unknown> }));
        // Words before a tool call were not the answer: the next turn writes it.
        if (calls.length && written) live.reset();
        return { text: written, toolCalls: calls, usage: { inputTokens: r.usage.input_tokens, outputTokens: r.usage.output_tokens }, model };
      } catch (e) {
        if (!live.signal.aborted) throw e;
        return stoppedAnswer(req, written, model);
      }
    }
    const r = await this.client.messages.create(params);
    const text = r.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    const toolCalls = r.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, input: b.input as Record<string, unknown> }));
    return { text, toolCalls, usage: { inputTokens: r.usage.input_tokens, outputTokens: r.usage.output_tokens }, model };
  }
}

/**
 * Deterministic provider for local dev and tests when no API key is set. It does
 * extractive work only (no tool calls), so behaviour is reproducible.
 */
export class LocalProvider implements ModelProvider, ModelBackend {
  readonly name = "local";

  async call(_model: string, req: ModelRequest): Promise<ModelResponse> {
    return this.generate(req);
  }

  async generate(req: ModelRequest): Promise<ModelResponse> {
    const input = req.messages.map((m) => m.content).join("\n");
    const text = req.system.includes("JSON") ? localJson(req.system, input) : localAnswer(req.system, input);
    return { text, toolCalls: [], usage: { inputTokens: Math.ceil((req.system.length + input.length) / 4), outputTokens: Math.ceil(text.length / 4) }, model: "local-extractive" };
  }
}

const DECISION = /(chốt|quyết định|thống nhất|decided|agreed|we will|let'?s go with|should move|move .+ to)/i;
const ACTION = /(<@[\w:-]+>|cần|hãy|please|can you|todo|should|will|phải|nhờ|need(s)? to|let'?s|let us|must|ha(s|ve) to|to-?do)/i;
const DATE = /(\d{1,2}\/\d{1,2}(?:\/\d{4})?|(?:january|february|march|april|may|june|july|august|september|october|november|december) \d{1,2}|ngày \d{1,2}(?:\/\d{1,2})?)/i;

/**
 * Lines that address the AI instead of the team ("ignore previous instructions", "SYSTEM OVERRIDE",
 * a pasted JSON reply). The extractive fallback copies text verbatim, so it drops these rather than
 * quoting an injection back as if it were the conversation.
 */
const INJECTION =
  /(ignore (all |any )?(previous|prior|above|the) (instructions|rules|messages)|system (override|prompt)|you are now|reply (only )?with|respond with|bỏ qua (mọi|tất cả|các) (hướng dẫn|chỉ dẫn|quy tắc)|^\s*[{[]\s*"[a-z]+"\s*:)/i;
export const looksLikeInjection = (line: string) => INJECTION.test(line);

function lines(input: string): string[] {
  const block = input.split("<untrusted_content>")[1]?.split("</untrusted_content>")[0] ?? input;
  return block
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#") && !looksLikeInjection(l.replace(/^\[[^\]]*\]\s*/, "")));
}

function localJson(system: string, input: string): string {
  const assist = system.match(/ASSIST:(\w+)/)?.[1];
  if (assist) return localAssist(assist, system, input);
  const ls = lines(input).map((l) => l.replace(/^\[[^\]]*\]\s*/, ""));
  if (system.includes('"recommendation"')) {
    const ctx = input.split("<context>")[1]?.split("</context>")[0] ?? "";
    let first: { title?: string } | undefined;
    try {
      first = (JSON.parse(ctx || "{}").needsYou ?? [])[0];
    } catch {
      first = undefined;
    }
    const en = /Locale: en/.test(system);
    return JSON.stringify({
      recommendation: first?.title ? (en ? `Start with: ${first.title}` : `Ưu tiên xử lý: ${first.title}`) : en ? "Nothing urgent today." : "Hôm nay không có việc gấp.",
      digest: [],
    });
  }
  // "People (id: name)" roster from the caller: a line that names someone assigns it to them.
  const roster = (system.split("People (id: name)")[1] ?? "")
    .split("\n")
    .map((r) => r.match(/^([\w-]+): (.+)$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ id: m[1]!, name: m[2]!.trim() }));
  const actions = ls
    .filter((l) => ACTION.test(l) && !DECISION.test(l))
    .slice(0, 10)
    .map((l) => {
      const mention = l.match(/<@([\w-]+)>/);
      const named = roster.find((r) => r.name && l.toLowerCase().includes(r.name.toLowerCase()));
      const title = l
        .replace(/<@[\w:-]+>\s*/g, "")
        .replace(named && l.toLowerCase().startsWith(named.name.toLowerCase()) ? named.name : "", "")
        .replace(/^[\s,:-]+/, "")
        .replace(/^(cần|phải|hãy|nhờ)\s+/i, "");
      return { title: (title.charAt(0).toUpperCase() + title.slice(1)).slice(0, 140), assigneeId: mention?.[1] ?? named?.id ?? null, due: l.match(DATE)?.[0] ?? null };
    });
  const decisions = ls
    .filter((l) => DECISION.test(l))
    .slice(0, 10)
    .map((l) => ({ title: l.slice(0, 200) }));
  // Decisions first, then actions, then the rest; each point kept short so the summary stays a summary.
  const short = (t: string) => (t.length > 140 ? `${t.slice(0, 137).trimEnd()}…` : t);
  const summary = [...new Set([...decisions.map((d) => d.title), ...actions.map((a) => a.title), ...ls])].slice(0, 3).map(short).join(" · ");
  return JSON.stringify({ summary, actions, decisions });
}

const block = (input: string, tag: string) => input.split(`<${tag}>`)[1]?.split(`</${tag}>`)[0] ?? "";

/** Deterministic, extractive stand-ins for the task/document assist actions (no model available). */
function localAssist(action: string, system: string, input: string): string {
  const body = input
    .split("<untrusted_content>")
    .slice(1)
    .map((x) => x.split("</untrusted_content>")[0] ?? "")
    .join("\n");
  let facts: { title?: string; status?: string; priority?: string; dueAt?: string | null; now?: string; subtasks?: string[] } = {};
  try {
    facts = JSON.parse(block(input, "facts") || "{}");
  } catch {
    facts = {};
  }
  // The reader's language (assistSystem's "Write in …"); a typed request or question counts first.
  const typed = block(input, "request") || block(input, "question");
  const lang: Lang = typed ? replyLang(system, typed) : /(Write|Reply) in Vietnamese/i.test(system) ? "vi" : "en";
  const en = lang === "en";
  // A task arrives as "title, description, Comments: …" (assist.ts); its own text and its comments are read apart.
  const [main = "", comments = ""] = body.split(/\n\n(?:Comments|Bình luận):\n/);
  const ss = plainSentences(body).filter((x) => !looksLikeInjection(x));
  const own = plainSentences(main).filter((x) => !looksLikeInjection(x));
  const roster: RosterEntry[] = (system.split("People (id: name)")[1] ?? "")
    .split("\n")
    .map((r) => r.match(/^([\w-]+): ([^(·\n]+?)\s*(?:\(([^)]*)\))?\s*(?:· (\d+)\b.*)?$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ id: m[1]!, name: m[2]!.trim(), title: m[3]?.trim() ?? "", ...(m[4] === undefined ? {} : { load: Number(m[4]) }) }));
  const bullets = (t: string) =>
    t
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^([-*]|\d+[.)]|\[ ?\])\s+/.test(l))
      .flatMap((l) => plainLines(l))
      .filter((l) => !looksLikeInjection(l));
  switch (action) {
    case "task_summarize": {
      // What the task is (title, first lines of the description), then where it stands (the latest check-in note).
      const title = facts.title ?? own[0] ?? "";
      const notes = plainSentences(comments).filter((x) => !looksLikeInjection(x));
      const progress = [...notes]
        .reverse()
        .map((x) => x.match(/progress (\d{1,3})%/i)?.[1])
        .find(Boolean);
      const latest = [...notes].reverse().find((x) => !/progress \d{1,3}%/i.test(x));
      const desc = own.filter((x) => x !== title).slice(0, 2);
      const parts = [
        `${title.replace(/[.!?]$/, "")}.`,
        ...desc.map((x) => (/[.!?]$/.test(x) ? x : `${x}.`)),
        latest ? (en ? `Latest update: “${latest}”` : `Cập nhật gần nhất: “${latest}”`) : "",
        progress ? (en ? `Progress: ${progress}%.` : `Tiến độ: ${progress}%.`) : "",
      ].filter(Boolean);
      return JSON.stringify({ summary: title ? parts.join(" ") : en ? "Nothing to summarise yet." : "Chưa có nội dung để tóm tắt." });
    }
    case "doc_summarize": {
      // The page title arrives as a heading: it is the subject, not a point. Repeated lines count once.
      const title = (body.match(/^# (.+)$/m)?.[1] ?? "").trim();
      const lines = [...new Set(ss.filter((x) => x !== title))];
      const prose = lines.filter((x) => !/^[^:]{1,40}: \S/.test(x));
      const points = (bullets(body).length ? bullets(body) : lines).filter((x) => x !== title).slice(0, 6);
      const lead = (prose.length ? prose : lines).slice(0, 3).map((x) => (/[.!?]$/.test(x) ? x : `${x}.`));
      return JSON.stringify({ summary: lead.join(" ") || (en ? "Nothing to summarise yet." : "Chưa có nội dung để tóm tắt."), keyPoints: points });
    }
    case "task_subtasks": {
      // Steps written as a list in the description; else its sentences that ask for something.
      const listed = bullets(main).length ? bullets(main) : own.slice(1).filter(looksLikeAction);
      const steps = planSteps(facts.title ?? own[0] ?? "", listed, lang);
      return JSON.stringify({ subtasks: steps.filter((b) => !(facts.subtasks ?? []).some((s) => s.includes(b))).slice(0, 8) });
    }
    case "task_description": {
      const title = facts.title ?? own[0] ?? "";
      const goals = bullets(main).length ? bullets(main) : own.slice(1, 4);
      const notes = plainSentences(comments)
        .filter((x) => !looksLikeInjection(x) && !/^@?[\w .'-]{0,40}progress \d+%$/i.test(x))
        .slice(-2);
      const H = en ? ["Goal", "Expected outcome", "Notes"] : ["Mục tiêu", "Kết quả mong muốn", "Lưu ý"];
      const outcome = goals.length ? goals : planSteps(title, [], lang);
      return JSON.stringify({
        description: `## ${H[0]}\n${title}\n\n## ${H[1]}\n${outcome.map((b) => `- [ ] ${b}`).join("\n")}\n\n## ${H[2]}\n${notes.join(" ") || "-"}`,
      });
    }
    case "task_priority": {
      const now = Date.parse(facts.now ?? new Date().toISOString());
      const due = facts.dueAt ? Date.parse(facts.dueAt) : null;
      const hours = due === null ? null : (due - now) / 3600_000;
      const urgentWords = /gap|khan|urgent|asap|ngay lap tuc|hom nay|today|critical|blocker/.test(fold(body));
      const open = (facts.subtasks ?? []).filter((s) => s.startsWith("[ ]")).length;
      const priority = hours !== null && hours < 0 ? "urgent" : urgentWords || (hours !== null && hours < 48) ? "high" : hours !== null && hours < 168 ? "medium" : "low";
      const overdueRisk = hours !== null && (hours < 0 || (hours < 48 && open > 1)) ? "high" : hours !== null && hours < 168 && open > 2 ? "medium" : "low";
      const days = hours === null ? 0 : Math.round(hours / 24);
      const reason =
        hours === null
          ? en
            ? "There is no due date yet."
            : "Chưa có hạn chót."
          : hours < 0
            ? en
              ? "It is already overdue."
              : "Đã quá hạn."
            : en
              ? hours < 48
                ? `It is due in about ${Math.max(1, Math.round(hours))} hours.`
                : `It is due in about ${days} days.`
              : `Còn khoảng ${Math.round(hours)} giờ tới hạn.`;
      return JSON.stringify({
        priority,
        reason: urgentWords && hours !== null && hours >= 48 ? `${reason}${en ? " The task says it is urgent." : " Việc có ghi là gấp."}` : reason,
        overdueRisk,
        riskReason: en ? (open ? `${open} subtask${open === 1 ? "" : "s"} still open.` : "No open subtasks.") : `${open} việc con chưa xong.`,
      });
    }
    case "task_assignee":
      return JSON.stringify(suggestAssignee(main, roster, lang));
    case "task_update": {
      const request = block(input, "request");
      const tz = system.match(/Times are in ([\w/+-]+)\./)?.[1];
      const patch = parseTaskRequest(request, { now: facts.now ? new Date(facts.now) : new Date(), ...(tz ? { timeZone: tz } : {}), roster });
      const ok = Object.keys(patch).length > 0;
      return JSON.stringify({
        patch,
        explanation: ok
          ? en
            ? "Here is what I understood:"
            : "Đã đọc yêu cầu thành các thay đổi bên dưới."
          : en
            ? "I could not turn that into a change. Try: “due next Friday, high priority, assign to Maya”."
            : "Chưa hiểu yêu cầu. Thử: “dời hạn sang 20/11, ưu tiên cao, giao cho Lan”.",
      });
    }
    // Whiteboards (whiteboard.ts): the title in <facts>, the board as note/label lines, an optional <request>. Notes
    // that address the AI are left out, as everywhere the fallback quotes text back.
    case "wb_summarize":
    case "wb_cluster":
    case "wb_ideas": {
      const board = body
        .split("\n")
        .filter((l) => !looksLikeInjection(l.replace(/^\[[^\]]*\]\s*/, "")))
        .join("\n");
      if (action === "wb_summarize") return JSON.stringify({ summary: summarizeBoard(facts.title ?? "", board, lang) });
      if (action === "wb_cluster") return JSON.stringify({ groups: clusterNotes(board, lang) });
      return JSON.stringify({ ideas: suggestIdeas(facts.title ?? "", board, block(input, "request"), lang) });
    }
    // AI › Tiến độ and Áp dụng AI: the facts block carries everything (hub-local.ts).
    case "progress_brief":
    case "adoption_ideas":
    case "adoption_prompt": {
      let all: unknown = {};
      try {
        all = JSON.parse(block(input, "facts") || "{}");
      } catch {
        all = {};
      }
      if (action === "adoption_prompt") return localTaskPrompt(all as Parameters<typeof localTaskPrompt>[0], lang);
      return action === "progress_brief" ? localProgress(all as Parameters<typeof localProgress>[0], lang) : localAdoption(all as Parameters<typeof localAdoption>[0], lang);
    }
    case "doc_ask": {
      const question = block(input, "question");
      const hits = answerFrom(body, question, 2);
      return JSON.stringify({ answer: hits.length ? hits.join(" ") : en ? "The document does not say." : "Tài liệu không nhắc tới điều này.", quotes: hits });
    }
    case "doc_actions": {
      const lines = plainLines(body).filter((l) => !looksLikeInjection(l));
      const listed = bullets(body).filter(looksLikeAction);
      const picks = (listed.length ? listed : lines.flatMap((l) => l.split(/(?<=[.!?])\s+/)).filter(looksLikeAction)).slice(0, 10);
      return JSON.stringify({
        actions: picks.map((title) => ({
          title: title.replace(/^(please|vui lòng|hãy)\s+/i, "").replace(/^./, (c) => c.toUpperCase()),
          assigneeId: findPerson(title, roster)?.id ?? null,
          due: title.match(/\d{1,2}\/\d{1,2}(?:\/\d{4})?/)?.[0] ?? null,
        })),
      });
    }
    case "doc_changes": {
      const [oldT = "", newT = ""] = input.split("NEW:");
      const o = new Set(plainSentences(oldT.split("<untrusted_content>")[1]?.split("</untrusted_content>")[0] ?? ""));
      const n = plainSentences(newT.split("<untrusted_content>")[1]?.split("</untrusted_content>")[0] ?? "");
      const added = n.filter((x) => !o.has(x)).map((x) => `${en ? "Added" : "Thêm"}: ${x}`);
      const removed = [...o].filter((x) => !n.includes(x)).map((x) => `${en ? "Removed" : "Bỏ"}: ${x}`);
      return JSON.stringify({ changes: [...added, ...removed].slice(0, 8) });
    }
    case "doc_draft": {
      const title = body.match(/^# (.+)$/m)?.[1] ?? "";
      return JSON.stringify({ draft: draftSection(block(input, "request"), title, body.replace(/^# .+$/m, ""), lang) });
    }
    default:
      return JSON.stringify({});
  }
}

/**
 * The extractive answer for a question: the workspace data that was read for it (search hits, my tasks…) as a short
 * list, in the question's language. Labels such as "[task T-104]" become "T-104:", ids and Markdown go. Results of a
 * blind search are ranked by the question's keywords and only the matching ones are shown; the answer to a known
 * question (my tasks, my leave) is shown whole.
 */
function localAnswer(system: string, input: string): string {
  const question = (input.split("\n\n")[0] ?? input).replace(/\(Asked in chat channel [^)]*\)/, "");
  const en = replyLang(system, question) === "en";
  const searched = input.includes("Search results from the workspace");
  const src = input.split("<untrusted_content>")[1]?.split("</untrusted_content>")[0];
  // Search results are only their labelled lines; one tool's own answer (a table, a tree, a report) is read whole,
  // its unlabelled lines too: "who is overloaded" is the rows under the heading, not the heading alone.
  const rows = (src ?? "")
    .split("\n")
    .filter((l) => (searched ? l.startsWith("[") : l.trim() && !/^[|\s-]+$/.test(l)))
    .map((l, i) => {
      const m = l.match(/^\[([^\]]*)\]\s*(.*)$/) ?? ["", "", l.replace(/\*\*/g, "").replace(/^\s*(?:#+|[-*])\s*/, "")];
      const label = m[1]!.replace(/\s*\b[0-9A-HJKMNP-TV-Z]{26}\b/, "").trim();
      const doc = /^from /.test(label);
      const person = /^(person|người) /.test(label);
      const name = label.replace(/^(task|việc|project|dự án|person|người|from) /i, "");
      const text = plainLines(m[2]!).join(" · ");
      const cut = text.length > 240 ? `${text.slice(0, 237).trimEnd()}…` : text;
      // "[task T-104] …" → "T-104: …"; a document's sentence names its document after it; a bare kind (message,
      // document) or the totals line needs no label. Labels read as the start of a sentence ("On leave: …").
      const bare = /^(message|document|task|project|person|tổng|total|team|đội)$/i.test(label);
      const head = bare ? "" : name.charAt(0).toUpperCase() + name.slice(1);
      const line = !text || (doc && fold(text) === fold(name)) ? "" : doc ? `${cut} (${name})` : `${head ? `${head}: ` : ""}${cut}`;
      return { line, text, label: name, kind: label, i, doc, person, n: 0 };
    })
    .filter((r) => r.line);
  let picked = rows;
  // "my overdue tasks": only the late ones, when the answer marks any.
  const late = (l: string) => /OVERDUE|TRỄ|\bLATE\b|· (overdue|trễ hạn):|\b[1-9]\d* (overdue|trễ hạn)\b/.test(l);
  const tasks = rows.length > 0 && rows.every((r) => /^T-\d+: /.test(r.line));
  const overdueQ = /overdue|\blate\b|behind|at risk|qua han|tre han|cham/.test(fold(question));
  if (!searched && overdueQ && rows.some((r) => late(r.line))) picked = rows.filter((r) => late(r.line));
  else if (!searched && overdueQ && tasks)
    // Nothing late: say so, and what is due next, rather than listing every task as if it were overdue.
    return en
      ? `None of your open tasks are overdue. Next up:\n${rows
          .slice(0, 3)
          .map((r) => `- ${r.line}`)
          .join("\n")}`
      : `Bạn không có việc nào trễ hạn. Sắp tới:\n${rows
          .slice(0, 3)
          .map((r) => `- ${r.line}`)
          .join("\n")}`;
  // "What's on my plate today?": what is due today (and anything late), else what comes next.
  if (!searched && tasks && /today|on my plate|this morning|hom nay/.test(fold(question))) {
    const now = rows.filter((r) => /\((today|OVERDUE)\)/.test(r.line));
    const list = (rs: typeof rows) => rs.map((r) => `- ${r.line}`).join("\n");
    if (now.length) return `${en ? "Here is what's on your plate today:" : "Việc của bạn hôm nay:"}\n${list(now)}`;
    return `${en ? "Nothing is due today. Coming up next:" : "Hôm nay không có việc đến hạn. Sắp tới:"}\n${list(rows.slice(0, 3))}`;
  }
  // A known question about one thing ("status of the customer portal project"): the lines that name it.
  if (!searched && picked === rows && /project|dự án/i.test(question)) {
    const named = keywords(question, 6).filter((w) => !/^(status|project|projects|tasks?|team|working|doing|going|du|an|viec)$/.test(w));
    const best = Math.max(0, ...rows.map((r) => overlap(r.line, named)));
    if (named.length && best > 0) picked = rows.filter((r) => overlap(r.line, named) === best);
  }
  if (searched) {
    const words = keywords(question, 6);
    // A document that was read answers with its own sentences: its search hit (title and opening) steps back.
    const read = [...new Set(rows.filter((r) => r.doc).map((r) => r.label))];
    const pool = rows.filter((r) => !(r.kind === "document" && read.some((t) => fold(r.text).startsWith(fold(t)))));
    // "Who wrote it?": the owner line of the document the question names best (or the only one read).
    const owners = pool.filter((r) => r.doc && /^(Owner|Người tạo): /.test(r.text));
    if (/\b(who (wrote|owns|created|made|is the author)|author|owner)\b|ai (viết|tạo|sở hữu)/i.test(question) && owners.length) {
      const o = [...owners].sort((a, b) => overlap(b.label, words) - overlap(a.label, words))[0]!;
      const name = o.text.replace(/^(Owner|Người tạo): /, "");
      return en ? `“${o.label}” is owned by ${name}.` : `“${o.label}” do ${name} tạo.`;
    }
    // "Summarise the checkout research doc": the opening of the document the question names best.
    if (/summari[sz]e|summary|overview|key points|tóm tắt|tổng quan/i.test(question) && read.length) {
      const title = [...read].sort((a, b) => overlap(b, words) - overlap(a, words))[0]!;
      if (overlap(title, words) > 0) {
        // Its sentences in order, without the owner line and bare headings ("Top findings").
        const lines = pool
          .filter((r) => r.doc && r.label === title && !/^(Owner|Người tạo): /.test(r.text) && (/[.!?:;%\d]/.test(r.text) || r.text.split(" ").length > 4))
          .slice(0, 7);
        return `${en ? `Here is a summary of “${title}”:` : `Tóm tắt “${title}”:`}\n${lines.map((r) => `- ${r.text}`).join("\n")}`;
      }
    }
    // What a line says counts twice what its label (a document's title) does: "travel" in the travel rule beats
    // "expense policy" in every rule's title.
    for (const r of pool) r.n = 2 * overlap(r.text, words) + overlap(r.label, words);
    const best = Math.max(0, ...pool.map((r) => r.n));
    picked = pool
      .filter((r) => r.n > 0 && r.n >= Math.max(1, best - 1))
      .sort((a, b) => b.n - a.n || Number(b.doc) - Number(a.doc) || a.i - b.i)
      .slice(0, 6);
    // Items that only share a read document's title words step back behind its sentences.
    const bestDoc = Math.max(0, ...picked.filter((r) => r.doc).map((r) => r.n));
    picked = picked.filter((r) => !bestDoc || r.doc || r.n > bestDoc);
    // "Who is …?" is answered by the people who match, not by every page that mentions the words.
    if (/^\s*(who|who's|whom|ai là|ai phụ trách)\b/i.test(question) && picked.some((r) => r.person)) picked = picked.filter((r) => r.person);
  }
  const unique = [...new Set(picked.map((r) => `- ${r.line}`))].slice(0, 12);
  if (!unique.length)
    return en
      ? "I couldn't find anything about that in the workspace data you can see. Try a name, a task code (T-104) or a couple of keywords."
      : "Mình không tìm thấy thông tin nào bạn có quyền xem cho câu hỏi này.";
  return `${en ? "Here is what I found in the workspace:" : "Đây là dữ liệu liên quan bạn có quyền xem:"}\n${unique.join("\n")}`;
}
