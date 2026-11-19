/** An empty value counts as unset: Compose passes optional settings as `${VAR:-}`, i.e. "". */
export function env(name: string, fallback?: string): string {
  const raw = process.env[name];
  const v = raw === undefined || raw === "" ? fallback : raw;
  if (v === undefined || v === "") throw new Error(`Missing required env ${name}`);
  return v;
}

export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) throw new Error(`Env ${name} must be an integer, got ${raw}`);
  return n;
}

/**
 * Where each module's HTTP API lives (ADR 0021): `<MODULE>_URL`, by default the server's internal port, one path
 * prefix per module. Calls between modules of the server are handed over in memory (`serviceFetch`); the URL is
 * what tools and tests reach over HTTP.
 */
const MODULE_URLS = {
  identity: "http://localhost:4001/identity",
  platform: "http://localhost:4001/platform",
  chat: "http://localhost:4001/chat",
  home: "http://localhost:4001/home",
  work: "http://localhost:4001/work",
  employee: "http://localhost:4001/employee",
  ai: "http://localhost:4001/ai",
} as const;
export type ModuleName = keyof typeof MODULE_URLS;
export const MODULE_NAMES = Object.keys(MODULE_URLS) as ModuleName[];

export function moduleUrl(name: ModuleName): string {
  return env(`${name.toUpperCase()}_URL`, MODULE_URLS[name]);
}
