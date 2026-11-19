import "server-only";
import { cookies, headers } from "next/headers";
import { cache } from "react";
import { browserLocale, isLocale, LOCALE_COOKIE } from "./i18n/config";
import { getWorkspaceLocale } from "./setup";
import { redirect } from "next/navigation";
import { config } from "./config";
import { REQUEST_ID_HEADER, requestIdFrom } from "./request-id";
import { clientIpFrom } from "./client-ip";
import { hasDotSegment } from "./gateway-path";
import { forceRefresh, freshSession } from "./session";
import { SESSION_COOKIE } from "./session-cookie";
import { bffReadHeaders, retryDelayMs } from "./gateway-retry";

export class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`gateway ${status}`);
  }
}

/**
 * Where a request without a usable session goes: the sign-in screen with the page it asked for as `next` (the
 * login action only follows same-origin /app and /admin paths). "Session expired" is only true when a session
 * cookie came along; a visitor who never signed in just sees the normal screen.
 */
export async function signInUrl(): Promise<string> {
  const h = await headers();
  const path = h.get("x-pathname") ?? "";
  const hadSession = (await cookies()).has(SESSION_COOKIE);
  const qs = new URLSearchParams();
  if (hadSession) qs.set("notice", "expired");
  if (/^\/(app|admin)(\/|$|\?)/.test(path) && !path.startsWith("/app/home")) qs.set("next", path);
  const q = qs.toString();
  return q ? `/login?${q}` : "/login";
}

/** Server-side call to the gateway with the user's token (the gateway knows the installation's one workspace). */
export async function gw<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  // An id from the URL that walks to another route answers like a record that is not there.
  if (hasDotSegment(path)) throw new GatewayError(404, { error: "not_found" });
  let s = await freshSession();
  if (!s) redirect(await signInUrl());
  const h = await headers();
  const requestId = requestIdFrom(h.get(REQUEST_ID_HEADER));
  // The visitor's address, for the gateway's per-IP limits (the public demo counts per IP, not per account).
  const ip = clientIpFrom(h);
  const ua = h.get("user-agent")?.slice(0, 300);
  // The viewer's UI language, chosen as the pages choose it (i18n/server.ts getLocale: their choice, else their
  // browser's language, else the workspace's), so modules that write text answer in the language of the screen.
  const lc = (await cookies()).get(LOCALE_COOKIE)?.value;
  const locale = isLocale(lc) ? lc : (browserLocale(h.get("accept-language")) ?? (await getWorkspaceLocale()));
  const call = () =>
    fetch(`${config.gatewayUrl}${path}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${s!.accessToken}`,
        "content-type": "application/json",
        [REQUEST_ID_HEADER]: requestId,
        "x-locale": locale,
        ...(ip ? { "x-forwarded-for": ip } : {}),
        // The browser, for the audit trail (Admin › Nhật ký).
        ...(ua ? { "user-agent": ua } : {}),
        // Page-render reads count in their own bucket at the gateway, not against the person's click limit.
        ...((init.method ?? "GET") === "GET" ? bffReadHeaders() : {}),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      cache: "no-store",
    });
  let res = await call().catch(() => null);
  // A burst of clicks can trip the per-person rate limit, and a restarting server drops a connection: reads wait a
  // moment and try again (twice, backing off) instead of turning into an error page. Writes are never repeated.
  const read = (init.method ?? "GET") === "GET";
  for (let i = 0; read && i < 2 && (!res || res.status === 429 || res.status === 502 || res.status === 503); i++) {
    await new Promise((r) => setTimeout(r, retryDelayMs(i, res?.headers.get("retry-after"))));
    res = await call().catch(() => null);
  }
  if (!res) throw new GatewayError(503, { error: "unreachable" });
  let text = await res.text();
  // The account changed elsewhere (password, signed out everywhere): this session gets a new token and tries once more.
  if (res.status === 401 && text.includes('"token_stale"')) {
    s = await forceRefresh();
    if (!s) redirect(await signInUrl());
    const again = await call().catch(() => null);
    if (!again) throw new GatewayError(503, { error: "unreachable" });
    res = again;
    text = await res.text();
  }
  if (res.status === 401) redirect(await signInUrl());
  // A proxy's HTML error page is not JSON: it is an error with no body, never a crash while reading it.
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    if (res.ok) throw new GatewayError(502, { error: "bad_response" });
  }
  // The workspace requires two-step sign-in and this session has not set it up yet.
  if (res.status === 403 && (body as { error?: string } | null)?.error === "mfa_setup_required") redirect("/setup-2fa");
  // A temporary password (admin reset, invite with a password) has to be replaced before anything else.
  if (res.status === 403 && (body as { error?: string } | null)?.error === "password_change_required") redirect("/change-password");
  if (!res.ok) throw new GatewayError(res.status, body);
  return body as T;
}

const gwGet = cache((path: string) => gw<unknown>(path));
/**
 * A GET through the gateway made at most once per request: a page and its generateMetadata (title)
 * can both read the same record without a second backend call.
 */
export function gwOnce<T>(path: string): Promise<T> {
  return gwGet(path) as Promise<T>;
}
