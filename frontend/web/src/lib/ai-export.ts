import type { ImportRow } from "./ai-import";

/**
 * Reading a whole chat-history export (ChatGPT's "Export data" / Team workspace export, Claude's Team export) in the
 * browser and turning it into import rows: one row per conversation per day, counting the person's own messages that
 * day. Only the first prompt of each day travels to the server (it decides from the read policy whether to keep it);
 * the rest of the history never leaves the browser.
 */

export type ExportKind = "chatgpt" | "claude";
export interface ExportResult {
  kind: ExportKind;
  conversations: number;
  rows: ImportRow[];
  /** Rows the export does not tie to an email (a personal export); the admin assigns them to one person. */
  unassigned: number;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const PROMPT_CHARS = 2000;

interface Msg {
  at: Date;
  text: string;
}
interface Conv {
  title: string;
  email?: string;
  model?: string;
  msgs: Msg[];
}

/** "1730000000.123" seconds, ISO strings, or milliseconds as a Date; null when unreadable. */
function when(v: unknown): Date | null {
  if (typeof v === "number") return new Date(v > 1e12 ? v : v * 1000);
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function chatgptConvs(list: Json[], users: unknown): Conv[] {
  // A personal export carries one user (user.json / users.json); a workspace export may name the owner per conversation.
  const single = obj(users) ? str(users.email) : Array.isArray(users) && users.length === 1 && obj(users[0]) ? str(users[0].email) : undefined;
  return list.map((c) => {
    const msgs: Msg[] = [];
    let model: string | undefined;
    const mapping = obj(c.mapping) ? c.mapping : {};
    for (const node of Object.values(mapping)) {
      const m = obj(node) && obj(node.message) ? node.message : null;
      if (!m || !obj(m.author) || m.author.role !== "user") continue;
      const at = when(m.create_time) ?? when(c.create_time);
      if (!at) continue;
      const content = obj(m.content) ? m.content : {};
      const text = Array.isArray(content.parts) ? content.parts.filter((p) => typeof p === "string").join("\n") : (str(content.text) ?? "");
      msgs.push({ at, text });
      if (!model && obj(m.metadata)) model = str(m.metadata.model_slug);
    }
    const owner = obj(c.user) ? str(c.user.email) : undefined;
    return { title: str(c.title) ?? "", email: str(c.user_email) ?? str(c.email) ?? owner ?? single, model: model ?? str(c.default_model_slug), msgs };
  });
}

function claudeConvs(list: Json[], users: unknown): Conv[] {
  const byId = new Map<string, string>();
  if (Array.isArray(users)) for (const u of users) if (obj(u) && str(u.uuid) && str(u.email_address)) byId.set(str(u.uuid)!, str(u.email_address)!);
  const single = byId.size === 1 ? [...byId.values()][0] : undefined;
  return list.map((c) => {
    const msgs: Msg[] = [];
    for (const m of Array.isArray(c.chat_messages) ? c.chat_messages : []) {
      if (!obj(m) || m.sender !== "human") continue;
      const at = when(m.created_at) ?? when(c.created_at);
      if (!at) continue;
      const parts = Array.isArray(m.content)
        ? m.content
            .filter(obj)
            .map((p) => str(p.text) ?? "")
            .join("\n")
        : "";
      msgs.push({ at, text: str(m.text) || parts });
    }
    const account = obj(c.account) ? str(c.account.uuid) : undefined;
    return { title: str(c.name) ?? "", email: (account && byId.get(account)) || single, msgs };
  });
}

/** Which export a parsed conversations.json is, from the shape of its first conversation. */
export function exportKind(data: unknown): ExportKind | null {
  if (!Array.isArray(data) || !data.length || !obj(data[0])) return null;
  if ("mapping" in data[0]) return "chatgpt";
  if ("chat_messages" in data[0]) return "claude";
  return null;
}

/** Conversations → import rows, one per conversation and UTC day with the person's message count. */
export function exportRows(kind: ExportKind, conversations: unknown, users?: unknown): ExportResult {
  const list = (Array.isArray(conversations) ? conversations : []).filter(obj);
  const convs = kind === "chatgpt" ? chatgptConvs(list, users) : claudeConvs(list, users);
  const rows: ImportRow[] = [];
  let unassigned = 0;
  for (const c of convs) {
    const days = new Map<string, Msg[]>();
    for (const m of [...c.msgs].sort((a, b) => a.at.getTime() - b.at.getTime())) {
      const k = m.at.toISOString().slice(0, 10);
      days.set(k, [...(days.get(k) ?? []), m]);
    }
    for (const msgs of days.values()) {
      const first = msgs[0]!;
      const row: ImportRow = { at: first.at.toISOString(), tool: kind, count: msgs.length };
      if (c.email) row.email = c.email;
      else unassigned++;
      if (c.model) row.model = c.model.slice(0, 80);
      if (c.title) row.title = c.title.slice(0, 500);
      const prompt = first.text.trim();
      if (prompt) row.prompt = prompt.slice(0, PROMPT_CHARS);
      rows.push(row);
    }
  }
  return { kind, conversations: convs.length, rows, unassigned };
}

/** A zip (or a bare conversations.json) as an export; null when the file is not one. fflate loads only for zips. */
export async function readExport(name: string, bytes: Uint8Array): Promise<ExportResult | null> {
  let conversations: unknown;
  let users: unknown;
  const zip = /\.zip$/i.test(name) || (bytes[0] === 0x50 && bytes[1] === 0x4b);
  if (zip) {
    const { unzipSync, strFromU8 } = await import("fflate");
    const files = unzipSync(bytes, { filter: (f) => /(^|\/)(conversations|users?)\.json$/i.test(f.name) });
    for (const [path, data] of Object.entries(files)) {
      const json: unknown = JSON.parse(strFromU8(data));
      if (/conversations\.json$/i.test(path)) conversations = json;
      else users = json;
    }
  } else {
    if (!/^\s*\[/.test(new TextDecoder().decode(bytes.slice(0, 64)))) return null;
    conversations = JSON.parse(new TextDecoder().decode(bytes));
  }
  const kind = exportKind(conversations);
  return kind ? exportRows(kind, conversations, users) : null;
}

/** Rows with no email get the person the admin picked. */
export function assignRows(rows: ImportRow[], email: string): ImportRow[] {
  const e = email.trim();
  return e ? rows.map((r) => (r.email ? r : { ...r, email: e })) : rows.filter((r) => r.email);
}
