import { parseCsv } from "./csv";

/**
 * "Nhập từ bảng điều khiển nhà cung cấp": reading an AI provider's usage or compliance export in the browser
 * (CSV or JSON), guessing which column is which, and turning rows into what POST ai/insights/imports takes.
 * The file never goes to the server as is: only the mapped fields of each row do.
 */

export const IMPORT_FIELDS = ["email", "userId", "at", "tool", "model", "title", "prompt", "count", "tokens", "cost"] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];
export type Mapping = Partial<Record<ImportField, string>>;
export interface ImportRow {
  email?: string;
  userId?: string;
  at: string;
  tool?: string;
  model?: string;
  title?: string;
  prompt?: string;
  count?: number;
  tokens?: number;
  cost?: number;
}

export interface Table {
  format: "csv" | "json";
  headers: string[];
  records: Record<string, string>[];
}

/** Header names seen in exports, normalised (lower case, letters and digits only), per field; first match wins. */
const GUESS: [ImportField, RegExp][] = [
  ["email", /^(user)?e?mail(address)?$|^useremail$|^actoremail$|^owneremail$|^email/],
  ["userId", /^(user|member|actor)id$/],
  ["at", /^(timestamp|time|date|datetime|createdat|created|occurredat|eventtime|day|usagedate|lastactive|lastactivity)$/],
  ["tool", /^(tool|product|app|application|client|source|surface|feature|service)$/],
  ["model", /^(model|modelname|modelid|engine)$/],
  ["title", /^(title|conversationtitle|name|subject|conversationname|chattitle)$/],
  ["prompt", /^(prompt|message|content|text|input|query|request|usermessage)$/],
  ["count", /^(count|messages|messagecount|nummessages|requests|requestcount|prompts|conversations|interactions)$/],
  ["tokens", /^(tokens|totaltokens|tokencount|usagetokens|inputtokens)$/],
  ["cost", /^(cost|costusd|amount|amountusd|spend|price|usd)$/],
];
const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

export function guessMapping(headers: string[]): Mapping {
  const out: Mapping = {};
  const used = new Set<string>();
  for (const [field, re] of GUESS) {
    const h = headers.find((x) => !used.has(x) && re.test(norm(x)));
    if (h) {
      out[field] = h;
      used.add(h);
    }
  }
  return out;
}

/** A JSON export: an array of rows, or an object whose first array property holds them; nested objects flatten to "a.b". */
function parseJsonRecords(text: string): Record<string, string>[] {
  const data: unknown = JSON.parse(text);
  const list = Array.isArray(data) ? data : data && typeof data === "object" ? Object.values(data).find(Array.isArray) : null;
  if (!Array.isArray(list)) return [];
  return list.filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x)).map((x) => flatten(x));
}
function flatten(o: Record<string, unknown>, prefix = "", out: Record<string, string> = {}, depth = 0): Record<string, string> {
  for (const [k, v] of Object.entries(o)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v) && depth < 2) flatten(v as Record<string, unknown>, key, out, depth + 1);
    else if (v !== null && v !== undefined) out[key] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  return out;
}

/** A file's text as a table, whichever of the two formats it is (decided by the name, then by the first character). */
export function readTable(name: string, text: string): Table {
  const json = /\.json$/i.test(name) || /^\s*[[{]/.test(text);
  if (json) {
    const records = parseJsonRecords(text);
    const headers = [...new Set(records.slice(0, 200).flatMap((r) => Object.keys(r)))];
    return { format: "json", headers, records };
  }
  const [head = [], ...rows] = parseCsv(text);
  const headers = head.map((h, i) => h.trim() || `#${i + 1}`);
  return { format: "csv", headers, records: rows.map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? "").trim()]))) };
}

/** "1.234,5" and "1,234.5" and "$0.02" as numbers; anything else is left out. */
export function parseNumber(v: string | undefined): number | undefined {
  if (!v) return undefined;
  let s = v.replace(/[^\d.,-]/g, "");
  if (/,\d{1,2}$/.test(s) && s.includes(".")) s = s.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, "");
  else s = s.replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) && s !== "" ? n : undefined;
}

/** The rows to send: mapped fields only, numbers parsed; rows without a time or a person are dropped here already. */
export function toImportRows(records: Record<string, string>[], m: Mapping): ImportRow[] {
  const get = (r: Record<string, string>, f: ImportField) => (m[f] ? r[m[f]!]?.trim() || undefined : undefined);
  const out: ImportRow[] = [];
  for (const r of records) {
    const at = get(r, "at");
    const email = get(r, "email");
    const userId = get(r, "userId");
    if (!at || (!email && !userId)) continue;
    const count = parseNumber(get(r, "count"));
    const tokens = parseNumber(get(r, "tokens"));
    const row: ImportRow = { at };
    if (email) row.email = email;
    if (userId) row.userId = userId;
    for (const f of ["tool", "model", "title", "prompt"] as const) {
      const v = get(r, f);
      if (v) row[f] = v;
    }
    if (count !== undefined && count >= 1) row.count = Math.round(count);
    if (tokens !== undefined && tokens >= 0) row.tokens = Math.round(tokens);
    const cost = parseNumber(get(r, "cost"));
    if (cost !== undefined && cost >= 0) row.cost = cost;
    out.push(row);
  }
  return out;
}

/** Rows per request: the server takes at most 2,000. */
export const IMPORT_CHUNK = 1000;
