#!/usr/bin/env node
// Writes docs/api/openapi.json, the OpenAPI 3.1 document of the public API, from PUBLIC_API in
// @workspace/contracts (the same schemas the modules parse and the MCP tools use).
//
//   node tooling/scripts/openapi.mjs          rewrite the document
//   node tooling/scripts/openapi.mjs --check  fail if it is stale (CI)
//
// Needs the built contracts package (pnpm build:packages).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const { buildOpenApi } = await import(join(root, "backend/packages/contracts/dist/api/openapi.js"));
const out = join(root, "docs/api/openapi.json");
const text = JSON.stringify(buildOpenApi(), null, 2) + "\n";

if (process.argv.includes("--check")) {
  const current = existsSync(out) ? readFileSync(out, "utf8") : "";
  if (current !== text) {
    console.error(`${relative(root, out)} is stale: run pnpm api:openapi (after pnpm build:packages) and commit it.`);
    process.exit(1);
  }
  console.log("OpenAPI document is up to date.");
} else {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text);
  console.log(`Wrote ${relative(root, out)}.`);
}
