import "server-only";
import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

/** One stack frame, resolved to the source when the build's map was found, else as the browser printed it. */
export interface Frame {
  file: string;
  line: number | null;
  col: number | null;
  name: string | null;
  raw?: string;
}

interface RawFrame {
  raw: string;
  name: string | null;
  url: string;
  line: number;
  col: number;
}

// Chrome/Edge: "    at name (url:line:col)" or "    at url:line:col"; Firefox/Safari: "name@url:line:col".
const CHROME = /^\s*at (?:(.+?) \()?(\S+?):(\d+):(\d+)\)?\s*$/;
const GECKO = /^\s*(?:([^@\s]*)@)?(\S+?):(\d+):(\d+)\s*$/;

export function parseStack(stack: string | undefined | null, max = 6): RawFrame[] {
  const out: RawFrame[] = [];
  for (const line of (stack ?? "").split("\n")) {
    const m = CHROME.exec(line) ?? GECKO.exec(line);
    if (!m) continue;
    out.push({ raw: line.trim().slice(0, 500), name: m[1] || null, url: m[2]!, line: Number(m[3]), col: Number(m[4]) });
    if (out.length >= max) break;
  }
  return out;
}

/** "/_next/static/chunks/app/x.js" for a chunk URL of this app, whatever origin the browser printed; null otherwise. */
function staticPath(url: string): string | null {
  try {
    const p = (url.startsWith("/") ? url : new URL(url).pathname).split("?")[0]!;
    return /^\/_next\/static\/[\w./-]+\.js$/.test(p) && !p.includes("..") ? p.slice("/_next/static/".length) : null;
  } catch {
    return null;
  }
}

/** The map's source path as the repo knows it: webpack's prefixes off, `src/…` under frontend/web, packages by name. */
export function repoPath(source: string): string {
  let s = source
    .replace(/^webpack:\/\/[^/]*\//, "")
    .replace(/^\(app-pages-browser\)\//, "")
    .replace(/^\.\//, "");
  s = s.replace(/^\/+/, "");
  const nm = s.match(/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)(\/.*)?$/);
  if (nm) return `node_modules/${nm[1]}${nm[2] ?? ""}`;
  if (s.startsWith("src/")) return `frontend/web/${s}`;
  return s;
}

type Consumer = { originalPositionFor(p: { line: number; column: number }): { source: string | null; line: number | null; column: number | null; name: string | null } };
// The parsed maps of the chunks that fail most, a few at a time: a map is a few MB and parsing it is the slow part.
const consumers = new Map<string, Promise<Consumer | null>>();
const MAX_CACHED = 8;

function staticDir(): string {
  // `next start` runs from frontend/web (NEXT_DIST_DIR for a build next to the dev one); the standalone server of the
  // Docker image chdirs to its own frontend/web, where `.next/static` is copied beside it.
  return resolve(process.cwd(), process.env.NEXT_DIST_DIR || ".next", "static");
}

async function consumerFor(rel: string): Promise<Consumer | null> {
  let c = consumers.get(rel);
  if (!c) {
    c = (async () => {
      const dir = staticDir();
      const file = resolve(join(dir, `${rel}.map`));
      if (!file.startsWith(dir + sep)) return null;
      const { SourceMapConsumer } = await import("source-map-js");
      return new SourceMapConsumer(JSON.parse(await readFile(file, "utf8"))) as unknown as Consumer;
    })().catch(() => null);
    if (consumers.size >= MAX_CACHED) consumers.delete(consumers.keys().next().value!);
    consumers.set(rel, c);
  }
  return c;
}

/**
 * The top frames of a browser stack as file, line and function in the source, from the build's source maps on disk.
 * Never throws: a frame whose map is missing or does not resolve keeps its raw text.
 */
export async function symbolicate(stack: string | undefined | null): Promise<Frame[]> {
  const frames: Frame[] = [];
  for (const f of parseStack(stack)) {
    const rel = staticPath(f.url);
    const c = rel ? await consumerFor(rel) : null;
    let out: Frame = { file: f.url.replace(/^https?:\/\/[^/]+/, ""), line: f.line, col: f.col, name: f.name, raw: f.raw };
    if (c) {
      try {
        // Stacks count columns from 1, source maps from 0.
        const pos = c.originalPositionFor({ line: f.line, column: Math.max(0, f.col - 1) });
        if (pos.source) out = { file: repoPath(pos.source), line: pos.line, col: pos.column === null ? null : pos.column + 1, name: pos.name ?? f.name };
      } catch {
        // keep the raw frame
      }
    }
    frames.push(out);
  }
  return frames;
}
