import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { Pool, PoolClient } from "pg";
import { payloadOf, type EventEnvelope } from "@workspace/contracts";
import { isPrivateAddress, logger, publicOnlyLookup } from "@workspace/service-kit";
import { newId } from "@workspace/shared";

/**
 * Link previews: a card (site, title, description, thumbnail) under a message for each of its first three http(s)
 * links. Pages are fetched after the message is posted (the `chat-unfurl` consumer), never in the request path,
 * and once per workspace (the `link_previews` cache: 24 h, a failure 1 h). The fetch is the outside world reaching
 * in, so it is fenced like webhooks: http(s) only, no credentials, every connection (redirects included) refused
 * when the name resolves to a private, loopback or link-local address, 3 s per request, at most 512 KB of HTML
 * (only the head is read) and 256 KB of image (PNG, JPEG, WebP, GIF; never SVG). Thumbnails are stored and served
 * by the server, so the web app's CSP never has to allow images from arbitrary sites.
 */
export const UNFURL_TOPICS = ["workspace.chat.message"];

export interface LinkPreview {
  /** The cache row's id: the thumbnail is `GET /chat/link-previews/:id/image`. */
  id: string;
  url: string;
  siteName: string;
  title: string;
  description: string;
  image: boolean;
}

const MAX_LINKS = 3;
const MAX_HTML = 512 * 1024;
const MAX_IMAGE = 256 * 1024;
const TIMEOUT_MS = 3000;
const MAX_REDIRECTS = 3;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const UA = "Mozilla/5.0 (compatible; workspace-linkpreview/1.0)";

/** Development and tests only (as for webhooks): fetch from this machine's network too. Never in production. */
const allowPrivate = () => process.env.WEBHOOK_ALLOW_PRIVATE === "1" && process.env.NODE_ENV !== "production";

/** The message's first three distinct http(s) links, outside code spans, skipping links into this app itself. */
export function extractLinks(body: string, appUrl = process.env.APP_URL ?? ""): string[] {
  const text = body.replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ");
  const own = (() => {
    try {
      return appUrl ? new URL(appUrl).host : "";
    } catch {
      return "";
    }
  })();
  const out: string[] = [];
  for (const m of text.matchAll(/\bhttps?:\/\/[^\s<>"'`]+/gi)) {
    // Sentence punctuation and a closing bracket the link was wrapped in are not part of it.
    let raw = m[0].replace(/[.,;:!?]+$/, "");
    if (raw.endsWith(")") && !raw.includes("(")) raw = raw.slice(0, -1);
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      continue;
    }
    if (u.username || u.password || (own && u.host === own) || raw.length > 2048) continue;
    u.hash = "";
    const url = u.toString();
    if (!out.includes(url)) out.push(url);
    if (out.length === MAX_LINKS) break;
  }
  return out;
}

interface Fetched {
  url: string;
  type: string;
  body: Buffer;
}

/** One GET, following up to three redirects, each hop checked again; stops reading at `max` bytes (or the head). */
export async function fetchGuarded(raw: string, max: number, accept: (type: string) => boolean, stopAtHead = false): Promise<Fetched> {
  let url = raw;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("only http and https links are previewed");
    if (u.username || u.password) throw new Error("links with credentials are not previewed");
    // A host written as an address never goes through the lookup below (Node connects to it directly): check it here.
    const literal = u.hostname.replace(/^\[|\]$/g, "");
    if (isIP(literal) && isPrivateAddress(literal) && !allowPrivate()) throw new Error("URL points to a private address");
    const res = await open(u);
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.destroy();
      url = new URL(res.headers.location, u).toString();
      continue;
    }
    if (status !== 200) {
      res.destroy();
      throw new Error(`status ${status}`);
    }
    const type = String(res.headers["content-type"] ?? "")
      .split(";")[0]!
      .trim()
      .toLowerCase();
    if (!accept(type)) {
      res.destroy();
      throw new Error(`content type ${type || "missing"}`);
    }
    if (Number(res.headers["content-length"] ?? 0) > max && !stopAtHead) {
      res.destroy();
      throw new Error("too large");
    }
    const body = await readCapped(res, max, stopAtHead);
    return { url, type, body };
  }
  throw new Error("too many redirects");
}

