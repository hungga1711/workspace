import { INTL_TAG, type Locale } from "./config";
import type { en } from "./messages/en";

/**
 * Typed message lookup shared by server and client. Keys are dot paths into messages/en.ts, the source catalog
 * (a typo is a compile error). Values interpolate `{name}`; a key with `_one` / `_other`
 * variants is called by its base name with a numeric `count`, and the plural rule picks the form.
 *
 * This module holds no dictionaries: the client gets the active locale's messages for its area from the
 * layouts (I18nProvider, i18n/server.ts `getMessages`), and server code loads both from ./dicts.
 */
export type Messages = typeof en;
/** A translated catalog: any subset of en.ts's keys (dicts.ts merges it over English, so a gap reads in English). */
export type Catalog = { [K in keyof Messages]?: DeepPartial<Messages[K]> };
type DeepPartial<V> = V extends string ? string : { [K in keyof V]?: DeepPartial<V[K]> };

/** `base` with every string `over` has, recursively; `over`'s keys outside `base` are dropped. */
export function mergeCatalog(base: Messages, over: Catalog | undefined): Messages {
  if (!over) return base;
  const merge = (b: Record<string, unknown>, o: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(b)) {
      const ov = o[k];
      if (typeof v === "string") out[k] = typeof ov === "string" && ov ? ov : v;
      else out[k] = ov && typeof ov === "object" ? merge(v as Record<string, unknown>, ov as Record<string, unknown>) : v;
    }
    // Plural forms a language needs and English lacks (Spanish _many) are kept beside the merged keys.
    for (const [k, v] of Object.entries(o)) if (!(k in out) && typeof v === "string" && /_(zero|one|two|few|many|other)$/.test(k)) out[k] = v;
    return out;
  };
  return merge(base as unknown as Record<string, unknown>, over as Record<string, unknown>) as unknown as Messages;
}

type Leaves<T, P extends string = ""> = { [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Leaves<T[K], `${P}${K}.`> }[keyof T & string];
type Leaf = Leaves<Messages>;
type PluralBase<L> = L extends `${infer B}_other` ? B : never;
export type MessageKey = Leaf | PluralBase<Leaf>;
export type Vars = Record<string, string | number | null | undefined>;
export type T = (key: MessageKey, vars?: Vars) => string;

function lookup(dict: Messages, path: string): string | undefined {
  let cur: unknown = dict;
  for (const part of path.split(".")) cur = (cur as Record<string, unknown> | undefined)?.[part];
  return typeof cur === "string" ? cur : undefined;
}

/*
 * English messages built from placeholders ("{p0} days") read "1 days" when the number is 1.
 * After interpolation, "1 <plural noun>" becomes singular for the nouns the catalog uses.
 * (Keys with explicit _one/_other forms are already exact; this covers the rest.)
 */
const IRREGULAR: Record<string, string> = { people: "person", replies: "reply", activities: "activity", entries: "entry", companies: "company" };
const NOUNS = new Set([
  "days",
  "members",
  "tasks",
  "uses",
  "devices",
  "tokens",
  "attempts",
  "projects",
  "requests",
  "decisions",
  "seats",
  "drafts",
  "meetings",
  "permissions",
  "users",
  "events",
  "occurrences",
  "subtasks",
  "steps",
  "items",
  "messages",
  "invitations",
  "minutes",
  "hours",
  "conversations",
  "channels",
  "approvals",
  "documents",
  "docs",
  "files",
  "agents",
  "calls",
  "weeks",
  "months",
  "years",
  "comments",
  "mentions",
  "sessions",
  "keys",
  "webhooks",
  "employees",
  "teams",
  "roles",
  "holidays",
  "workspaces",
  "results",
  "updates",
  "colleagues",
  "options",
  "fields",
  "versions",
  "sources",
]);
export function singularize(text: string): string {
  const one = (w: string) => IRREGULAR[w] ?? (NOUNS.has(w) ? w.slice(0, -1) : null);
  // "1 days", or "1 open tasks" (one adjective in between).
  return text.replace(/(?<![\d.,])\b1 ([a-z]+)(?: ([a-z]+))?\b/g, (m, a: string, b: string | undefined) => {
    if (one(a)) return `1 ${one(a)}${b ? ` ${b}` : ""}`;
    if (b && one(b)) return `1 ${a} ${one(b)}`;
    return m;
  });
}

/** Translator over one locale's messages; unknown keys render as the key itself. */
export function tFrom(dict: Messages, locale: Locale): T {
  const plural = new Intl.PluralRules(INTL_TAG[locale]);
  return (key, vars) => {
    let msg: string | undefined;
    if (vars && typeof vars.count === "number") msg = lookup(dict, `${key}_${plural.select(vars.count)}`) ?? lookup(dict, `${key}_other`);
    msg ??= lookup(dict, key) ?? key;
    if (!vars) return msg;
    const out = msg.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name] ?? "") : m));
    return locale === "en" ? singularize(out) : out;
  };
}
