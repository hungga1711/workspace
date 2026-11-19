#!/usr/bin/env node
// Prepares a release: the next version in every manifest, and its CHANGELOG.md section written from what
// "## [Unreleased]" holds plus the commits since the previous tag, grouped by the area each subject starts with
// ("Board: drag a card…" → Board). Commits nothing; the release workflow commits, tags and publishes.
//
//   node tooling/scripts/release.mjs patch|minor|major|<x.y.z> [--dry-run] [--notes-out FILE]
//
// Prints the new version on stdout. --dry-run prints the notes and changes no file.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const bump = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--notes-out");
const dry = args.includes("--dry-run");
const notesOut = args.includes("--notes-out") ? args[args.indexOf("--notes-out") + 1] : null;

const die = (m) => {
  console.error(`release: ${m}`);
  process.exit(1);
};
const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const read = (f) => readFileSync(join(root, f), "utf8");

const current = JSON.parse(read("package.json")).version;
const previous = previousTag();
// The first release publishes the version the manifests already carry; later ones go up from it.
const bumped = nextVersion(current, bump);
const next = previous ? bumped : current;
if (git("tag", "--list", `v${next}`)) die(`v${next} already exists`);

const MANIFESTS = [
  "package.json",
  "backend/server/package.json",
  "backend/packages/contracts/package.json",
  "backend/packages/shared/package.json",
  "backend/packages/service-kit/package.json",
  "backend/packages/testkit/package.json",
  "frontend/web/package.json",
  "frontend/desktop/package.json",
  "frontend/desktop/src-tauri/tauri.conf.json",
  "frontend/browser-extension/manifest.json",
  "tooling/tsconfig/package.json",
  "website/package.json",
];
/** Files that name the version once in code ("1.0.0" in quotes): the API and MCP versions, the site, the API document. */
const VERSION_STRINGS = [
  "backend/packages/contracts/src/api/public-api.ts",
  "backend/server/src/modules/ai/mcp/client.ts",
  "backend/server/src/modules/ai/mcp/controller.ts",
  "docs/api/openapi.json",
  "website/src/lib/site.ts",
];

const changelog = read("CHANGELOG.md");
const m = /^## \[Unreleased\][^\n]*\n([\s\S]*?)(?=^## \[|(?![\s\S]))/m.exec(changelog);
if (!m) die('CHANGELOG.md has no "## [Unreleased]" section');
const written = m[1].trim();
const changes = previous ? commitList(previous) : "";
if (previous && !written && !changes) die(`nothing to release: no commits since ${previous}`);
const notes = [written || (previous ? "" : "First release."), changes && `### Commits\n\n${changes}`].filter(Boolean).join("\n\n");

if (notesOut) writeFileSync(notesOut, `${notes}\n`);
if (dry) {
  console.error(`v${current} → v${next}\n\n${notes}\n`);
  console.log(next);
  process.exit(0);
}

const date = new Date().toISOString().slice(0, 10);
writeFileSync(join(root, "CHANGELOG.md"), changelog.replace(m[0], `## [Unreleased]\n\n## [${next}] - ${date}\n\n${notes}\n\n`).trimEnd() + "\n");
for (const f of next === current ? [] : MANIFESTS) {
  if (!existsSync(join(root, f))) continue;
  const text = read(f);
  const out = text.replace(new RegExp(`("version":\\s*")${esc(current)}"`), `$1${next}"`);
  if (out === text) die(`${f} is not at version ${current}`);
  writeFileSync(join(root, f), out);
}
for (const f of next === current ? [] : VERSION_STRINGS) {
  if (!existsSync(join(root, f))) continue;
  const text = read(f);
  if (!text.includes(`"${current}"`)) die(`${f} does not name version ${current}`);
  writeFileSync(join(root, f), text.replaceAll(`"${current}"`, `"${next}"`));
}
if (next !== current) bumpCargo("frontend/desktop/src-tauri/Cargo.toml", /(\[package\][\s\S]*?\nversion = ")([^"]+)"/);
if (next !== current) bumpCargo("frontend/desktop/src-tauri/Cargo.lock", /(name = "workspace-desktop"\nversion = ")([^"]+)"/);
console.log(next);

function nextVersion(v, how) {
  if (/^\d+\.\d+\.\d+$/.test(how ?? "")) return how;
  const [a, b, c] = v.split("-")[0].split(".").map(Number);
  if (how === "major") return `${a + 1}.0.0`;
  if (how === "minor") return `${a}.${b + 1}.0`;
  if (how === "patch") return `${a}.${b}.${c + 1}`;
  return die("usage: release.mjs patch|minor|major|<x.y.z> [--dry-run] [--notes-out FILE]");
}

function previousTag() {
  try {
    return git("describe", "--tags", "--abbrev=0", "--match", "v*");
  } catch {
    return "";
  }
}

/** Commit subjects since the previous release tag, grouped by area; release commits and merges left out. */
function commitList(since) {
  const log = git("log", "--no-merges", "--format=%s", `${since}..HEAD`);
  const groups = new Map();
  for (const subject of log.split("\n").filter(Boolean)) {
    if (/^Release \d+\.\d+\.\d+/.test(subject)) continue;
    const area = /^([A-Z][\w ./&+-]{0,30}):\s+(.+)$/.exec(subject);
    const [key, text] = area ? [area[1], area[2]] : /^(Bump|Update) .+ from .+ to /.test(subject) ? ["Dependencies", subject] : ["Other", subject];
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(text);
  }
  const order = [...groups.keys()].sort((x, y) => rank(x) - rank(y) || x.localeCompare(y));
  return order
    .map(
      (k) =>
        `**${k}**\n\n${groups
          .get(k)
          .reverse()
          .map((t) => `- ${t}`)
          .join("\n")}`,
    )
    .join("\n\n");
}

function rank(k) {
  return k === "Other" ? 2 : k === "Dependencies" ? 3 : 1;
}

function bumpCargo(f, re) {
  if (!existsSync(join(root, f))) return;
  const text = read(f);
  writeFileSync(
    join(root, f),
    text.replace(re, (_, head, v) => (v === current ? `${head}${next}"` : die(`${f} is at ${v}, not ${current}`))),
  );
}

function esc(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
