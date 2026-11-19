import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { isPrivateAddress, publicOnlyLookup } from "@workspace/service-kit";
import { docText } from "../documents.js";
import { DOCUMENT_MAX, textOf } from "./extract.js";

/**
 * A link a workflow lists as reference: most companies keep their material in Google Drive or on a web
 * page, so a link is read like a file. A Google Docs, Sheets or Slides link is read through its export address, a
 * Drive file through its download address, any other address as the page or file it serves. Only what anyone with
 * the link can open: there is no sign-in here, so a private document says so and is still listed for steps that have
 * tools (a connected Google Drive) to open it.
 *
 * The fetch is the outside world reaching in, so it is fenced like link previews and webhooks: http(s) only, no
 * credentials, every connection (redirects included) refused when the name resolves to a private, loopback or
 * link-local address, a few seconds per request, a size cap.
 */

export type LinkKind = "gdoc" | "gsheet" | "gslides" | "gdrive" | "gfolder" | "web";
export type LinkProblem = "private" | "folder" | "unreachable" | "unreadable" | "refused";
export type LinkRead = { ok: true; kind: LinkKind; text: string } | { ok: false; kind: LinkKind; problem: LinkProblem };

/** What a link is, and the address its content is fetched from. */
export function linkTarget(raw: string): { kind: LinkKind; fetch: string | null } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { kind: "web", fetch: null };
  }
  const host = u.hostname.toLowerCase();
  const id = /\/d\/([A-Za-z0-9_-]{10,})/.exec(u.pathname)?.[1];
  if (host === "docs.google.com" && id) {
    if (u.pathname.startsWith("/document/")) return { kind: "gdoc", fetch: `https://docs.google.com/document/d/${id}/export?format=txt` };
    if (u.pathname.startsWith("/spreadsheets/")) {
      const gid = /[#&?]gid=(\d+)/.exec(u.hash + u.search)?.[1];
      return { kind: "gsheet", fetch: `https://docs.google.com/spreadsheets/d/${id}/export?format=csv${gid ? `&gid=${gid}` : ""}` };
    }
    if (u.pathname.startsWith("/presentation/")) return { kind: "gslides", fetch: `https://docs.google.com/presentation/d/${id}/export/txt` };
  }
  if (host === "drive.google.com") {
    if (/\/folders\//.test(u.pathname)) return { kind: "gfolder", fetch: null };
    const file = id ?? (/^[A-Za-z0-9_-]{10,}$/.test(u.searchParams.get("id") ?? "") ? u.searchParams.get("id") : null);
    if (file) return { kind: "gdrive", fetch: `https://drive.google.com/uc?export=download&id=${file}` };
  }
  return { kind: "web", fetch: u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null };
}

/** Development and tests only (as for webhooks): fetch from this machine's network too. Never in production. */
const allowPrivate = () => process.env.WEBHOOK_ALLOW_PRIVATE === "1" && process.env.NODE_ENV !== "production";
const TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 5;
const UA = "Mozilla/5.0 (compatible; workspace-workflows/1.0)";

function open(u: URL): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const send = u.protocol === "http:" ? httpRequest : httpsRequest;
    const req = send(
      u,
      // The connection's own lookup refuses private answers, so a rebinding DNS cannot slip past a check made earlier.
      {
        method: "GET",
        timeout: TIMEOUT_MS,
        headers: { "user-agent": UA, accept: "text/*,application/pdf,application/json,*/*;q=0.5" },
        ...(allowPrivate() ? {} : { lookup: publicOnlyLookup }),
      },
      resolve,
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

function body(res: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    res.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        res.destroy();
        reject(new Error("too large"));
      } else chunks.push(c);
    });
    res.on("end", () => resolve(Buffer.concat(chunks)));
    res.on("error", reject);
  });
}