function open(u: URL): Promise<IncomingMessage> {
  const send = u.protocol === "http:" ? httpRequest : httpsRequest;
  return new Promise((resolve, reject) => {
    const req = send(
      u,
      {
        method: "GET",
        timeout: TIMEOUT_MS,
        headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,image/*;q=0.8", "accept-language": "vi,en;q=0.8" },
        // The connection's own lookup refuses private answers, so a rebinding DNS cannot slip past a check made earlier.
        ...(allowPrivate() ? {} : { lookup: publicOnlyLookup }),
      },
      resolve,
    );
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    req.end();
  });
}

function readCapped(res: IncomingMessage, max: number, stopAtHead: boolean): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => res.destroy(new Error("timed out")), TIMEOUT_MS);
    const done = () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    };
    res.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        // HTML: what arrived so far holds the head; an image cut short is useless.
        if (stopAtHead) {
          chunks.push(c.subarray(0, c.length - (size - max)));
          res.destroy();
          return done();
        }
        clearTimeout(timer);
        res.destroy();
        return reject(new Error("too large"));
      }
      chunks.push(c);
      if (stopAtHead && /<\/head\s*>/i.test(c.toString("latin1"))) {
        res.destroy();
        done();
      }
    });
    res.on("end", done);
    res.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (s: string) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n: string) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/\s+/g, " ")
    .trim();

/** OpenGraph, then Twitter cards, then the plain `<title>` and description; relative image URLs resolved. */
export function parseMeta(html: string, pageUrl: string): { siteName: string; title: string; description: string; image: string | null } {
  const head = html.slice(0, MAX_HTML);
  const meta = new Map<string, string>();
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const attr = (n: string) => new RegExp(`\\b${n}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(tag);
    const key = attr("property") ?? attr("name");
    const content = attr("content");
    if (!key || !content) continue;
    const k = (key[2] ?? key[3] ?? key[4] ?? "").toLowerCase();
    if (!meta.has(k)) meta.set(k, decode(content[2] ?? content[3] ?? content[4] ?? ""));
  }
  const title = meta.get("og:title") || meta.get("twitter:title") || decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1] ?? "");
  const description = meta.get("og:description") || meta.get("twitter:description") || meta.get("description") || "";
  const siteName = meta.get("og:site_name") || new URL(pageUrl).hostname.replace(/^www\./, "");
  const rawImage = meta.get("og:image:secure_url") || meta.get("og:image") || meta.get("twitter:image") || meta.get("twitter:image:src") || "";
  let image: string | null = null;
  try {
    image = rawImage ? new URL(rawImage, pageUrl).toString() : null;
  } catch {
    image = null;
  }
  return { siteName: siteName.slice(0, 100), title: title.slice(0, 300), description: description.slice(0, 500), image };
}

const charsetOf = (html: Buffer, type: string) => {
  const head = html.subarray(0, 2048).toString("latin1");
  return (/charset=["']?([\w-]+)/i.exec(type)?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ?? "utf-8").toLowerCase();
};

/** Fetches and parses one page (and its thumbnail). Throws when there is nothing worth showing. */
export async function unfurl(url: string): Promise<{ siteName: string; title: string; description: string; image: { data: Buffer; type: string } | null }> {
  const page = await fetchGuarded(url, MAX_HTML, (t) => t === "text/html" || t === "application/xhtml+xml", true);
  let text: string;
  try {
    text = new TextDecoder(charsetOf(page.body, page.type)).decode(page.body);
  } catch {
    text = page.body.toString("utf8");
  }
  const meta = parseMeta(text, page.url);
  if (!meta.title) throw new Error("no title");
  let image: { data: Buffer; type: string } | null = null;
  if (meta.image) {
    try {
      const img = await fetchGuarded(meta.image, MAX_IMAGE, (t) => IMAGE_TYPES.has(t));
      if (img.body.length > 0) image = { data: img.body, type: img.type };
    } catch (err) {
      logger.debug({ err, url: meta.image }, "link preview image skipped");
    }
  }
  return { siteName: meta.siteName, title: meta.title, description: meta.description, image };
}

/** A cached preview when fresh (24 h; a failure 1 h), else fetched now and stored. Null when the page has none. */
async function previewFor(c: PoolClient, url: string, fetch = unfurl): Promise<LinkPreview | null> {
  const hit = (
    await c.query<{ id: string; ok: boolean; site_name: string; title: string; description: string; has_image: boolean }>(
      `SELECT id, ok, site_name, title, description, image IS NOT NULL AS has_image FROM link_previews
        WHERE url = $1 AND fetched_at > now() - CASE WHEN ok THEN interval '24 hours' ELSE interval '1 hour' END`,
      [url],
    )
  ).rows[0];
  if (hit) return hit.ok ? { id: hit.id, url, siteName: hit.site_name, title: hit.title, description: hit.description, image: hit.has_image } : null;
  let got: Awaited<ReturnType<typeof unfurl>> | null = null;
  try {
    got = await fetch(url);
  } catch (err) {
    logger.debug({ err, url }, "no link preview");
  }
  const r = await c.query<{ id: string }>(
    `INSERT INTO link_previews (url, id, ok, site_name, title, description, image, image_type, fetched_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
     ON CONFLICT (url) DO UPDATE SET ok = EXCLUDED.ok, site_name = EXCLUDED.site_name, title = EXCLUDED.title,
       description = EXCLUDED.description, image = EXCLUDED.image, image_type = EXCLUDED.image_type, fetched_at = now()
     RETURNING id`,
    [url, newId(), !!got, got?.siteName ?? "", got?.title ?? "", got?.description ?? "", got?.image?.data ?? null, got?.image?.type ?? null],
  );
  if (!got) return null;
  return { id: r.rows[0]!.id, url, siteName: got.siteName, title: got.title, description: got.description, image: !!got.image };
}

/**
 * The `chat-unfurl` consumer: previews for a posted or edited message, written on the message and pushed to the
 * conversation. Imported history and system notices get none; a message whose author hid its previews keeps none.
 */
export async function handleUnfurlEvent(
  e: EventEnvelope,
  c: PoolClient,
  push: (channelId: string, data: { messageId: string; channelId: string; linkPreviews: LinkPreview[] }) => void,
  fetch = unfurl,
): Promise<void> {
  let messageId: string;
  let channelId: string;
  let body: string;
  if (e.eventType === "chat.message.created.v1") {
    const p = payloadOf(e, "chat.message.created.v1");
    if (p.authorType === "import" || p.authorType === "system") return;
    ({ messageId, channelId, body } = p);
  } else if (e.eventType === "chat.message.updated.v1") {
    ({ messageId, channelId, body } = payloadOf(e, "chat.message.updated.v1"));
  } else return;
  const links = extractLinks(body);
  const row = (
    await c.query<{ previews_hidden: boolean; link_previews: LinkPreview[] }>("SELECT previews_hidden, link_previews FROM messages WHERE id = $1 AND deleted_at IS NULL", [
      messageId,
    ])
  ).rows[0];
  if (!row || row.previews_hidden) return;
  // An edit that removed every link clears the cards; unchanged links reuse the cache.
  const previews = (await Promise.all(links.map((u) => previewFor(c, u, fetch)))).filter((x): x is LinkPreview => !!x);
  if (!previews.length && !row.link_previews.length) return;
  await c.query("UPDATE messages SET link_previews = $2 WHERE id = $1", [messageId, JSON.stringify(previews)]);
  push(channelId, { messageId, channelId, linkPreviews: previews });
}

/** Cached pages nobody used for 30 days (a SECURITY DEFINER function, like the other prunes). */
export async function pruneLinkPreviews(pool: Pool): Promise<number> {
  let total = 0;
  for (;;) {
    const n = (await pool.query<{ n: number }>("SELECT chat_link_previews_prune($1) AS n", [1000])).rows[0]?.n ?? 0;
    total += n;
    if (n < 1000) return total;
  }
}
