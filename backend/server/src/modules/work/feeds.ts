import { createHash, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import type { Principal } from "@workspace/shared";
import { workspaceLocale } from "./settings.js";

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

/** Creates (or replaces, which revokes the old link) my private calendar subscription token. */
export async function createFeed(c: PoolClient, p: Principal): Promise<string> {
  const token = randomBytes(24).toString("base64url");
  await c.query(
    `INSERT INTO calendar_feeds (user_id, token_hash) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, created_at = now()`,
    [p.id, hash(token)],
  );
  return token;
}

export async function deleteFeed(c: PoolClient, p: Principal): Promise<void> {
  await c.query("DELETE FROM calendar_feeds WHERE user_id = $1", [p.id]);
}

export async function hasFeed(c: PoolClient, p: Principal): Promise<boolean> {
  return (await c.query("SELECT 1 FROM calendar_feeds WHERE user_id = $1", [p.id])).rowCount === 1;
}

/** Who a subscription token belongs to, or null. */
export async function feedOwner(c: PoolClient, token: string): Promise<{ userId: string } | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const r = (await c.query<{ user_id: string }>("SELECT user_id FROM calendar_feeds WHERE token_hash = $1", [hash(token)])).rows[0];
  return r ? { userId: r.user_id } : null;
}

// ---- iCalendar (RFC 5545) ----

const esc = (s: string) =>
  s
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/[,;]/g, (m) => `\\${m}`);
const stamp = (d: Date) =>
  d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
/** Lines longer than 75 octets continue on the next line after a space (multi-byte safe). */
export function foldLine(line: string): string {
  const out: string[] = [];
  let cur = "";
  let bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = "";
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}

const FEED_TEXT = {
  vi: { open: "Mở trong workspace (chương trình, biên bản, phòng họp video)" },
  en: { open: "Open in workspace (agenda, minutes, video room)" },
} as const;

/** The person's meetings from a month ago to six months ahead (not the ones they declined). */
export async function feedIcs(c: PoolClient, userId: string, appUrl: string): Promise<string> {
  const rows = (
    await c.query<{ id: string; title: string; starts_at: Date; ends_at: Date; location: string | null; updated_at: Date | null; agenda: string | null }>(
      `SELECT e.id, e.title, e.starts_at, e.ends_at, e.location, e.created_at AS updated_at, NULL::text AS agenda
         FROM calendar_events e JOIN event_attendees a ON a.event_id = e.id
        WHERE a.user_id = $1 AND a.response IS DISTINCT FROM 'declined'
          AND e.starts_at > now() - interval '30 days' AND e.starts_at < now() + interval '180 days'
        ORDER BY e.starts_at LIMIT 1000`,
      [userId],
    )
  ).rows;
  const now = stamp(new Date());
  // A calendar app polls this with no person's language attached: the text follows the workspace's.
  const locale = await workspaceLocale(c);
  const t = FEED_TEXT[locale];
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//workspace//Calendar//${locale.toUpperCase()}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:workspace",
    "X-PUBLISHED-TTL:PT1H",
  ];
  for (const e of rows) {
    const url = `${appUrl}/app/work/meetings/${e.id}`;
    lines.push(
      "BEGIN:VEVENT",
      `UID:${e.id}@workspace`,
      `DTSTAMP:${now}`,
      `DTSTART:${stamp(e.starts_at)}`,
      `DTEND:${stamp(e.ends_at)}`,
      `SUMMARY:${esc(e.title)}`,
      ...(e.location ? [`LOCATION:${esc(e.location)}`] : []),
      `DESCRIPTION:${esc(`${t.open}: ${url}`)}`,
      `URL:${url}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}
