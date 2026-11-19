import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { AREA_EXTRA, CHANGE_PASSWORD_EXTRA, areaHasGroup, type MessageArea } from "./areas";
import { en } from "./messages/en";

/**
 * A client component can only show keys its layout's area ships (areas.ts); any other renders as the raw key, which
 * has reached users more than once. From each area's route files, follow the imports to every client module and
 * check every key literal (and `group.sub.${…}` template prefix) it uses.
 */
const SRC = resolve(__dirname, "../..");

const keys = new Set<string>();
const prefixes = new Set<string>();
const walkKeys = (o: Record<string, unknown>, p: string) => {
  for (const [k, v] of Object.entries(o)) {
    const full = p ? `${p}.${k}` : k;
    if (typeof v === "string") {
      keys.add(full);
      const plural = /^(.*)_(one|other)$/.exec(full);
      if (plural) keys.add(plural[1]!);
    } else walkKeys(v as Record<string, unknown>, full);
  }
};
walkKeys(en, "");
for (const k of keys) {
  const parts = k.split(".");
  for (let i = 1; i < parts.length; i++) prefixes.add(`${parts.slice(0, i).join(".")}.`);
}

const files: string[] = [];
const walk = (d: string) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.tsx?$/.test(e.name) && !/\.test\./.test(e.name)) files.push(p);
  }
};
walk(SRC);
const source = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));

const resolveImport = (from: string, spec: string): string | null => {
  const base = spec.startsWith("@/") ? join(SRC, spec.slice(2)) : spec.startsWith(".") ? resolve(dirname(from), spec) : null;
  if (!base) return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) if (source.has(c)) return c;
  return null;
};
const imports = new Map<string, string[]>();
for (const [f, s] of source) {
  const out: string[] = [];
  for (const m of s.matchAll(/(?:^|\n)\s*(?:import|export)\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']/g)) if (!m[1]) out.push(m[2]!);
  for (const m of s.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]!);
  for (const m of s.matchAll(/(?:^|\n)import\s+["']([^"']+)["']/g)) out.push(m[1]!);
  imports.set(
    f,
    out.map((spec) => resolveImport(f, spec)).filter((x): x is string => !!x),
  );
}
const isClient = (f: string) => /^\s*(\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*["']use client["']/.test(source.get(f)!);
const usedKeys = (f: string) => {
  const s = source.get(f)!;
  const out: string[] = [];
  for (const m of s.matchAll(/["'`]([a-zA-Z]\w*(?:\.\w+)+)["'`]/g)) if (keys.has(m[1]!)) out.push(m[1]!);
  for (const m of s.matchAll(/`([a-zA-Z]\w*(?:\.\w+)*\.)\$\{/g)) if (prefixes.has(m[1]!)) out.push(m[1]!);
  return out;
};

const under = (dir: string) => files.filter((f) => f.startsWith(join(SRC, dir) + sep));
const changePassword = join(SRC, "app/(auth)/change-password") + sep;
const ENTRIES: { name: string; area: MessageArea; extra: readonly string[]; files: string[] }[] = [
  { name: "root", area: "base", extra: [], files: files.filter((f) => f.startsWith(join(SRC, "app") + sep) && !/^app\/(app|admin|\(auth\)|meet)\//.test(relative(SRC, f))) },
  { name: "app", area: "app", extra: [], files: under("app/app") },
  { name: "admin", area: "admin", extra: [], files: under("app/admin") },
  { name: "sign-in", area: "signIn", extra: [], files: under("app/(auth)").filter((f) => !f.startsWith(changePassword)) },
  { name: "change-password", area: "signIn", extra: CHANGE_PASSWORD_EXTRA, files: under("app/(auth)/change-password") },
  { name: "meet", area: "meet", extra: [], files: under("app/meet") },
];

const shipped = (area: MessageArea, extra: readonly string[], key: string) =>
  areaHasGroup(area, key.split(".")[0]!) || [...(AREA_EXTRA[area] ?? []), ...extra].some((e) => key === e || key.startsWith(`${e}.`));

describe("message areas", () => {
  for (const entry of ENTRIES) {
    it(`${entry.name}: client components use only keys the ${entry.area} area ships`, () => {
      expect(entry.files.length).toBeGreaterThan(0);
      const missing = new Set<string>();
      const seen = new Set<string>();
      const stack = entry.files.map((f) => ({ f, client: isClient(f) }));
      while (stack.length) {
        const { f, client } = stack.pop()!;
        const c = client || isClient(f);
        if (seen.has(`${f}|${c}`)) continue;
        seen.add(`${f}|${c}`);
        if (c) for (const k of usedKeys(f)) if (!shipped(entry.area, entry.extra, k.endsWith(".") ? `${k}x` : k)) missing.add(`${relative(SRC, f)}: ${k}`);
        for (const d of imports.get(f) ?? []) stack.push({ f: d, client: c });
      }
      expect([...missing].sort()).toEqual([]);
    });
  }
});
