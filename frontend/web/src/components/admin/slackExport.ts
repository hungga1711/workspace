import { unzipSync, strFromU8 } from "fflate";
import { foldKey } from "@/components/work/importTasks";

export interface SlackChannelPlan {
  name: string;
  topic: string;
  messages: { key: string; threadKey: string | null; at: string; text: string; userId: string | null; authorName: string }[];
  truncated: boolean;
}
export interface SlackPlan {
  channels: SlackChannelPlan[];
  people: number;
  matched: number;
}

const MAX = 5000;
interface SUser {
  id: string;
  name?: string;
  real_name?: string;
  profile?: { email?: string; real_name?: string; display_name?: string };
}
interface SMsg {
  type?: string;
  subtype?: string;
  user?: string;
  username?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
}

const json = <T>(files: Record<string, Uint8Array>, path: string): T | null => {
  const f = files[path];
  if (!f) return null;
  try {
    return JSON.parse(strFromU8(f)) as T;
  } catch {
    return null;
  }
};

/** Slack markup to plain text: user and channel links, URLs, and HTML entities. */
export function slackText(text: string, nameOf: (id: string) => string): string {
  return text
    .replace(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g, (_m, id: string) => `@${nameOf(id)}`)
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
    .replace(/<!(here|channel|everyone)>/g, "@$1")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Reads a Slack workspace export (.zip) and maps its people onto this workspace by email or name. */
export function planSlack(zip: ArrayBuffer, people: { userId: string; displayName: string; email: string }[]): SlackPlan {
  const files = unzipSync(new Uint8Array(zip));
  const users = json<SUser[]>(files, "users.json") ?? [];
  const channels = json<{ name: string; purpose?: { value?: string }; topic?: { value?: string } }[]>(files, "channels.json") ?? [];
  const byKey = new Map<string, string>();
  for (const p of people) {
    if (p.email) byKey.set(foldKey(p.email), p.userId);
    byKey.set(foldKey(p.displayName), p.userId);
  }
  const who = new Map<string, { name: string; userId: string | null }>();
  for (const u of users) {
    const name = u.profile?.real_name || u.real_name || u.profile?.display_name || u.name || u.id;
    const userId = (u.profile?.email && byKey.get(foldKey(u.profile.email))) || byKey.get(foldKey(name)) || null;
    who.set(u.id, { name, userId });
  }
  const nameOf = (id: string) => who.get(id)?.name ?? id;
  const out: SlackChannelPlan[] = [];
  for (const ch of channels) {
    const days = Object.keys(files)
      .filter((f) => f.startsWith(`${ch.name}/`) && f.endsWith(".json"))
      .sort();
    let messages: SlackChannelPlan["messages"] = [];
    for (const d of days) {
      for (const m of json<SMsg[]>(files, d) ?? []) {
        if (m.type !== "message" || !m.ts || !m.text?.trim()) continue;
        if (m.subtype && !["bot_message", "thread_broadcast", "file_share", "me_message"].includes(m.subtype)) continue; // joins, leaves, renames
        const author = m.user ? who.get(m.user) : undefined;
        messages.push({
          key: m.ts,
          threadKey: m.thread_ts ?? null,
          at: new Date(Number(m.ts) * 1000).toISOString(),
          text: slackText(m.text, nameOf).slice(0, 20000),
          userId: author?.userId ?? null,
          authorName: author?.name ?? m.username ?? "Slack",
        });
      }
    }
    messages.sort((a, b) => Number(a.key) - Number(b.key));
    const truncated = messages.length > MAX;
    if (truncated) messages = messages.slice(-MAX);
    out.push({ name: ch.name, topic: ch.purpose?.value || ch.topic?.value || "", messages, truncated });
  }
  return { channels: out, people: users.length, matched: [...who.values()].filter((w) => w.userId).length };
}
