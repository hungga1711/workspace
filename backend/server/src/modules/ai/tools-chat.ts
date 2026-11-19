import { z } from "zod";
import { dayKey, DEFAULT_TIME_ZONE } from "@workspace/shared";
import { ToolProblem, type Source, type Tool, type ToolContext } from "./tools.js";
import { clip, destination, en, enc, F, field, fold, L, person, str, when, work, type Say, type Write } from "./workspace-kit.js";
import { fileText } from "./tools-office.js";

/**
 * The assistant's chat tools: what a channel said since a time, the action items in a conversation, the
 * questions nobody answered, the context for a reply, one "what needs me" list; and, after the person's yes, pinning a
 * message and starting a poll. Everything is read as the asker through the chat module, which checks membership.
 */

interface Msg {
  id: string;
  channelId: string;
  seq: number;
  threadRootId: string | null;
  authorId: string;
  authorType: string;
  importAuthor: string | null;
  body: string;
  replyCount: number;
  createdAt: string;
  pinned?: boolean;
  poll?: { question: string } | null;
  channel?: { id: string; kind: string; name: string | null; dmUserId: string | null } | null;
}
interface Channel {
  id: string;
  kind: string;
  name: string | null;
  displayName: string | null;
  dmUserId: string | null;
  unread: number;
  mentions: number;
  lastReadSeq: number;
  muted?: boolean;
}

const chat = <T>(ctx: ToolContext, method: string, path: string, body?: unknown) => ctx.services.chat.request<T>(method, path, body, ctx.principal);
const ID = z.string().length(26);

/** Everyone's display name by user id, for "who said what"; empty when the directory cannot be read. */
async function directory(ctx: ToolContext): Promise<Map<string, string>> {
  const r = await ctx.services.employee
    .request<{ employees: { userId: string; displayName: string }[] }>("GET", "/employees?all=1", undefined, ctx.principal)
    .catch(() => ({ employees: [] as { userId: string; displayName: string }[] }));
  return new Map(r.employees.map((e) => [e.userId, e.displayName]));
}

const channels = async (ctx: ToolContext) => (await chat<{ channels: Channel[] }>(ctx, "GET", "/channels")).channels;

/** A conversation's name as people say it: #name, or the colleague of a direct conversation. */
const channelLabel = (c: { kind: string; name: string | null; displayName?: string | null; dmUserId: string | null }, names: Map<string, string>) =>
  c.kind === "public" || c.kind === "private" ? `#${c.displayName || c.name || "channel"}` : c.dmUserId ? (names.get(c.dmUserId) ?? "direct message") : (c.displayName ?? "group");

/**
 * The conversation the user means, among those they are in: an id, a channel's name (with or without #), or a
 * colleague's name for the direct conversation with them. Never creates one: a read of a conversation that does not
 * exist has nothing to read.
 */
