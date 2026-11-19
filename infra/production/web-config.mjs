// Runs before the web server starts in the Docker image (infra/production/entrypoint.sh `web`).
//
// The image is built once without knowing where it will be served, but Next.js fixes two things at
// build time: the security headers from next.config.mjs (written to routes-manifest.json) and
// NEXT_PUBLIC_* values (compiled into the browser bundle and the prerendered pages). This script
// applies the runtime environment to both:
//   1. recomputes headers() from next.config.mjs with this container's env (CSP origins for storage,
//      chat realtime and LiveKit; HSTS and upgrade-insecure-requests when APP_URL is https://);
//   2. replaces the build placeholders for APP_URL and NEXT_PUBLIC_CHAT_URL in the built files.
// Files are rewritten in place; a new container starts again from the image's placeholders.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const webRoot = "/app/web/frontend/web";
const distDir = join(webRoot, ".next");

const appUrl = (process.env.APP_URL ?? "").replace(/\/+$/, "");
if (!appUrl) {
  console.error("web: APP_URL is not set (the public address of this installation, e.g. https://work.example.com)");
  process.exit(1);
}
// Sign-in sessions are keyed with SESSION_SECRET; the source falls back to a public development value without it.
const sessionSecret = process.env.SESSION_SECRET ?? "";
if (sessionSecret.length < 32 || sessionSecret.startsWith("dev-session-secret")) {
  console.error("web: SESSION_SECRET must be set to a random value of at least 32 characters");
  process.exit(1);
}
// Chat realtime defaults to the app's own origin (the reverse proxy sends /socket.io/ to the server).
process.env.NEXT_PUBLIC_CHAT_URL = (process.env.NEXT_PUBLIC_CHAT_URL || appUrl).replace(/\/+$/, "");
process.env.APP_URL = appUrl;

// 1. Security headers.
const { default: nextConfig } = await import("/app/infra/production/next.config.mjs");
const fresh = await nextConfig.headers();
const manifestPath = join(distDir, "routes-manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
let updated = 0;
for (const rule of manifest.headers ?? []) {
  const match = fresh.find((f) => f.source === rule.source);
  if (match) {
    rule.headers = match.headers;
    updated++;
  }
}
if (updated !== fresh.length) {
  console.error(`web: could not apply security headers (${updated} of ${fresh.length} rules matched routes-manifest.json)`);
  process.exit(1);
}
writeFileSync(manifestPath, JSON.stringify(manifest));

// 2. Build-time placeholders (see the Dockerfile's web build).
const replacements = [
  ["http://workspace-app-url.invalid", appUrl],
  ["http://workspace-chat-url.invalid", process.env.NEXT_PUBLIC_CHAT_URL],
];
const textFile = /\.(js|mjs|cjs|json|html|rsc|body|meta|txt|xml|webmanifest)$/;
let files = 0;
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const name = entry.name;
    const p = join(dir, name);
    if (entry.isDirectory()) {
      if (name !== "cache") walk(p);
    } else if (textFile.test(name)) {
      const before = readFileSync(p, "utf8");
      let after = before;
      for (const [from, to] of replacements) after = after.split(from).join(to);
      if (after !== before) {
        writeFileSync(p, after);
        files++;
      }
    }
  }
}
walk(distDir);
walk(join(webRoot, "public"));
console.log(`web: APP_URL=${appUrl} chat=${process.env.NEXT_PUBLIC_CHAT_URL}; ${updated} header rules, ${files} files configured`);
