// Performance budget gate. Fails CI when a critical route's initial JS
// grows past its budget, or when heavy libraries leak into routes that must not load them.
import { readFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", process.env.NEXT_DIST_DIR ?? ".next");
const manifest = JSON.parse(readFileSync(join(root, "app-build-manifest.json"), "utf8")).pages;

// One ceiling in KB (gzip) for the full initial JS of each critical route, 200 KB:
// features are not cut to fit a tighter number; heavy libraries still load on demand (FORBIDDEN below).
const LIMIT = 200;
const BUDGETS = Object.fromEntries(
  [
    "/(auth)/login/page",
    "/(auth)/setup/page",
    "/app/home/page",
    "/app/chat/[channelId]/page",
    "/app/work/(tabs)/page",
    "/app/work/projects/[id]/page",
    "/app/ai/ask/page",
    "/app/ai/progress/page",
    "/app/ai/adoption/page",
    "/app/work/whiteboards/[id]/page",
  ].map((r) => [r, LIMIT]),
);
// A class name that survives minification and only exists in assistant-ui's runtime.
const ASSISTANT_UI = "ExternalStoreThreadRuntimeCore";
// The whiteboard's drawing editor (@excalidraw/excalidraw): only its own route loads it, and only after the page
// paints. A class name its runtime sets on its modals (the bare package name also appears in our asset path).
const EXCALIDRAW = "excalidraw-modal-container";
// Libraries that must never be in a route's initial chunks.
const FORBIDDEN = {
  "/app/home/page": ["socket.io", "engine.io", "@dnd-kit", "AdminWorkspace", "@tanstack/virtual-core", ASSISTANT_UI, EXCALIDRAW],
  "/(auth)/login/page": ["socket.io", "@dnd-kit", "@tanstack", "AdminWorkspace", "NotificationPanel", ASSISTANT_UI],
  "/app/chat/[channelId]/page": [ASSISTANT_UI],
  "/app/work/projects/[id]/page": ["socket.io"],
  "/app/work/(tabs)/page": ["socket.io", ASSISTANT_UI, EXCALIDRAW],
  "/app/work/whiteboards/[id]/page": [EXCALIDRAW, "socket.io", ASSISTANT_UI],
  "/app/ai/ask/page": [ASSISTANT_UI],
  "/app/ai/progress/page": ["socket.io", ASSISTANT_UI, EXCALIDRAW],
  "/app/ai/adoption/page": ["socket.io", ASSISTANT_UI, EXCALIDRAW],
};

const gz = (f) => gzipSync(readFileSync(join(root, f))).length;
let failed = false;
for (const [route, budget] of Object.entries(BUDGETS)) {
  const files = (manifest[route] ?? []).filter((f) => f.endsWith(".js"));
  if (!files.length) {
    console.error(`✗ ${route}: not found in build manifest`);
    failed = true;
    continue;
  }
  const kb = files.reduce((n, f) => n + gz(f), 0) / 1024;
  const ok = kb <= budget;
  console.log(`${ok ? "✓" : "✗"} ${route.padEnd(34)} ${kb.toFixed(1).padStart(6)} KB / ${budget} KB`);
  failed ||= !ok;
  for (const lib of FORBIDDEN[route] ?? []) {
    const leak = files.find((f) => readFileSync(join(root, f), "utf8").includes(lib));
    if (leak) {
      console.error(`  ✗ ${route} loads "${lib}" initially (${leak})`);
      failed = true;
    }
  }
}
statSync(root);
process.exit(failed ? 1 : 0);
