import type { PoolClient } from "pg";
import type { AnswerBlock } from "../answer-blocks.js";
import { newId } from "@workspace/shared";
import type { Deps } from "../runtime.js";
import type { ToolUse } from "./client.js";
import { newState, runToolLoop, toolsFor, type LoopMessage, type LoopResult, type LoopState, type Who } from "./loop.js";
import type { Loc } from "../locale.js";
import type { ModelStream } from "../providers.js";
import type { Source } from "../tools.js";
import type { Surface } from "../tool-select.js";
import { citedIn, type Preview } from "../workspace-tools.js";

/**
 * Hỏi đáp with outside tools: the company assistant's answer runs as a tool loop when the person has MCP tools, and a
 * tool that asks first pauses it (mcp_pending) until they approve or decline on the confirm card.
 */

/** What the browser shows for a tool the AI used (chips under the answer). Never the arguments or the result. */
export type ToolChip = Pick<ToolUse, "serverId" | "server" | "tool" | "title" | "outcome" | "ms">;
export const chips = (uses: ToolUse[]): ToolChip[] => uses.map(({ serverId, server, tool, title, outcome, ms }) => ({ serverId, server, tool, title, outcome, ms }));

/** The confirm card: what will run, where, with which arguments (as the model wrote them, cut for the screen). */
export interface PendingCard {
  id: string;
  serverId: string;
  server: string;
  tool: string;
  title: string | null;
  args: string;
  /** A workspace tool's change in plain words (what the card shows instead of the raw arguments). */
  preview?: Preview;
}

/** Where a paused answer belongs when it is not a Hỏi đáp conversation: a task whose comments asked for it. */
export type PendingContext = { surface: "task"; taskId: string } | { surface: "channel"; channelId: string };

export type ChatAnswer = {
  text: string;
  model: string;
  uses: ToolUse[];
  sources?: Source[];
  /** Charts and tables drawn under the answer (answer-blocks.ts). */
  blocks?: AnswerBlock[];
  stopped?: boolean;
  pending?: { state: LoopState; call: Extract<LoopResult, { done: false }>["call"] };
  /** The tools this answer ran, with what it asked them and the start of what came back (for follow-ups). */
  trace?: TraceItem[];
};

/**
 * One tool call of an answer, kept with the question (ai_messages.tool_trace) so the next question in the conversation
 * can refine it ("only the Engineering department", "compared with last month") with the same tool and changed input.
 * Never shown in the browser.
 */
export interface TraceItem {
  tool: string;
  input: Record<string, unknown>;
  ok: boolean;
  head: string;
}
const TRACE_MAX = 6;
const TRACE_HEAD = 500;
/** Records each call `tools` runs into `trace` (at most TRACE_MAX), leaving what it returns untouched. */
export function tracing<T extends { run(key: string, input: unknown): Promise<{ ok: boolean; content: string }> }>(tools: T, trace: TraceItem[]): T {
  const run = tools.run.bind(tools);
  tools.run = async (key: string, input: unknown) => {
    const r = await run(key, input);
    const asked = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    if (trace.length < TRACE_MAX) trace.push({ tool: key, input: asked, ok: r.ok, head: r.content.slice(0, TRACE_HEAD) });
    return r;
  };
  return tools;
}

const out = (r: LoopResult): ChatAnswer =>
  r.done
    ? { text: r.stopped ? r.text : r.text || "…", model: r.model, uses: r.uses, sources: citedIn(r.text, r.sources), blocks: r.blocks, ...(r.stopped ? { stopped: true } : {}) }
    : // Waiting for the person: what was read so far stays with the paused state and is cited with the final answer.
      { text: "", model: "", uses: r.uses, sources: [], pending: { state: r.state, call: r.call } };

/** The latest question in a conversation, as text. */
function lastAsked(messages: LoopMessage[]): string {
  const m = [...messages].reverse().find((x) => x.role === "user");
  return typeof m?.content === "string" ? m.content : "";
}
const lastPictures = (messages: LoopMessage[]) => !![...messages].reverse().find((x) => x.role === "user")?.images?.length;

/**
 * The answer with tools, or null when there are none to offer (the caller answers as before). `workspace`: also the
 * workspace's own tools (search, read, and the changes a person confirms), in the answer's language `loc`.
 */
export async function answerWithTools(
  d: Deps,
  who: Who,
  system: string,
  messages: LoopMessage[],
  route: string | undefined,
  withConfirm: boolean,
  /** `question`: the question as asked (no attached context), which picks the tools shown; `surface`: where. */
  opts: { workspace?: boolean; loc?: Loc; live?: ModelStream | undefined; question?: string; surface?: Surface } = {},
): Promise<ChatAnswer | null> {
  const asked = (opts.question ?? lastAsked(messages)).slice(0, 2000);
  // The files sent with the question (filesBlock writes their names), so a spreadsheet to analyse gets the code tool.
  const attached = [...lastAsked(messages).matchAll(/Attached file "([^"]{1,200})"/g)].map((m) => m[1]!);
  const tools = await toolsFor(d, who, {
    ...(attached.length ? { attached } : {}),
    // Pictures with the question bring the tool that saves the table read from them.
    ...(lastPictures(messages) ? { pictures: true } : {}),
    withConfirm,
    ...(route ? { route } : {}),
    ...(opts.workspace ? { workspace: true } : {}),
    ...(opts.loc ? { loc: opts.loc } : {}),
    question: asked,
    ...(opts.surface ? { surface: opts.surface } : {}),
  });
  if (!tools) return null;
  const trace: TraceItem[] = [];
  try {
    const state = newState(system, messages, 2048, route, tools, opts.loc);
    state.asked = asked;
    if (opts.surface) state.surface = opts.surface;
    const answer = out(await runToolLoop(d, who, state, tracing(tools, trace), undefined, undefined, opts.live));
    return trace.length ? { ...answer, trace } : answer;
  } finally {
    await tools.close();
  }
}

