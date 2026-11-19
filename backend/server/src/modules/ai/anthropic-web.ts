import type Anthropic from "@anthropic-ai/sdk";
import { stoppedAnswer, streamOf, type ModelRequest, type ModelResponse, type WebPage } from "./providers.js";

/**
 * Claude's own web and cloud tools: web search, web fetch and the code sandbox run on Anthropic's side, so
 * the answer comes back with their results in it. Only when the question needs them (web-need.ts).
 *
 * The SDK this server pins predates these tools, so the request goes as plain JSON and the stream is read event by
 * event (its message helper does not know the new block types). A long search can pause the turn (`pause_turn`): the
 * request is sent again with what came so far and the server carries on, a few times at most.
 */

type Block = Record<string, unknown> & { type: string };
type ServerName = "web_search" | "web_fetch" | "code_execution";

/** Models with the dynamic-filtering variants; older ones take the basic tools. */
const DYNAMIC = /claude-(?:opus|sonnet)-(?:4-[6-9]|[5-9])|claude-(?:fable|mythos)|claude-haiku-5/;

export function anthropicServerTools(model: string, web: NonNullable<ModelRequest["web"]>): Record<string, unknown>[] {
  const dynamic = DYNAMIC.test(model);
  const out: Record<string, unknown>[] = [];
  if (web.search) out.push({ type: dynamic ? "web_search_20260209" : "web_search_20250305", name: "web_search", max_uses: 5 });
  if (web.fetch) out.push({ type: dynamic ? "web_fetch_20260209" : "web_fetch_20250910", name: "web_fetch", max_uses: 5 });
  // The dynamic web tools already run code under the hood: a second sandbox beside them confuses the model.
  if (web.code && !(dynamic && (web.search || web.fetch))) out.push({ type: "code_execution_20260521", name: "code_execution" });
  return out;
}

const MAX_PAUSES = 3;

/** The pages a turn searched, read or cited; cited ones first, then what was fetched, then the top search results. */
export function pagesOf(blocks: Block[]): WebPage[] {
  const cited: WebPage[] = [];
  const fetched: WebPage[] = [];
  const found: WebPage[] = [];
  for (const b of blocks) {
    if (b.type === "text" && Array.isArray(b.citations))
      for (const c of b.citations as { type?: string; url?: string; title?: string }[]) if (c.url) cited.push({ url: c.url, title: c.title || c.url });
    if (b.type === "web_search_tool_result" && Array.isArray(b.content))
      for (const r of b.content as { url?: string; title?: string }[]) if (r.url) found.push({ url: r.url, title: r.title || r.url });
    if (b.type === "web_fetch_tool_result") {
      const c = b.content as { url?: string; content?: { title?: string } } | undefined;
      if (c?.url) fetched.push({ url: c.url, title: c.content?.title || c.url });
    }
  }
  const all = [...cited, ...fetched, ...(cited.length ? [] : found.slice(0, 3))];
  return all.filter((p, i) => all.findIndex((x) => x.url === p.url) === i).slice(0, 8);
}

/** What a server tool's result says, for its step: ok, how many results, the pages. */
function resultOf(b: Block): { ok: boolean; found?: number; pages?: WebPage[] } {
  const c = b.content as unknown;
  // An error comes back as one object with an error code, not a list (and never as a raised exception).
  if (c && typeof c === "object" && !Array.isArray(c) && "error_code" in (c as object)) return { ok: false };
  if (b.type === "web_search_tool_result" && Array.isArray(c)) {
    const pages = (c as { url?: string; title?: string }[]).filter((r) => r.url).map((r) => ({ url: r.url!, title: r.title || r.url! }));
    return { ok: true, found: pages.length, pages };
  }
  if (b.type === "web_fetch_tool_result") {
    const x = c as { url?: string; content?: { title?: string } } | undefined;
    return { ok: !!x?.url, ...(x?.url ? { pages: [{ url: x.url, title: x.content?.title || x.url }] } : {}) };
  }
  const code = c as { return_code?: number } | undefined;
  return { ok: code?.return_code === undefined || code.return_code === 0 };
}

/** The block as it goes back to the API after a pause: what the stream added for itself left out. */
function replayable(b: Block): Block {
  const { _json: _j, ...rest } = b as Block & { _json?: string };
  return rest as Block;
}

