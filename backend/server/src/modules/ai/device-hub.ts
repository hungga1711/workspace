import { newId } from "@workspace/shared";
import { ProviderError } from "./gateway.js";
import { imagesRefused, stoppedAnswer, streamOf, type ModelBackend, type ModelRequest, type ModelResponse } from "./providers.js";
import { visibleText } from "./stream.js";

/**
 * Questions on their way to the AI on someone's computer. workspace-connect.mjs there keeps one request open
 * (`claim`); a question is handed to it at once and its answer comes back with `finish`. While it writes, a program
 * that streams sends the answer so far (`part`), and is told there to stop when the person pressed stop. Kept in
 * memory: the backend is one process (ADR 0021), and a question that outlives a restart has nobody waiting for it.
 */
export interface DeviceJob {
  id: string;
  /** "<ai id>" or "<ai id>:<model>" from the connect program's registries. */
  target: string;
  system: string;
  prompt: string;
  maxTokens: number;
  /** Someone watches the answer come: send it as it is written (`part`). Older programs ignore this and answer at the end. */
  stream?: boolean;
  /**
   * The question needs the web (web-need.ts): the agent may search and read pages with its own web tools, never its
   * file or shell tools. Older programs ignore this and answer without the web.
   */
  web?: { search?: boolean; fetch?: boolean };
  /**
   * The images attached to the question (base64, already downscaled in the browser). A program that cannot hand them
   * to its AI answers with an error naming that, never as if nothing was attached; older programs ignore this.
   */
  images?: { mediaType: string; data: string }[];
}
export interface DeviceResult {
  text?: string | undefined;
  error?: string | undefined;
  model?: string | undefined;
  usage?: { input: number; output: number } | null | undefined;
  /** The person pressed stop: the answer is whatever came through `part` until then. */
  stopped?: boolean;
  /** The agent's own web tools it used (WebSearch, WebFetch), with what it searched or read. */
  tools?: { name: string; input: Record<string, unknown> }[] | undefined;
  /** The pages they found or read, cited with the answer. */
  pages?: { url: string; title: string }[] | undefined;
}

interface Waiting extends DeviceJob {
  done: (r: DeviceResult) => void;
  part?: ((raw: string) => void) | undefined;
}

const queues = new Map<string, Waiting[]>();
const claimers = new Map<string, (job: DeviceJob | null) => void>();
const running = new Map<string, Waiting>();
const seen = new Map<string, number>();
/** Jobs stopped while the computer was still writing: its next `part` is told to stop. Kept a little while only. */
const stopped = new Map<string, number>();

export const deviceKey = (userId: string, device: string) => `${userId}\n${device}`;
/** The program polls every 25 s at most; a minute and a half of silence means the computer is asleep or off. */
export const deviceOnline = (key: string, now = Date.now()) => now - (seen.get(key) ?? 0) < 90_000;
export const touchDevice = (key: string) => void seen.set(key, Date.now());

/** The connect program's long poll: the next question, or null after `waitMs`. */
export function claimJob(key: string, waitMs: number): Promise<DeviceJob | null> {
  touchDevice(key);
  const strip = ({ done: _done, part: _part, ...job }: Waiting): DeviceJob => job;
  const next = queues.get(key)?.shift();
  if (next) {
    running.set(next.id, next);
    return Promise.resolve(strip(next));
  }
  // One poll per computer: a second one (the program restarted) replaces the first.
  claimers.get(key)?.(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (claimers.get(key) === give) claimers.delete(key);
      resolve(null);
    }, waitMs);
    const give = (job: DeviceJob | null) => {
      clearTimeout(timer);
      if (claimers.get(key) === give) claimers.delete(key);
      touchDevice(key);
      resolve(job);
    };
    claimers.set(key, give);
  });
}

export function finishJob(id: string, result: DeviceResult): boolean {
  const job = running.get(id);
  if (!job) return false;
  running.delete(id);
  job.done(result);
  return true;
}

