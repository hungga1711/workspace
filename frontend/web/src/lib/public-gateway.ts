import "server-only";
import { headers } from "next/headers";
import { clientIpFrom } from "@/lib/client-ip";
import { config } from "@/lib/config";
import { REQUEST_ID_HEADER, requestIdFrom } from "@/lib/request-id";

/**
 * Calls an unauthenticated gateway route (signup, password recovery) from a server action.
 * Forwards the browser's IP so the gateway's per-IP limits apply per visitor, not to the web server.
 */
export async function publicGateway(path: string, body: unknown, requestId?: string): Promise<Response> {
  const h = await headers();
  const ip = clientIpFrom(h);
  return fetch(`${config.gatewayUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", [REQUEST_ID_HEADER]: requestId ?? requestIdFrom(h.get(REQUEST_ID_HEADER)), ...(ip ? { "x-forwarded-for": ip } : {}) },
    body: JSON.stringify(body),
    cache: "no-store",
  });
}

/** Headers for a public GET to the gateway on the visitor's behalf (their IP, for per-IP limits). */
export async function visitorHeaders(): Promise<Record<string, string>> {
  const h = await headers();
  const ip = clientIpFrom(h);
  return { [REQUEST_ID_HEADER]: requestIdFrom(h.get(REQUEST_ID_HEADER)), ...(ip ? { "x-forwarded-for": ip } : {}) };
}
