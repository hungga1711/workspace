#!/usr/bin/env node
/**
 * Builds the desktop app for one company's server, with its address built in, so staff install it and are signed in
 * to the right place without typing anything:
 *
 *   pnpm desktop:build https://work.company.com
 *
 * Run it on each kind of computer staff use (a Mac builds the macOS app, Windows the Windows installer, Linux the
 * Linux packages); it needs Rust and the Tauri prerequisites (https://tauri.app/start/prerequisites/). The installers
 * land in frontend/desktop/dist/. Put them where staff can download them (a shared drive, an intranet page) and paste
 * that link in Admin › Settings › Desktop app: Profile then offers Download and Open in app.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const desktop = join(root, "frontend/desktop");
const bundle = join(desktop, "src-tauri/target/release/bundle");
const out = join(desktop, "dist");

const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

const raw = (process.argv[2] ?? process.env.WORKSPACE_URL ?? "").trim();
if (!raw) fail("usage: pnpm desktop:build <the address staff open workspace at>, e.g. https://work.company.com");
// The same rule as the app's connect page: a bare host is https, except a local address.
const withScheme = /^https?:\/\//i.test(raw) ? raw : `${/^(localhost|127\.|10\.|192\.168\.|[^/]+\.local\b)/i.test(raw) ? "http" : "https"}://${raw}`;
let server;
try {
  server = new URL(withScheme).origin;
} catch {
  fail(`not an address: ${raw}`);
}

if (spawnSync("cargo", ["--version"], { stdio: "ignore" }).status !== 0)
  fail("Rust is not installed. Install it and the Tauri prerequisites first: https://tauri.app/start/prerequisites/");

// The server should answer; a typo here would ship to every computer.
try {
  const r = await fetch(`${server}/manifest.webmanifest`, { signal: globalThis.AbortSignal.timeout(10000) });
  if (!r.ok) console.warn(`warning: ${server} answered HTTP ${r.status}; check the address.`);
} catch {
  console.warn(`warning: could not reach ${server} from here; building anyway.`);
}

console.log(`Building the desktop app for ${server}…`);
// Installers from an earlier build (another address) must not be picked up below.
rmSync(bundle, { recursive: true, force: true });
const build = spawnSync("pnpm", ["exec", "tauri", "build"], {
  cwd: desktop,
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, WORKSPACE_URL: server },
});
if (build.status !== 0) fail("The build failed (see above).");

const INSTALLERS = /\.(dmg|msi|exe|deb|rpm|AppImage)$/;
mkdirSync(out, { recursive: true });
const made = [];
for (const kind of existsSync(bundle) ? readdirSync(bundle) : []) {
  for (const file of readdirSync(join(bundle, kind))) {
    if (!INSTALLERS.test(file)) continue;
    copyFileSync(join(bundle, kind, file), join(out, file));
    made.push(join(out, file));
  }
}
if (!made.length) fail(`No installers found in ${bundle}.`);
console.log(`\nDone. Installers for ${server}:\n${made.map((f) => `  ${f}`).join("\n")}`);
console.log("\nShare them with staff (a shared drive, an intranet page) and paste that link in Admin › Settings › Desktop app.");
