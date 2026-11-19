import { createHash } from "node:crypto";

/**
 * The audit trail's privacy rules (ADR 0025): what never lands in `audit_trail`, whatever a producer sends.
 *
 * - Content people write to each other or to an AI: message and thread bodies, page and whiteboard text, comments,
 *   task and project descriptions, notes and reasons, prompts and answers, quotes, search queries.
 * - Secrets: passwords, tokens, keys, secrets, codes.
 * - File contents (never on an event anyway).
 *
 * Keys are matched case-insensitively on their last word ("clientSecret", "bodyText", "previewText"…), at any depth.
 */
const PRIVATE_KEYS = [
  "body",
  "text",
  "content",
  "html",
  "markdown",
  "description",
  "details",
  "detail",
  "note",
  "notes",
  "reason",
  "comment",
  "quote",
  "prompt",
  "answer",
  "answers",
  "question",
  "questions",
  "message",
  "messages",
  "query",
  "q",
  "summary",
  "transcript",
  "topic",
  "password",
  "passcode",
  "token",
  "secret",
  "apikey",
  "key",
  "verifier",
  "otp",
  "totp",
  "recovery",
  "cookie",
  "authorization",
  "scene",
  "snapshot",
  "toolcalls",
  "input",
  "output",
];

const PRIVATE = new Set(PRIVATE_KEYS);

/** Ids of things are kept even when their name ends in a private word ("messageId", "commentId", "keyId"). */
const isIdKey = (k: string) => /(Id|Ids|_id|_ids)$/.test(k);

export function isPrivateKey(key: string): boolean {
  if (isIdKey(key)) return false;
  // camelCase / snake_case words: "clientSecret" → secret, "body_text" → text, "apiKey" → key.
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[\s_.-]+/)
    .filter(Boolean);
  return PRIVATE.has(key.toLowerCase()) || words.some((w) => PRIVATE.has(w));
}

const MAX_STRING = 200;
const MAX_ARRAY = 50;
const MAX_DEPTH = 4;

/**
 * A copy of `value` without private keys, long strings clipped, arrays and depth bounded: what may be stored as an
 * entry's `meta` or `changes`.
 */
export function scrub(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_DEPTH) return null;
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map((v) => scrub(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isPrivateKey(k) || v === undefined) continue;
      out[k] = scrub(v, depth + 1);
    }
    return out;
  }
  return null;
}

export const scrubRecord = (v: unknown): Record<string, unknown> => {
  const s = scrub(v ?? {});
  return s && typeof s === "object" && !Array.isArray(s) ? (s as Record<string, unknown>) : {};
};

/** A private field's fingerprint: enough to say it changed, never what it says. */
export const fingerprint = (v: unknown): string | null =>
  v === null || v === undefined || v === ""
    ? null
    : createHash("sha256")
        .update(typeof v === "string" ? v : JSON.stringify(v))
        .digest("base64url")
        .slice(0, 16);

/** A conversation as the trail may name it: a public channel by name, anything else only by kind. */
export function channelLabel(kind: string | null | undefined, name: string | null | undefined): string | null {
  return kind === "public" && name ? `#${name}` : null;
}
