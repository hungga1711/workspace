"use client";

import { progress } from "./progress";
import { connection } from "./connection";

/**
 * Client fetch through the same-origin proxy. Each call starts its own request id,
 * which the proxy, gateway, modules and any resulting events all carry;
 * failed calls expose it as error.requestId for support reports.
 */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const requestId = crypto.randomUUID();
  // Writes show the top progress bar (reads are often background refreshes and stay quiet).
  const write = (init.method ?? "GET") !== "GET";
  if (write) progress.start();
  const res = await fetch(`/api/proxy/${path.replace(/^\//, "")}`, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", "x-wos-csrf": "1", "x-request-id": requestId },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  }).finally(() => {
    if (write) progress.done();
  });
  const text = await res.text();
  // A proxy in front (Caddy's 502 page, a body-size refusal) can answer in HTML: that is an HTTP error, not a crash.
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    if (res.ok) throw new Error(`HTTP ${res.status}: not JSON`);
  }
  // The session ended while the page stayed open: say so at this first refused action, with a way to sign back in.
  if (res.status === 401) connection.sessionExpired();
  // The workspace requires two-step sign-in and this session has not set it up yet.
  if (res.status === 403 && body?.error === "mfa_setup_required") window.location.assign("/setup-2fa");
  if (res.status === 403 && body?.error === "password_change_required") window.location.assign("/change-password");
  if (!res.ok) throw Object.assign(new Error(body?.message ?? body?.error ?? `HTTP ${res.status}`), { status: res.status, body, requestId: body?.requestId ?? requestId });
  return body as T;
}
