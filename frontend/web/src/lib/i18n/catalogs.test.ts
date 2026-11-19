import { describe, expect, it } from "vitest";
import { LOCALES } from "./config";
import { DICTS } from "./dicts";
import { en } from "./messages/en";
import { vi } from "./messages/vi";
import { zh } from "./messages/zh";
import { es } from "./messages/es";

type Tree = { [k: string]: string | Tree };
const leaves = (o: Tree, p = ""): [string, string][] => Object.entries(o).flatMap(([k, v]) => (typeof v === "string" ? [[p + k, v] as [string, string]] : leaves(v, `${p}${k}.`)));
const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
// A translation may add plural forms English does not have (Spanish _many, Vietnamese/Chinese only _other).
const base = (k: string) => k.replace(/_(zero|one|two|few|many|other)$/, "");

/** Values the code passes that the English string happens not to use. */
const EXTRA_VARS: Record<string, string[]> = { "work.gantt.month": ["m"] };

const source = new Map(leaves(en as unknown as Tree));
const bases = new Set([...source.keys()].map(base));

describe.each([
  ["vi", vi],
  ["zh", zh],
  ["es", es],
] as const)("%s catalog", (_name, catalog) => {
  const entries = leaves(catalog as unknown as Tree);
  it("only has keys English has", () => {
    expect(entries.filter(([k]) => !source.has(k) && !bases.has(base(k))).map(([k]) => k)).toEqual([]);
  });
  it("only uses {placeholders} the code passes", () => {
    const bad = entries.filter(([k, v]) => {
      const ref = source.get(k) ?? source.get(`${base(k)}_other`) ?? source.get(base(k));
      if (ref === undefined) return false;
      // A language may leave a value out ("Tháng {m}, {y}" has no month name), never invent one the code does not send.
      const known = new Set([...vars(ref), ...(EXTRA_VARS[k] ?? [])]);
      return vars(v).some((x) => !known.has(x));
    });
    expect(bad.map(([k]) => k)).toEqual([]);
  });
});

describe("merged catalogs", () => {
  it("give every locale every English key", () => {
    for (const l of LOCALES) expect(leaves(DICTS[l] as unknown as Tree).length).toBeGreaterThanOrEqual(source.size);
  });
});