export async function callWithWebTools(client: Anthropic, model: string, params: Record<string, unknown>, req: ModelRequest): Promise<ModelResponse> {
  const live = streamOf(req);
  const tools = [...((params.tools as unknown[] | undefined) ?? []), ...anthropicServerTools(model, req.web ?? {})];
  let messages = [...(params.messages as unknown[])];
  const usage = { inputTokens: 0, outputTokens: 0 };
  const all: Block[] = [];
  let written = "";
  let stop = "";
  try {
    for (let round = 0; round <= MAX_PAUSES; round++) {
      const blocks: Block[] = [];
      const stream = (await client.messages.create({ ...params, model, messages, tools, stream: true } as unknown as Anthropic.MessageCreateParamsStreaming, {
        // A search and a read take longer than a plain answer.
        timeout: 120_000,
        ...(live ? { signal: live.signal } : {}),
      })) as unknown as AsyncIterable<Record<string, unknown> & { type: string }>;
      for await (const ev of stream) {
        if (ev.type === "message_start") usage.inputTokens += Number((ev.message as { usage?: { input_tokens?: number } })?.usage?.input_tokens ?? 0);
        else if (ev.type === "message_delta") {
          usage.outputTokens += Number((ev.usage as { output_tokens?: number } | undefined)?.output_tokens ?? 0);
          stop = String((ev.delta as { stop_reason?: string } | undefined)?.stop_reason ?? stop);
        } else if (ev.type === "content_block_start") {
          const b = { ...(ev.content_block as Block) };
          blocks[Number(ev.index)] = b;
          if (b.type === "server_tool_use") {
            // Words before a search were not the answer: the answer is written after the results.
            if (written && live) live.reset();
            written = "";
            b._json = "";
          } else if (b.type === "tool_use") b._json = "";
          else if (/_tool_result$/.test(b.type)) req.onServerTool?.({ phase: "end", id: String(b.tool_use_id ?? ""), ...resultOf(b) });
          else if (b.type === "text" && typeof b.text === "string" && b.text) {
            written += b.text;
            live?.text(b.text);
          }
        } else if (ev.type === "content_block_delta") {
          const b = blocks[Number(ev.index)];
          const d = ev.delta as Record<string, unknown> & { type: string };
          if (!b) continue;
          if (d.type === "text_delta") {
            const t = String(d.text ?? "");
            b.text = String(b.text ?? "") + t;
            written += t;
            live?.text(t);
          } else if (d.type === "citations_delta") b.citations = [...((b.citations as unknown[]) ?? []), d.citation];
          else if (d.type === "input_json_delta") b._json = String(b._json ?? "") + String(d.partial_json ?? "");
          else if (d.type === "thinking_delta") b.thinking = String(b.thinking ?? "") + String(d.thinking ?? "");
          else if (d.type === "signature_delta") b.signature = d.signature;
        } else if (ev.type === "content_block_stop") {
          const b = blocks[Number(ev.index)];
          if (b && typeof b._json === "string") {
            try {
              b.input = b._json ? JSON.parse(b._json) : (b.input ?? {});
            } catch {
              b.input = {};
            }
            if (b.type === "server_tool_use")
              req.onServerTool?.({ phase: "start", id: String(b.id), name: serverName(String(b.name)), input: (b.input ?? {}) as Record<string, unknown> });
          }
        }
      }
      all.push(...blocks.filter(Boolean));
      if (stop !== "pause_turn") break;
      // Paused part-way through its searches: the same request with what it has so far, and the server goes on.
      messages = [...messages, { role: "assistant", content: blocks.filter(Boolean).map(replayable) }];
    }
  } catch (e) {
    if (!live?.signal.aborted) throw e;
    return { ...stoppedAnswer(req, written, model), pages: pagesOf(all) };
  }
  const calls = all.filter((b) => b.type === "tool_use").map((b) => ({ id: String(b.id), name: String(b.name), input: (b.input ?? {}) as Record<string, unknown> }));
  if (calls.length && written && live) live.reset();
  // The answer is what it wrote after its last search or read; what it said before ("let me look") is not.
  const lastTool = all.map((b) => /server_tool_use|_tool_result$/.test(b.type)).lastIndexOf(true);
  const after = all.slice(lastTool + 1).filter((b) => b.type === "text");
  const text = (after.length ? after : all.filter((b) => b.type === "text")).map((b) => String(b.text ?? "")).join("");
  return { text, toolCalls: calls, usage, model, pages: pagesOf(all) };
}

const serverName = (n: string): ServerName => (n === "web_fetch" ? "web_fetch" : n === "web_search" ? "web_search" : "code_execution");
