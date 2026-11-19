import "server-only";
import { clientIpFrom } from "./client-ip";
import { cookies, headers } from "next/headers";
import { config } from "./config";
import { readSession, writeSession, type TokenSet } from "./session";
import { REQUEST_ID_HEADER, requestIdFrom } from "./request-id";

/**
 * Our own sign-in: the BFF sends email + password to the identity module (through the gateway, which adds per-IP
 * limits), keeps the tokens it gets back in the server-side session and never exposes them to the browser. The
 * identity module owns hashing (bcrypt), lockout, two-step codes and token issuance.
 */
export type LoginError = "invalid" | "locked" | "not_ready" | "rate_limited" | "unavailable" | "disabled" | "invalid_code" | "code_used" | "expired";

const WINDOW = 15 * 60;
// Only failed attempts count, so a whole office behind one NAT IP can sign in freely.
const MAX_FAILS_PER_IP = Number(process.env.LOGIN_MAX_FAILS_PER_IP ?? 50);
/** The pending second step of a sign-in: an opaque challenge, httpOnly, five minutes, never shown to scripts. */
const MFA_COOKIE = "wos_mfa";
const secure = config.appUrl.startsWith("https://");

async function clientIp(): Promise<string> {
  const h = await headers();
  return clientIpFrom(h) || "local";
}

/**
 * Failed sign-ins per IP in a fixed window, in this web process's memory: one web process serves the installation,
 * and a restart forgetting the counts only ever lets someone try again sooner (the gateway and identity limit too).
 */
const fails = new Map<string, { n: number; until: number }>();

async function overLimit(): Promise<boolean> {
  const f = fails.get(await clientIp());
  return !!f && f.until > Date.now() && f.n >= MAX_FAILS_PER_IP;
}

async function recordFailure(): Promise<void> {
  const ip = await clientIp();
  const now = Date.now();
  const f = fails.get(ip);
  if (f && f.until > now) f.n++;
  else fails.set(ip, { n: 1, until: now + WINDOW * 1000 });
  // Bounded: windows that ended are dropped once the map grows.
  if (fails.size > 10_000) for (const [k, v] of fails) if (v.until <= now) fails.delete(k);
}

/** POST to a public gateway auth route on the visitor's behalf (their IP and browser go along). */
async function authCall(path: string, body: unknown): Promise<Response | null> {
  const h = await headers();
  const ip = clientIpFrom(h);
  return fetch(`${config.gatewayUrl}/api/auth/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [REQUEST_ID_HEADER]: requestIdFrom(h.get(REQUEST_ID_HEADER)),
      ...(ip ? { "x-forwarded-for": ip } : {}),
      ...(h.get("user-agent") ? { "user-agent": h.get("user-agent")!.slice(0, 300) } : {}),
    },
    body: JSON.stringify(body),
    cache: "no-store",
  }).catch(() => null);
}

const errorOf = async (res: Response): Promise<LoginError> => {
  if (res.status === 429) return "rate_limited";
  if (res.status >= 500) return "unavailable";
  const e = ((await res.json().catch(() => ({}))) as { error?: string }).error;
  return e && ["invalid", "locked", "disabled", "invalid_code", "code_used", "expired"].includes(e) ? (e as LoginError) : "invalid";
};

export type LoginOk = { ok: true; mustChangePassword: boolean };

export async function passwordLogin(email: string, password: string): Promise<LoginOk | { ok: false; error: LoginError } | { ok: false; mfa: true }> {
  if (!email || !password) return { ok: false, error: "invalid" };
  if (await overLimit()) return { ok: false, error: "rate_limited" };
  const res = await authCall("login", { email, password });
  if (!res) return { ok: false, error: "unavailable" };
  if (!res.ok) {
    const error = await errorOf(res);
    if (error === "invalid") await recordFailure();
    return { ok: false, error };
  }
  const body = (await res.json()) as TokenSet | { mfa: true; challenge: string };
  if ("mfa" in body) {
    (await cookies()).set(MFA_COOKIE, body.challenge, { httpOnly: true, sameSite: "strict", secure, path: "/", maxAge: 300 });
    return { ok: false, mfa: true };
  }
  await startSession(body);
  return { ok: true, mustChangePassword: !!body.user.mustChangePassword };
}

/** The public demo's quick sign-in as a seeded account; the gateway holds the passwords and answers 404 outside the demo. */
export async function demoLogin(as: "owner" | "manager" | "staff"): Promise<boolean> {
  const res = await authCall("demo", { as });
  if (!res?.ok) return false;
  const body = (await res.json()) as TokenSet | { mfa: true };
  if ("mfa" in body) return false;
  await startSession(body);
  return true;
}

/** Second step: the code from the authenticator app, or a recovery code. */
export async function mfaLogin(code: string): Promise<LoginOk | { ok: false; error: LoginError }> {
  const c = await cookies();
  const challenge = c.get(MFA_COOKIE)?.value;
  if (!challenge) return { ok: false, error: "expired" };
  const res = await authCall("mfa", { challenge, code });
  if (!res) return { ok: false, error: "unavailable" };
  if (!res.ok) {
    const error = await errorOf(res);
    if (error === "expired") c.delete(MFA_COOKIE);
    return { ok: false, error };
  }
  c.delete(MFA_COOKIE);
  const t = (await res.json()) as TokenSet;
  await startSession(t);
  return { ok: true, mustChangePassword: !!t.user.mustChangePassword };
}

/** Writes a fresh session (new id: no fixation). */
async function startSession(t: TokenSet) {
  // One account per browser: a session this browser still holds ends at the identity module too, not only here.
  const previous = await readSession();
  if (previous) await revokeTokens(previous.refreshToken).catch(() => undefined);
  await writeSession(
    {
      accessToken: t.accessToken,
      refreshToken: t.refreshToken,
      expiresAt: Date.now() + t.expiresIn * 1000,
      userId: t.user.id,
      name: t.user.name,
      givenName: t.user.givenName || t.user.name,
      email: t.user.email,
      ...(t.user.mustChangePassword ? { mustChangePassword: true } : {}),
    },
    true,
  );
}

/** Ends the session at the identity module (its refresh token stops working at once). */
export async function revokeTokens(refreshToken: string): Promise<void> {
  await authCall("logout", { refreshToken });
}

/** Only same-app destinations after sign-in (no open redirects); the OAuth consent page counts (MCP clients). */
export function safeNext(next: string | null | undefined): string {
  return next && /^\/(app|admin|oauth\/authorize)(\/|$|\?)/.test(next) && !next.includes("\\") ? next : "/app/home";
}