export async function findChannel(ctx: ToolContext, ref: string): Promise<Channel> {
  const all = await channels(ctx);
  const byId = all.find((c) => c.id === ref.trim());
  if (byId) return byId;
  // A public channel the user may read without having joined it (@AI asked there): the chat module decides.
  if (/^[0-9A-HJKMNP-TV-Z]{26}$/.test(ref.trim())) {
    const one = await chat<{ id: string; kind: string; name: string | null; displayName: string | null }>(ctx, "GET", `/channels/${enc(ref.trim())}`).catch(() => null);
    if (one) return { ...one, dmUserId: null, unread: 0, mentions: 0, lastReadSeq: 0 };
  }
  const q = fold(ref.replace(/^[#@]/, ""));
  const named = all.filter((c) => c.kind !== "dm" && [c.name, c.displayName].some((n) => n && fold(n) === q));
  if (named.length === 1) return named[0]!;
  if (named.length > 1) throw new ToolProblem(`Several channels are called "${ref}". Ask the user which one.`);
  const loose = all.filter((c) => c.kind !== "dm" && [c.name, c.displayName].some((n) => n && fold(n).includes(q)));
  if (loose.length === 1) return loose[0]!;
  let who;
  try {
    who = await person(ctx, ref);
  } catch {
    throw new ToolProblem(`"${ref}" is not a channel the user is in, nor a colleague they have a direct conversation with. Ask the user which conversation.`);
  }
  const dm = all.find((c) => c.kind === "dm" && c.dmUserId === who.userId);
  if (!dm) throw new ToolProblem(`The user has no direct conversation with ${who.displayName}.`);
  return dm;
}

/** A message's text as people read it: `<@user id>` mentions become @Name (the model must never see or show ids). */
export const readable = (body: string, names: Map<string, string>) => body.replace(/<@([A-Za-z0-9_-]{1,64})>/g, (_m, id: string) => `@${names.get(id) ?? "someone"}`);

const messageUrl = (m: { id: string; channelId: string; threadRootId?: string | null }) => `/app/chat/${m.channelId}?m=${m.threadRootId ?? m.id}`;
const messageSource = (m: Msg, title: string): Source => ({ type: "message", id: m.id, title, url: messageUrl(m) });

/** One line per message: `[message id] Tue 14/11 09:05 Lan: text` (replies indented under their thread). */
export function lines(msgs: Msg[], names: Map<string, string>, ctx: ToolContext, max = 500): string {
  return msgs
    .filter((m) => m.body?.trim() || m.poll)
    .map((m) => {
      const who = m.authorType === "user" ? (names.get(m.authorId) ?? m.importAuthor ?? "someone") : (m.importAuthor ?? "AI");
      const text = m.poll ? `📊 poll: ${m.poll.question}` : clip(readable(m.body, names).replace(/\s+/g, " ").trim(), max);
      const extra = [m.threadRootId ? null : m.replyCount ? `${m.replyCount} replies` : null, m.pinned ? "pinned" : null].filter(Boolean).join(", ");
      return `${m.threadRootId ? "  ↳ " : ""}[message ${m.id}] ${when(m.createdAt, ctx)} ${who}: ${text}${extra ? ` (${extra})` : ""}`;
    })
    .join("\n");
}

interface Window {
  channel: { id: string; kind: string; name: string | null; dmUserId: string | null } | null;
  fromLastRead: boolean;
  more: boolean;
  messages: Msg[];
}
interface Thread {
  root: Msg;
  replies: Msg[];
}

/** A conversation's messages: a thread by its root message, else a channel since a time or since last read. */
async function conversation(ctx: ToolContext, input: { channel?: string | undefined; thread?: string | undefined; since?: string | undefined; limit?: number | undefined }) {
  const names = await directory(ctx);
  if (input.thread) {
    const t = await chat<Thread>(ctx, "GET", `/messages/${enc(input.thread)}/thread`);
    const ch = (await channels(ctx)).find((c) => c.id === t.root.channelId);
    return {
      names,
      label: `${ch ? channelLabel(ch, names) : "a conversation"} › thread`,
      head: en(ctx) ? "Thread (root message, then replies)" : "Chủ đề (tin gốc, rồi các trả lời)",
      msgs: [t.root, ...t.replies.map((r) => ({ ...r, threadRootId: r.threadRootId ?? t.root.id }))],
      source: messageSource(t.root, "thread"),
      more: false,
    };
  }
  if (!input.channel) throw new ToolProblem("Give `channel` (a name, #name or colleague) or `thread` (a root message id).");
  const ch = await findChannel(ctx, input.channel);
  const since = input.since && !Number.isNaN(Date.parse(input.since)) ? `&since=${enc(new Date(input.since).toISOString())}` : "";
  const w = await chat<Window>(ctx, "GET", `/assist/channels/${enc(ch.id)}/window?limit=${input.limit ?? 120}${since}`);
  const label = channelLabel(ch, names);
  const head = w.fromLastRead
    ? en(ctx)
      ? `${label}: messages since the user last read it`
      : `${label}: tin nhắn từ lần cuối người dùng đọc`
    : en(ctx)
      ? `${label}: messages since ${when(input.since!, ctx)}`
      : `${label}: tin nhắn từ ${when(input.since!, ctx)}`;
  return {
    names,
    label,
    head: `${head}${w.more ? (en(ctx) ? " (latest part only; older ones left out)" : " (chỉ phần mới nhất)") : ""}`,
    msgs: w.messages,
    source: { type: "channel", id: ch.id, title: label, url: `/app/chat/${ch.id}` } satisfies Source,
    more: w.more,
  };
}

const convoInput = z.object({
  channel: z.string().min(1).max(120).optional(),
  thread: ID.optional(),
  since: z.string().max(40).optional(),
});
const convoSchema = {
  channel: str("a channel name (#sales), or a colleague's name for the direct conversation with them"),
  thread: str("a thread's root message id, instead of a channel (optional)"),
  since: str("ISO date-time to read from (optional; default: since the user last read the channel)"),
};

/** Unread channels, busiest first: "what did I miss" with no channel named. */
async function missed(ctx: ToolContext) {
  const names = await directory(ctx);
  const unread = (await channels(ctx)).filter((c) => c.unread > 0 && !c.muted).sort((a, b) => b.mentions - a.mentions || b.unread - a.unread);
  if (!unread.length) return { ok: true, content: en(ctx) ? "The user has no unread messages." : "Người dùng không có tin chưa đọc.", sources: [] };
  const top = unread.slice(0, 5);
  const parts = await Promise.all(
    top.map(async (c) => {
      const w = await chat<Window>(ctx, "GET", `/assist/channels/${enc(c.id)}/window?limit=40`).catch(() => null);
      if (!w) return "";
      const label = channelLabel(c, names);
      const counts = en(ctx)
        ? `${c.unread} unread${c.mentions ? `, ${c.mentions} mention the user` : ""}${w.more ? ", latest 40 shown" : ""}`
        : `${c.unread} chưa đọc${c.mentions ? `, ${c.mentions} nhắc tên người dùng` : ""}${w.more ? ", chỉ 40 tin mới nhất" : ""}`;
      return `## ${label} (${counts})\n${lines(w.messages, names, ctx, 300)}`;
    }),
  );
  const rest = unread.slice(5).map((c) => `${channelLabel(c, names)} (${c.unread})`);
  return {
    ok: true,
    content: `${parts.filter(Boolean).join("\n\n")}${rest.length ? `\n\n${en(ctx) ? "Also unread" : "Còn chưa đọc"}: ${rest.join(", ")}` : ""}`,
    sources: top.map((c) => ({ type: "channel" as const, id: c.id, title: channelLabel(c, names), url: `/app/chat/${c.id}` })),
  };
}

interface Question extends Msg {
  channel: { id: string; kind: string; name: string | null; dmUserId: string | null } | null;
}
const waited = (iso: string) => {
  const h = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 3_600_000));
  return h >= 48 ? `${Math.round(h / 24)}d` : `${h}h`;
};
const questionLines = (qs: Question[], names: Map<string, string>, ctx: ToolContext) =>
  qs
    .map((q) => {
      const where = q.channel ? channelLabel(q.channel, names) : "?";
      return `[message ${q.id}] ${where} · ${names.get(q.authorId) ?? "someone"} · ${en(ctx) ? "waiting" : "chờ"} ${waited(q.createdAt)}: ${clip(readable(q.body, names).replace(/\s+/g, " ").trim(), 280)}`;
    })
    .join("\n");

export const READ: Tool[] = [
  {
    name: "summarize_channel",
    description:
      "Read a chat conversation to summarize it ('what did I miss in #sales', 'summarize this thread'): a channel's messages since a time (default: since the user last read it), or a thread. With no channel and no thread: the user's unread conversations, busiest first. Summarize from what it returns; name people, decisions and open questions.",
    permission: "message.read",
    input: convoInput,
    jsonSchema: { type: "object", properties: convoSchema },
    async run(ctx, input) {
      if (!input.channel && !input.thread) return missed(ctx);
      const c = await conversation(ctx, input);
      const body = lines(c.msgs, c.names, ctx);
      return { ok: true, content: `${c.head}\n${body || (en(ctx) ? "Nothing new." : "Không có gì mới.")}`, sources: [c.source] };
    },
  },
  {
    name: "extract_action_items",
    description:
      "Read a chat conversation (a channel since a time, or a thread) with who said what, or a file with `file` (meeting minutes, a contract, a brief: PDF, Word, PowerPoint, Excel), to list its action items: what must be done, by whom, by when, and the message or page it came from. Present them as a list. Do NOT create tasks yourself: offer to, and only on the user's yes call create_task once per item (it asks the user first).",
    permission: "message.read",
    input: convoInput.extend({ file: z.string().max(200).optional(), fileTask: z.string().max(80).optional(), part: z.number().int().min(1).max(200).optional() }),
    jsonSchema: {
      type: "object",
      properties: {
        ...convoSchema,
        file: str("instead of a conversation: a file attached to the question or an earlier one, a Drive file's name, or a file id"),
        fileTask: str("the task (T-041) the file is attached to (optional)"),
        part: { type: "integer", description: "which part of a long file (1, 2, …)" },
      },
    },
    async run(ctx, input) {
      if (input.file) {
        const f = await fileText(ctx, input.file, input.fileTask, input.part);
        const rule = en(ctx)
          ? "Action items are what someone must do (a decision to carry out, a request, a commitment, a deadline). Owner = who the text names; keep the page (p. 3) or section it came from."
          : "Việc cần làm là điều ai đó phải làm (quyết định cần thực hiện, lời nhờ, lời hứa, hạn chót). Người làm = người được nêu tên; ghi kèm trang (tr. 3) hoặc mục nguồn.";
        return { ok: true, content: `${f.head}\n${rule}\n<untrusted_content>\n${f.text || "(empty)"}\n</untrusted_content>`, sources: f.source ? [f.source] : [] };
      }
      const c = await conversation(ctx, { ...input, limit: 200 });
      const body = lines(c.msgs, c.names, ctx, 800);
      const rule = en(ctx)
        ? 'Action items are commitments and requests ("I\'ll send…", "can you…", "by Friday"). Owner = who committed or was asked.'
        : 'Việc cần làm là lời hứa và lời nhờ ("em sẽ gửi…", "anh làm giúp…", "trước thứ Sáu"). Người làm = người hứa hoặc được nhờ.';
      return { ok: true, content: `${c.head}\n${rule}\n${body || (en(ctx) ? "Nothing in this window." : "Không có tin nào.")}`, sources: [c.source] };
    },
  },
  {
    name: "unanswered_questions",
    description:
      "Questions and requests put to the user (a mention of them, or a direct or group conversation) that nobody answered after `hours` hours (default 4), from the last `days` days (default 14), newest first, with how long each has waited. For 'what haven't I replied to', 'who is waiting on me'.",
    permission: "message.read",
    input: z.object({ hours: z.number().int().min(0).max(720).optional(), days: z.number().int().min(1).max(60).optional(), directOnly: z.boolean().optional() }),
    jsonSchema: {
      type: "object",
      properties: {
        hours: { type: "integer", description: "only questions older than this many hours (default 4)" },
        days: { type: "integer", description: "look back this many days (default 14)" },
        directOnly: { type: "boolean", description: "only direct and group conversations, not mentions in channels" },
      },
    },
    async run(ctx, input) {
      const r = await chat<{ questions: Question[] }>(ctx, "GET", `/assist/unanswered?hours=${input.hours ?? 4}&days=${input.days ?? 14}${input.directOnly ? "&direct=1" : ""}`);
      if (!r.questions.length)
        return { ok: true, content: en(ctx) ? "No unanswered questions to the user." : "Không có câu hỏi nào gửi người dùng còn chưa trả lời.", sources: [] };
      const names = await directory(ctx);
      return {
        ok: true,
        content: questionLines(r.questions, names, ctx),
        sources: r.questions.slice(0, 8).map((q) => messageSource(q, `${names.get(q.authorId) ?? "message"}: ${clip(readable(q.body, names).replace(/\s+/g, " "), 60)}`)),
      };
    },
  },
  {
    name: "draft_reply",
    description:
      "Read what a reply must answer: the message, its thread and the conversation just before it, with names, and who the user is. Then write the draft reply in your answer for the user to copy and send. Send it only if the user asks, with send_message (which asks them first). `message` is a message id from a search or another chat tool.",
    permission: "message.read",
    input: z.object({ message: ID }),
    jsonSchema: { type: "object", properties: { message: str("the id of the message to reply to") }, required: ["message"] },
    async run(ctx, input) {
      const names = await directory(ctx);
      const first = await chat<Thread>(ctx, "GET", `/messages/${enc(input.message)}/thread`);
      // A reply in a thread: the whole thread is the context, from its root.
      const t = first.root.threadRootId ? await chat<Thread>(ctx, "GET", `/messages/${enc(first.root.threadRootId)}/thread`) : first;
      const before = await chat<{ messages: Msg[] }>(ctx, "GET", `/channels/${enc(t.root.channelId)}/messages?before=${t.root.seq}&limit=12`).catch(() => ({
        messages: [] as Msg[],
      }));
      const ch = (await channels(ctx)).find((c) => c.id === t.root.channelId);
      const me = names.get(ctx.principal.id) ?? "the user";
      const content = [
        `${en(ctx) ? "Conversation" : "Cuộc trò chuyện"}: ${ch ? channelLabel(ch, names) : "?"}. ${en(ctx) ? "The user is" : "Người dùng là"} ${me}.`,
        before.messages.length ? `${en(ctx) ? "Just before" : "Ngay trước đó"}:\n${lines([...before.messages].reverse(), names, ctx, 300)}` : "",
        `${en(ctx) ? "Thread" : "Chủ đề"}:\n${lines([t.root, ...t.replies.map((r) => ({ ...r, threadRootId: r.threadRootId ?? t.root.id }))], names, ctx, 800)}`,
        `${en(ctx) ? "Reply to" : "Trả lời tin"}: [message ${input.message}]`,
      ]
        .filter(Boolean)
        .join("\n\n");
      return { ok: true, content, sources: [messageSource(first.root, "message")] };
    },
  },
  {
    name: "needs_my_attention",
    description:
      "One list of what is waiting on the user right now: requests for approval they must decide, unread messages that mention them, their overdue tasks and tasks due today, and direct messages nobody answered. For 'what needs me', 'what should I do first', a morning check.",
    permission: "message.read",
    input: z.object({}),
    jsonSchema: { type: "object", properties: {} },
    async run(ctx) {
      const zone = ctx.timeZone ?? DEFAULT_TIME_ZONE;
      const today = dayKey(new Date(), zone);
      const [names, approvals, mentions, chans, tasks, dms] = await Promise.all([
        directory(ctx),
        work<{ approvals: { id: string; code: string; title: string; requesterId: string; status: string; createdAt: string }[] }>(ctx, "GET", "/approvals").catch(() => null),
        chat<{ messages: Msg[] }>(ctx, "GET", "/mentions").catch(() => null),
        channels(ctx).catch(() => [] as Channel[]),
        work<{ tasks: { id: string; code: string; title: string; status: string; dueAt: string | null }[] }>(ctx, "GET", "/tasks").catch(() => null),
        chat<{ questions: Question[] }>(ctx, "GET", "/assist/unanswered?hours=2&days=7&direct=1").catch(() => null),
      ]);
      const sources: Source[] = [];
      const sections: string[] = [];
      const t = (e: string, v: string) => (en(ctx) ? e : v);

      const pending = approvals?.approvals.filter((a) => a.status === "pending") ?? [];
      if (pending.length) {
        sections.push(
          `## ${t("Approvals waiting for you", "Yêu cầu chờ bạn duyệt")} (${pending.length})\n${pending
            .slice(0, 10)
            .map((a) => `[approval ${a.code}] ${a.title} · ${t("from", "từ")} ${names.get(a.requesterId) ?? "?"} · ${t("waiting", "chờ")} ${waited(a.createdAt)}`)
            .join("\n")}`,
        );
        sources.push(...pending.slice(0, 5).map((a) => ({ type: "approval" as const, id: a.id, title: `${a.code} ${a.title}`, url: `/app/work/approvals/${a.id}` })));
      }

      const lastRead = new Map(chans.map((c) => [c.id, c.lastReadSeq]));
      const unreadMentions = (mentions?.messages ?? []).filter((m) => m.seq > (lastRead.get(m.channelId) ?? Infinity));
      if (unreadMentions.length) {
        sections.push(
          `## ${t("Unread mentions", "Nhắc tên chưa đọc")} (${unreadMentions.length})\n${unreadMentions
            .slice(0, 10)
            .map(
              (m) =>
                `[message ${m.id}] ${m.channel ? channelLabel(m.channel, names) : "?"} · ${names.get(m.authorId) ?? "someone"}: ${clip(readable(m.body, names).replace(/\s+/g, " "), 200)}`,
            )
            .join("\n")}`,
        );
        sources.push(...unreadMentions.slice(0, 3).map((m) => messageSource(m, "mention")));
      }

      const open = (tasks?.tasks ?? []).filter((x) => x.dueAt && !["done", "cancelled"].includes(x.status));
      const late = open.filter((x) => dayKey(new Date(x.dueAt!), zone) < today);
      const dueToday = open.filter((x) => dayKey(new Date(x.dueAt!), zone) === today);
      if (late.length || dueToday.length) {
        const row = (x: (typeof open)[number], mark: string) => `[task ${x.code}] ${x.title} · ${mark}`;
        sections.push(
          `## ${t("Your tasks", "Việc của bạn")}\n${[
            ...late.slice(0, 10).map((x) => row(x, `${t("OVERDUE since", "TRỄ từ")} ${new Date(x.dueAt!).toLocaleDateString(en(ctx) ? "en-GB" : "vi-VN", { timeZone: zone })}`)),
            ...dueToday.slice(0, 10).map((x) => row(x, t("due today", "hạn hôm nay"))),
          ].join("\n")}`,
        );
        sources.push(...[...late, ...dueToday].slice(0, 5).map((x) => ({ type: "task" as const, id: x.id, title: `${x.code} ${x.title}`, url: `/app/work/tasks/${x.code}` })));
      }

      const waiting = dms?.questions ?? [];
      if (waiting.length)
        sections.push(
          `## ${t("Direct messages waiting for your answer", "Tin nhắn riêng chờ bạn trả lời")} (${waiting.length})\n${questionLines(waiting.slice(0, 10), names, ctx)}`,
        );

      const failed = [approvals, mentions, tasks, dms].some((x) => x === null);
      const note = failed ? `\n\n${t("(Some lists could not be read just now.)", "(Một vài danh sách chưa đọc được lúc này.)")}` : "";
      return {
        ok: true,
        content: (sections.length ? sections.join("\n\n") : t("Nothing is waiting on the user right now.", "Hiện không có gì chờ người dùng.")) + note,
        sources,
      };
    },
  },
];

const S = {
  pin: { en: "Pin a message", vi: "Ghim tin nhắn" },
  poll: { en: "Start a poll", vi: "Tạo bình chọn" },
  where: { en: "In", vi: "Ở" },
  question: { en: "Question", vi: "Câu hỏi" },
  options: { en: "Options", vi: "Lựa chọn" },
  multi: { en: "Several answers allowed", vi: "Được chọn nhiều" },
} satisfies Record<string, Say>;

export const WRITE: Write[] = [
  {
    title: S.pin,
    preview: (i, loc) => ({
      title: L(loc, S.pin),
      fields: [...field(loc, F.message, i.quote ?? i.message)],
      note: L(loc, { en: "Everyone in the conversation sees it pinned.", vi: "Mọi người trong cuộc trò chuyện sẽ thấy tin được ghim." }),
    }),
    tool: {
      name: "pin_message",
      description: "Pin a chat message in its conversation (only when the user asks). `message` is the message id; `quote` the first words of it, shown to the user to confirm.",
      permission: "message.post",
      input: z.object({ message: ID, quote: z.string().max(300).optional() }),
      jsonSchema: {
        type: "object",
        properties: { message: str("the message id"), quote: str("the start of the message's text, for the confirm card") },
        required: ["message"],
      },
      async run(ctx, input) {
        const t = await chat<Thread>(ctx, "GET", `/messages/${enc(input.message)}/thread`);
        await chat(ctx, "POST", `/messages/${enc(input.message)}/pin`);
        return { ok: true, content: en(ctx) ? "Pinned." : "Đã ghim.", sources: [messageSource(t.root, "pinned message")] };
      },
    },
  },
  {
    title: S.poll,
    preview: (i, loc) => ({
      title: L(loc, S.poll),
      fields: [
        ...field(loc, S.where, i.channel),
        ...field(loc, S.question, i.question),
        ...field(loc, S.options, i.options),
        ...(i.multi ? field(loc, S.multi, L(loc, { en: "yes", vi: "có" })) : []),
      ],
    }),
    tool: {
      name: "create_poll",
      description:
        "Post a poll in a channel the user is in, or in the direct conversation with a colleague (only when the user asks). 2 to 10 options; `multi` lets people pick several.",
      permission: "message.post",
      input: z.object({
        channel: z.string().min(1).max(120),
        question: z.string().trim().min(1).max(300),
        options: z.array(z.string().trim().min(1).max(120)).min(2).max(10),
        multi: z.boolean().default(false),
      }),
      jsonSchema: {
        type: "object",
        properties: {
          channel: str("a channel name (#team) or a colleague's name"),
          question: str("the poll's question"),
          options: { type: "array", items: { type: "string" }, description: "2 to 10 answers" },
          multi: { type: "boolean", description: "allow several answers" },
        },
        required: ["channel", "question", "options"],
      },
      async run(ctx, input) {
        const to = await destination(ctx, input.channel);
        const m = await chat<Msg>(ctx, "POST", `/channels/${enc(to.id)}/polls`, { question: input.question, options: input.options, multi: input.multi });
        return { ok: true, content: `${en(ctx) ? "Poll posted in" : "Đã tạo bình chọn ở"} ${to.label}.`, sources: [messageSource(m, `${to.label}: ${input.question}`)] };
      },
    },
  },
];

export const TITLES: Record<string, Say> = {
  summarize_channel: { en: "Read the conversation", vi: "Đọc cuộc trò chuyện" },
  extract_action_items: { en: "Find action items", vi: "Tìm việc cần làm" },
  unanswered_questions: { en: "Find unanswered questions", vi: "Tìm câu hỏi chưa trả lời" },
  draft_reply: { en: "Read what to reply to", vi: "Đọc tin cần trả lời" },
  needs_my_attention: { en: "Check what needs you", vi: "Xem việc chờ bạn" },
};
