// `pnpm dev`: the dev server plus a warm-up. Next compiles a route the first time it is requested, so the
// first visit to each screen waits for the compiler. This script starts `next dev` and, once it answers,
// requests the main screens one after another in the background so they are compiled before you click.
// The requests are unauthenticated (each app route compiles, runs its layout and redirects to /login), which
// is all the compiler needs. `DEV_WARM=0` skips the warm-up; `DEV_BUNDLER=webpack` uses webpack instead of
// Turbopack (the dev-only `webpack()` block in next.config.mjs then applies again).
import { spawn } from "node:child_process";

const port = process.env.PORT ?? "3000";
const base = `http://localhost:${port}`;
const bundler = process.env.DEV_BUNDLER === "webpack" ? [] : ["--turbopack"];
const next = spawn("next", ["dev", ...bundler, "-p", port, ...process.argv.slice(2)], { stdio: "inherit", env: process.env });
next.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => next.kill(sig));

// Screens worth having ready: the sign-in page, the app shell with each destination and the work tabs,
// chat, the assistant and the first admin pages. Everything else compiles on demand.
const ROUTES = [
  "/login",
  "/app/home",
  "/app/work?tab=tasks",
  "/app/work?tab=overview",
  "/app/work?tab=docs",
  "/app/work?tab=calendar",
  "/app/work?tab=ops",
  "/app/chat",
  "/app/me",
  "/app/ai/progress",
  "/app/ai/ask",
  "/admin/workspace",
  "/admin/workspace/members",
];

async function ready() {
  for (let i = 0; i < 120; i++) {
    try {
      await fetch(`${base}/login`, { redirect: "manual" });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return false;
}

async function warm() {
  if (process.env.DEV_WARM === "0" || !(await ready())) return;
  const t0 = Date.now();
  // One at a time: parallel requests make the compiler thrash and finish later overall.
  for (const r of ROUTES) {
    try {
      await fetch(base + r, { redirect: "manual" });
    } catch {
      /* the server restarted or went away; the next route tries again */
    }
  }
  console.log(`\n ✓ warmed ${ROUTES.length} screens in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
}
void warm();
