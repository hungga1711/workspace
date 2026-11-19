import { createHash } from "node:crypto";

/**
 * Translation drift: each translated string remembers a short hash of the English it was translated from
 * (messages/translated-from.json). When the English changes, the old translation still type-checks and still shows,
 * but may now say something else; this lists those keys so a translator looks at them. Tooling only (node:crypto),
 * never imported by the app.
 */

type Tree = { [k: string]: string | Tree };
export type Sidecar = Record<string, Record<string, string>>;

export const leaves = (o: Tree, p = ""): [string, string][] =>
  Object.entries(o).flatMap(([k, v]) => (typeof v === "string" ? [[p + k, v] as [string, string]] : leaves(v, `${p}${k}.`)));

/** The English key a translated key follows: itself, or for an extra plural form (Spanish _many) the _other form. */
export function sourceKey(key: string, en: Map<string, string>): string | null {
  if (en.has(key)) return key;
  const other = key.replace(/_(zero|one|two|few|many)$/, "_other");
  return en.has(other) ? other : null;
}

export const hashOf = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 6);

export const DRIFT_LOCALES = ["vi", "zh", "es"] as const;

/**
 * The record on disk is a tree shaped like the catalogs, each leaf "viHash zhHash esHash" ("-" where that language
 * has no record), so the 7,000 key paths are not written three times.
 */
export function unpackSidecar(tree: Tree): Sidecar {
  const out: Sidecar = Object.fromEntries(DRIFT_LOCALES.map((l) => [l, {}]));
  for (const [k, v] of leaves(tree)) {
    v.split(" ").forEach((h, i) => {
      if (h && h !== "-") out[DRIFT_LOCALES[i]!]![k] = h;
    });
  }
  return out;
}

export function packSidecar(s: Sidecar): Tree {
  const keys = [...new Set(DRIFT_LOCALES.flatMap((l) => Object.keys(s[l] ?? {})))].sort();
  const root: Tree = {};
  for (const k of keys) {
    const parts = k.split(".");
    let node = root;
    for (const p of parts.slice(0, -1)) node = (node[p] ??= {}) as Tree;
    node[parts.at(-1)!] = DRIFT_LOCALES.map((l) => s[l]?.[k] ?? "-").join(" ");
  }
  return root;
}

export interface Drift {
  /** Translated while the English said something else. */
  stale: string[];
  /** Translated, but with no record of which English (new translations not yet accepted). */
  untracked: string[];
  /** English keys this catalog does not translate (they show in English). */
  missing: number;
}

export function drift(enTree: Tree, catalog: Tree, recorded: Record<string, string> = {}): Drift {
  const en = new Map(leaves(enTree));
  const out: Drift = { stale: [], untracked: [], missing: 0 };
  const have = new Set<string>();
  for (const [k] of leaves(catalog)) {
    const src = sourceKey(k, en);
    if (!src) continue;
    have.add(src);
    const was = recorded[k];
    if (!was) out.untracked.push(k);
    else if (was !== hashOf(en.get(src)!)) out.stale.push(k);
  }
  for (const k of en.keys()) if (!have.has(k)) out.missing++;
  return out;
}

/** The sidecar entries for `keys` (all translated keys when omitted), pointing at today's English. */
export function accept(enTree: Tree, catalog: Tree, recorded: Record<string, string> = {}, keys?: string[]): Record<string, string> {
  const en = new Map(leaves(enTree));
  const next = { ...recorded };
  const only = keys ? new Set(keys) : null;
  for (const [k] of leaves(catalog)) {
    const src = sourceKey(k, en);
    if (!src || (only && !only.has(k))) continue;
    next[k] = hashOf(en.get(src)!);
  }
  for (const k of Object.keys(next)) if (!sourceKey(k, en)) delete next[k];
  return Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)));
}
