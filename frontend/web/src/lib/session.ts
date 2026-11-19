import "server-only";
import { cookies } from "next/headers";
import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import { config } from "./config";
import { REQUEST_ID_HEADER } from "./request-id";
import { SESSION_COOKIE as COOKIE, SESSION_IDLE_SECONDS as TTL, SESSION_SID as SID } from "./session-cookie";

/**
 * Server-side sessions: the access token (identity JWT, 10 minutes) and the refresh token live in Postgres (schema
 * `web`, role workspace_web); the browser only holds an opaque, httpOnly, SameSite=Lax session id. Browser JavaScript
 * never sees either token (an XSS cannot lift them); client calls go through /api/proxy, which attaches the access
 * token server-side.
 */
export interface Session {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
  userId: string;
  name: string;
  givenName: string;
  email: string;
  /** Signed in with a temporary password (admin reset, invite with a password): sent to /change-password first. */
  mustChangePassword?: boolean;
}

const secure = config.appUrl.startsWith("https://");
const g = globalThis as unknown as { __wosPool?: pg.Pool };
// One small pool per web process (kept on globalThis so dev reloads do not open another).
const db = () => (g.__wosPool ??= new pg.Pool({ connectionString: process.env.WEB_DATABASE_URL ?? "postgres://workspace_web:app_pw@localhost:5432/workspace", max: 5 }));
// Store keys are hashes of the cookie value, so a database dump does not yield usable cookies.
const storeKey = (sid: string) => `websess:${createHash("sha256").update(`${config.sessionSecret}:${sid}`).digest("hex")}`;

async function store(key: string, s: Session) {
  // Expired sessions are dropped by whoever writes now and then: no job to run, and reads ignore them anyway.
  if (Math.random() < 0.01) await db().query("DELETE FROM sessions WHERE expires_at < now()");
  await db().query(
    "INSERT INTO sessions (key, data, expires_at) VALUES ($1, $2, now() + make_interval(secs => $3)) ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, expires_at = EXCLUDED.expires_at",
    [key, JSON.stringify(s), TTL],
  );
}

const drop = (key: string) => db().query("DELETE FROM sessions WHERE key = $1", [key]);

export async function readSession(): Promise<Session | null> {
  const sid = (await cookies()).get(COOKIE)?.value;
  if (!sid || !SID.test(sid)) return null;
  return readSessionBySid(sid);
}

async function readSessionBySid(sid: string): Promise<Session | null> {
  const row = (await db().query<{ data: Session }>("SELECT data FROM sessions WHERE key = $1 AND expires_at > now()", [storeKey(sid)])).rows[0];
  return row?.data ?? null;
}

/** Creates a new session id on sign-in (no fixation; the previous session ends) or updates the current one. */
export async function writeSession(s: Session, rotate = false) {
  const c = await cookies();
  const prev = c.get(COOKIE)?.value;
  let sid = rotate ? undefined : prev;
  if (!sid || !SID.test(sid)) sid = randomBytes(32).toString("base64url");
  await store(storeKey(sid), s);
  c.set(COOKIE, sid, { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: TTL });
  if (rotate && prev && SID.test(prev) && prev !== sid) await drop(storeKey(prev));
}

export async function clearSession() {
  const c = await cookies();
  const sid = c.get(COOKIE)?.value;
  if (sid && SID.test(sid)) await drop(storeKey(sid));
  c.delete(COOKIE);
}

/** Refreshes the access token when it expires within 30s. Returns null if the session is gone. */
export async function freshSession(): Promise<Session | null> {
  const sid = (await cookies()).get(COOKIE)?.value;
  if (!sid || !SID.test(sid)) return null;
  return freshSessionBySid(sid);
}

async function freshSessionBySid(sid: string, force = false): Promise<Session | null> {
  const s = await readSessionBySid(sid);
  if (!s) return null;
  if (!force && s.expiresAt - Date.now() > 30_000) return s;
  // One refresh per session at a time: refresh tokens are single use, and a page renders many calls at
  // once. The others wait for the winner and read the session it wrote.
  const lock = storeKey(sid);
  const won = await db().query(
    `INSERT INTO refresh_locks (key, until) VALUES ($1, now() + interval '10 seconds')
     ON CONFLICT (key) DO UPDATE SET until = EXCLUDED.until WHERE refresh_locks.until < now()`,
    [lock],
  );
  if (!won.rowCount) {
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const again = await readSessionBySid(sid);
      if (!again) return null;
      if (again.refreshToken !== s.refreshToken) return again;
    }
    return null;
  }
  try {
    const res = await fetch(`${config.gatewayUrl}/api/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json", [REQUEST_ID_HEADER]: randomBytes(8).toString("hex") },
      body: JSON.stringify({ refreshToken: s.refreshToken }),
      cache: "no-store",
    }).catch(() => null);
    if (!res?.ok) {
      // A refused refresh (signed out elsewhere, revoked, expired) ends this browser session; a network
      // failure keeps it for the next try.
      if (res && (res.status === 401 || res.status === 403)) await drop(storeKey(sid));
      return null;
    }
    const t = (await res.json()) as TokenSet;
    const next: Session = { ...s, accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: Date.now() + t.expiresIn * 1000 };
    // A database write works from server components too (no cookie change needed).
    await store(storeKey(sid), next);
    return next;
  } finally {
    await db().query("DELETE FROM refresh_locks WHERE key = $1", [lock]);
  }
}

/** The gateway said the token predates an account change (password changed elsewhere): get a new one now. */
export async function forceRefresh(): Promise<Session | null> {
  const sid = (await cookies()).get(COOKIE)?.value;
  if (!sid || !SID.test(sid)) return null;
  return freshSessionBySid(sid, true);
}

/** What the identity module returns from sign-in and refresh. */
export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  sessionId: string;
  user: { id: string; email: string; givenName: string; familyName: string; name: string; mustChangePassword?: boolean };
}
