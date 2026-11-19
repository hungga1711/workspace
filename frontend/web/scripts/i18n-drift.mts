/**
 * Translation drift check (pnpm --filter @workspace/web i18n:drift).
 *
 *   i18n:drift                      list stale and untracked translations; exit 1 when any is stale
 *   i18n:drift --accept es          after reviewing: record today's English for every Spanish string
 *   i18n:drift --accept es key …    record only these keys (e.g. the ones just re-translated)
 *
 * The record lives in src/lib/i18n/messages/translated-from.json; commit it with the translations.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { accept, drift, packSidecar, unpackSidecar, type Sidecar } from "../src/lib/i18n/drift.ts";
import { en } from "../src/lib/i18n/messages/en.ts";
import { vi } from "../src/lib/i18n/messages/vi.ts";
import { zh } from "../src/lib/i18n/messages/zh.ts";
import { es } from "../src/lib/i18n/messages/es.ts";

type Tree = Parameters<typeof drift>[0];
const file = fileURLToPath(new URL("../src/lib/i18n/messages/translated-from.json", import.meta.url));
const catalogs: Record<string, Tree> = { vi: vi as unknown as Tree, zh: zh as unknown as Tree, es: es as unknown as Tree };
const source = en as unknown as Tree;
let sidecar: Sidecar = {};
try {
  sidecar = unpackSidecar(JSON.parse(readFileSync(file, "utf8")) as Tree);
} catch {
  sidecar = {};
}

const args = process.argv.slice(2);
if (args[0] === "--accept") {
  const [, locale, ...keys] = args;
  const targets = locale === "all" ? Object.keys(catalogs) : [locale!];
  for (const l of targets) {
    if (!catalogs[l]) throw new Error(`unknown locale ${l}`);
    sidecar[l] = accept(source, catalogs[l]!, sidecar[l], keys.length ? keys : undefined);
  }
  writeFileSync(file, JSON.stringify(packSidecar(sidecar)) + "\n");
  console.log(`recorded: ${targets.join(", ")}`);
} else {
  let stale = 0;
  for (const [l, cat] of Object.entries(catalogs)) {
    const d = drift(source, cat, sidecar[l]);
    stale += d.stale.length;
    console.log(`${l}: ${d.stale.length} stale, ${d.untracked.length} untracked, ${d.missing} not translated (shown in English)`);
    for (const k of d.stale) console.log(`  stale  ${k}`);
    for (const k of d.untracked.slice(0, 20)) console.log(`  new    ${k}`);
    if (d.untracked.length > 20) console.log(`  … ${d.untracked.length - 20} more untracked`);
  }
  if (stale) {
    console.log("\nThe English changed after these were translated. Update them, then: i18n:drift --accept <locale> <keys…>");
    process.exit(1);
  }
}