export async function savePending(
  c: PoolClient,
  userId: string,
  conversationId: string | null,
  p: NonNullable<ChatAnswer["pending"]>,
  context: PendingContext | null = null,
): Promise<PendingCard> {
  const id = newId();
  const args = JSON.stringify(p.call.args, null, 2);
  const card: PendingCard = {
    id,
    serverId: p.call.serverId,
    server: p.call.server,
    tool: p.call.tool,
    title: p.call.title,
    args: args.length > 4000 ? `${args.slice(0, 4000)}\n…` : args,
    ...(p.call.preview ? { preview: p.call.preview } : {}),
  };
  // The card is kept with the paused answer: the conversation shows it again when it is opened later.
  await c.query("INSERT INTO mcp_pending (id, user_id, conversation_id, server_id, tool, state, context, card) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)", [
    id,
    userId,
    conversationId,
    p.call.serverId,
    p.call.tool,
    JSON.stringify(p.state),
    context ? JSON.stringify(context) : null,
    JSON.stringify(card),
  ]);
  return card;
}

/** What a card that was never answered proposed, in the answer's language. */
function notDone(r: { tool: string; card: PendingCard | null; state: LoopState }): string {
  const vi = r.state?.loc === "vi";
  // A card kept before cards were stored has only the call: its tool in words, and what it was for.
  const call = r.state?.queue?.[0]?.input;
  const first = r.card?.preview?.fields[0]?.value ?? (typeof call?.title === "string" ? call.title : undefined);
  const name = r.card?.preview?.title ?? r.card?.title ?? r.tool.replace(/_/g, " ").replace(/^./, (x) => x.toUpperCase());
  const what = `${name}${first ? ` “${first.slice(0, 120)}”` : ""}`;
  return vi ? `_Chưa làm (chưa được duyệt):_ ${what}` : `_Not done (not approved):_ ${what}`;
}

/** How long a card can still be answered (mcp/controller decide). */
const CARD_OPEN_MS = 60 * 60_000;

/**
 * The confirm cards of a Hỏi đáp conversation nobody answered. The ones still open come back to be shown where they
 * were (the conversation opened again); an expired one, or every one when `close` (a new question was asked, so the
 * paused answer will never go on), becomes a line in the conversation saying the change was not made: the person sees
 * what was proposed, and the model reads it with the history.
 */
export async function cardsOf(c: PoolClient, userId: string, conversationId: string, close = false): Promise<(PendingCard & { at: string })[]> {
  // Placed just after the question that asked for it: the two are written in the same moment, but not at the same
  // microsecond, so the card goes after the latest message written by then.
  const rows = (
    await c.query<{ id: string; tool: string; card: PendingCard | null; state: LoopState; created_at: Date; at: Date }>(
      `SELECT p.id, p.tool, p.card, p.state, p.created_at,
              GREATEST(p.created_at, (SELECT max(m.at) FROM ai_messages m WHERE m.conversation_id = p.conversation_id AND m.at <= p.created_at + interval '2 seconds'))
                + interval '1 millisecond' AS at
         FROM mcp_pending p WHERE p.conversation_id = $1 AND p.user_id = $2 ORDER BY p.created_at`,
      [conversationId, userId],
    )
  ).rows;
  const open: (PendingCard & { at: string })[] = [];
  for (const r of rows) {
    if (!close && r.card && Date.now() - r.created_at.getTime() < CARD_OPEN_MS) {
      open.push({ ...r.card, id: r.id, at: r.at.toISOString() });
      continue;
    }
    await c.query("DELETE FROM mcp_pending WHERE id = $1", [r.id]);
    await c.query("INSERT INTO ai_messages (id, conversation_id, role, content, at) VALUES ($1, $2, 'assistant', $3, $4)", [newId(), conversationId, notDone(r), r.at]);
  }
  return open;
}

/** Carries on a paused answer after the person's decision (with the workspace's tools when the answer had them). */
export async function resume(d: Deps, who: Who, state: LoopState, approve: boolean, workspace = !!state.workspace): Promise<ChatAnswer> {
  const tools = await toolsFor(d, who, {
    withConfirm: true,
    ...(state.route ? { route: state.route } : {}),
    ...(workspace ? { workspace: true } : {}),
    ...(state.loc ? { loc: state.loc } : {}),
    ...(state.asked ? { question: state.asked } : {}),
    ...(state.surface ? { surface: state.surface } : {}),
  });
  // Every server was removed or switched off meanwhile: the model is told the tool is gone and answers without it.
  const set = tools ?? {
    specs: [],
    byKey: new Map(),
    run: async () => ({ ok: false, content: "", use: null as never }),
    declined: async () => null as never,
    close: async () => {},
  };
  try {
    return out(await runToolLoop(d, who, state, set, { approve }));
  } finally {
    await set.close();
  }
}