/** The answer so far from a computer that streams. `stop`: the person pressed stop, so it should end there. */
export function partJob(id: string, raw: string): { ok: boolean; stop: boolean } {
  if (stopped.has(id)) return { ok: false, stop: true };
  const job = running.get(id);
  if (!job) return { ok: false, stop: false };
  job.part?.(raw);
  return { ok: true, stop: false };
}

export function askDevice(key: string, job: Omit<DeviceJob, "id">, timeoutMs: number, live: { part?: (raw: string) => void; signal?: AbortSignal } = {}): Promise<DeviceResult> {
  return new Promise((resolve) => {
    const id = newId();
    const drop = () => {
      running.delete(id);
      const q = queues.get(key);
      if (q)
        queues.set(
          key,
          q.filter((x) => x.id !== id),
        );
    };
    const timer = setTimeout(() => {
      drop();
      resolve({ error: "timeout" });
    }, timeoutMs);
    const onStop = () => {
      clearTimeout(timer);
      // Still writing: its next `part` hears it, and the computer stops its AI.
      if (running.has(id)) {
        for (const [k, at] of stopped) if (Date.now() - at > 5 * 60_000) stopped.delete(k);
        stopped.set(id, Date.now());
      }
      drop();
      resolve({ stopped: true });
    };
    if (live.signal?.aborted) return onStop();
    live.signal?.addEventListener("abort", onStop, { once: true });
    const waiting: Waiting = {
      ...job,
      id,
      part: live.part,
      done: (r) => {
        clearTimeout(timer);
        live.signal?.removeEventListener("abort", onStop);
        resolve(r);
      },
    };
    const give = claimers.get(key);
    if (give) {
      running.set(id, waiting);
      // The whole job, as a queued one is handed over (claimJob): a field listed here by hand is easily left out.
      give({ ...job, id });
    } else queues.set(key, [...(queues.get(key) ?? []), waiting]);
  });
}

/** Tests only. */
export function resetDeviceHub() {
  queues.clear();
  claimers.clear();
  running.clear();
  seen.clear();
  stopped.clear();
}

export const deviceUrl = (userId: string, device: string, ai: string) => `device://${encodeURIComponent(userId)}/${encodeURIComponent(device)}/${encodeURIComponent(ai)}`;
export function parseDeviceUrl(url: string | null): { userId: string; device: string; ai: string } | null {
  const m = /^device:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(url ?? "");
  return m ? { userId: decodeURIComponent(m[1]!), device: decodeURIComponent(m[2]!), ai: decodeURIComponent(m[3]!) } : null;
}

/** A conversation as one prompt: a command-line agent takes text, not a list of turns. */
export function flatten(req: Pick<ModelRequest, "messages">): string {
  const turns = req.messages.filter((m) => m.content.trim());
  if (turns.length <= 1) return turns[0]?.content ?? "";
  const last = turns[turns.length - 1]!;
  const before = turns.slice(0, -1).map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${m.content}`);
  return `The conversation so far:\n${before.join("\n\n")}\n\nAnswer the user's next message.\n\nUser: ${last.content}`;
}

/**
 * The AI on a connected computer as a gateway backend (Admin › AI, mode "device"). Tools are not passed on, so the
 * assistant uses it the way it uses a small model that cannot call tools; the question's images are (DeviceJob.images).
 */
export class DeviceBackend implements ModelBackend {
  readonly name = "device";
  private readonly at: { userId: string; device: string; ai: string } | null;

  constructor(
    baseUrl: string | null,
    private readonly timeoutMs = 110_000,
  ) {
    this.at = parseDeviceUrl(baseUrl);
  }

