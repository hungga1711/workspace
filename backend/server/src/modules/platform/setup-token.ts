import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { logger } from "@workspace/service-kit";

/**
 * First-run setup is "whoever gets there first becomes the owner": on a server that is reachable before the
 * admin opens /setup, that could be anyone. In production (or whenever SETUP_TOKEN is set) /setup also needs
 * this token, which only the operator can read: SETUP_TOKEN from the environment, or one generated at the first
 * start and kept in SETUP_TOKEN_FILE (a volume), printed to the log while the workspace does not exist yet.
 * Development and the test suites skip it (they create workspaces all the time).
 */
export function setupTokenRequired(): boolean {
  return process.env.NODE_ENV === "production" || !!process.env.SETUP_TOKEN;
}

const file = () => process.env.SETUP_TOKEN_FILE || join(tmpdir(), "workspace-setup-token");

let cached: string | null = null;

/** The current token: the environment's, else the file's, else a new one written to the file. */
export async function setupToken(): Promise<string> {
  if (process.env.SETUP_TOKEN) return process.env.SETUP_TOKEN;
  if (cached) return cached;
  const path = file();
  try {
    const t = (await readFile(path, "utf8")).trim();
    if (t) return (cached = t);
  } catch {
    /* not generated yet */
  }
  const t = randomBytes(24).toString("base64url");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, t, { mode: 0o600 });
  return (cached = t);
}

export function setupTokenMatches(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** At start, while no workspace exists: make sure the token exists and tell the operator where it is. */
export async function announceSetupToken(setUp: boolean): Promise<void> {
  if (setUp || !setupTokenRequired()) return;
  const token = await setupToken();
  const where = process.env.SETUP_TOKEN ? "SETUP_TOKEN (environment)" : file();
  logger.warn({ where }, `First-run setup token (open /setup and paste it): ${token}`);
}