async function fetchLink(raw: string): Promise<{ type: string; name: string; data: Buffer; signIn: boolean } | "refused" | null> {
  let u = new URL(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (u.protocol !== "https:" && !(u.protocol === "http:" && (allowPrivate() || hop === 0))) return "refused";
    if (u.username || u.password) return "refused";
    // A host written as an address never goes through the lookup (Node connects to it directly): check it here.
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (!allowPrivate() && isIP(host) && isPrivateAddress(host)) return "refused";
    // A document nobody shared answers with a redirect to the sign-in page.
    if (u.hostname === "accounts.google.com") return { type: "", name: "", data: Buffer.alloc(0), signIn: true };
    const res = await open(u);
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      u = new URL(res.headers.location, u);
      continue;
    }
    if (status === 401 || status === 403) {
      res.resume();
      return { type: "", name: "", data: Buffer.alloc(0), signIn: true };
    }
    if (status < 200 || status >= 300) {
      res.resume();
      return null;
    }
    const type = String(res.headers["content-type"] ?? "")
      .split(";")[0]!
      .trim()
      .toLowerCase();
    const named = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(String(res.headers["content-disposition"] ?? ""))?.[1];
    const name = named ? decodeURIComponent(named) : (u.pathname.split("/").pop() ?? "");
    return { type, name, data: await body(res, DOCUMENT_MAX), signIn: false };
  }
  return null;
}

/** The page's own words: script, style and markup dropped. */
const pageText = (html: string) => docText(html.replace(/<(script|style|noscript|svg|head)\b[\s\S]*?<\/\1>/gi, " "), "html");

async function read(raw: string): Promise<LinkRead> {
  const target = linkTarget(raw);
  if (target.kind === "gfolder") return { ok: false, kind: target.kind, problem: "folder" };
  if (!target.fetch) return { ok: false, kind: target.kind, problem: "refused" };
  let got: Awaited<ReturnType<typeof fetchLink>>;
  try {
    got = await fetchLink(target.fetch);
  } catch (e) {
    return { ok: false, kind: target.kind, problem: (e as { code?: string }).code === "EPRIVATE" ? "refused" : "unreachable" };
  }
  if (got === "refused") return { ok: false, kind: target.kind, problem: "refused" };
  if (!got) return { ok: false, kind: target.kind, problem: "unreachable" };
  if (got.signIn) return { ok: false, kind: target.kind, problem: "private" };
  const html = got.type === "text/html" || got.type === "application/xhtml+xml";
  // Google answers a file that is not shared with its sign-in page instead of the file.
  if (html && target.kind !== "web" && /accounts\.google\.com|ServiceLogin/i.test(got.data.subarray(0, 20_000).toString("utf8")))
    return { ok: false, kind: target.kind, problem: "private" };
  const text = html ? pageText(got.data.toString("utf8")).trim() : await textOf(got.data, got.name || (got.type === "application/pdf" ? "file.pdf" : "file.txt"), got.type);
  return text ? { ok: true, kind: target.kind, text } : { ok: false, kind: target.kind, problem: "unreadable" };
}

// A run reads its links at every AI step, and the editor checks a link as it is added: read once in ten minutes.
const cache = new Map<string, { at: number; value: LinkRead }>();
const CACHE_MS = 10 * 60_000;

/** A link's text as anyone with the link would read it. Never throws. */
export async function readLink(url: string, fresh = false): Promise<LinkRead> {
  const hit = cache.get(url);
  if (hit && !fresh && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = await read(url).catch((): LinkRead => ({ ok: false, kind: "web", problem: "unreachable" }));
  if (cache.size > 300) cache.clear();
  cache.set(url, { at: Date.now(), value });
  return value;
}

/** Why a link's text is not in the reference block, in words for the model (and the step's input, which people read). */
export const PROBLEM_TEXT: Record<LinkProblem, string> = {
  private: "not shared with anyone who has the link",
  folder: "a folder, not a file",
  unreachable: "did not answer",
  unreadable: "has no text that can be read",
  refused: "not an address that may be opened",
};