  async call(model: string, req: ModelRequest): Promise<ModelResponse> {
    if (!this.at) throw new ProviderError("device: the connection does not name a computer", 400, false);
    const key = deviceKey(this.at.userId, this.at.device);
    // Not retriable on this backend, so the gateway moves on to the next one (or the built-in fallback) at once.
    if (!deviceOnline(key)) throw new ProviderError(`offline: the computer “${this.at.device}” is not connected right now`, 503, false);
    const prompt = flatten(req);
    // The model is the AI's own id when the connection names no model of its own (a command-line agent).
    const target = model && model !== this.at.ai ? `${this.at.ai}:${model}` : this.at.ai;
    const live = streamOf(req);
    // What the person has seen so far: the program sends the whole answer each time, reasoning included.
    let shown = "";
    const part = (raw: string) => {
      const now = visibleText(raw);
      if (now === shown) return;
      if (now.startsWith(shown)) live!.text(now.slice(shown.length));
      else {
        live!.reset();
        live!.text(now);
      }
      shown = now;
    };
    // The agent's own web tools only (never files or a shell); a code sandbox it does not have.
    const web = req.web && (req.web.search || req.web.fetch) ? { ...(req.web.search ? { search: true } : {}), ...(req.web.fetch ? { fetch: true } : {}) } : null;
    // The question's own images: earlier ones are named in the conversation's text (assistant-input.ts).
    const images = imagesOfQuestion(req);
    const r = await askDevice(
      key,
      {
        target,
        system: req.system,
        prompt,
        maxTokens: req.maxTokens,
        ...(live ? { stream: true } : {}),
        ...(web ? { web } : {}),
        ...(images.length ? { images } : {}),
      },
      this.timeoutMs,
      live ? { part, signal: live.signal } : {},
    );
    if (r.stopped) return stoppedAnswer(req, shown, model || this.at.ai);
    if (r.error === "timeout") throw new ProviderError(`timeout: the computer “${this.at.device}” did not answer in time`, 504, false);
    // An AI there that cannot read images: said as such, so the person is told to remove them or pick another model.
    if (r.error && images.length && imagesRefused(new Error(r.error))) throw new ProviderError(`device: ${r.error}`, 400, false);
    if (r.error || !r.text) throw new ProviderError(`device: ${r.error ?? "empty answer"}`, 502, false);
    return {
      text: r.text,
      toolCalls: [],
      // A command-line agent does not report tokens here: a rough count (4 characters a token) keeps the usage log honest about size.
      usage: { inputTokens: r.usage?.input ?? Math.ceil((req.system.length + prompt.length) / 4), outputTokens: r.usage?.output ?? Math.ceil(r.text.length / 4) },
      model: r.model || model,
      ...(r.tools?.length ? { serverTools: deviceWebTools(r.tools) } : {}),
      ...(r.pages?.length ? { pages: r.pages.filter((x) => /^https?:\/\//i.test(x.url)).slice(0, 8) } : {}),
    };
  }
}

/**
 * The images of the question being answered, as the connect program takes them. Only the question itself carries
 * images (earlier turns name theirs in text), and it is not always the last user turn: a model without tool calling
 * gets the tool results as user turns after it (mcp/loop.ts).
 */
export function imagesOfQuestion(req: Pick<ModelRequest, "messages">): { mediaType: string; data: string }[] {
  const asked = [...req.messages].reverse().find((m) => m.role === "user" && m.images?.length);
  return (asked?.images ?? []).map((i) => ({ mediaType: i.mediaType, data: i.data }));
}

/** The agent's web tool uses as the answer reports them: WebSearch and WebFetch, nothing else. */
export function deviceWebTools(tools: { name: string; input: Record<string, unknown> }[]): NonNullable<ModelResponse["serverTools"]> {
  return tools.slice(0, 20).flatMap((t): NonNullable<ModelResponse["serverTools"]> => {
    const query = typeof t.input?.query === "string" ? t.input.query.slice(0, 200) : undefined;
    const url = typeof t.input?.url === "string" ? t.input.url.slice(0, 500) : undefined;
    if (t.name === "WebSearch") return [{ name: "web_search" as const, input: query ? { query } : {} }];
    if (t.name === "WebFetch") return [{ name: "web_fetch" as const, input: url ? { url } : {} }];
    return [];
  });
}
