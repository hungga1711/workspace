import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Reads the web app makes while rendering a page (server components, `gw()` in frontend/web/src/lib/gateway.ts).
 * They carry a key derived from INTERNAL_TOKEN_SECRET, which only the server processes hold, so a browser cannot
 * claim it. Such reads get their own, larger bucket: a page render fans out into several reads, and counting them
 * against the person's limit turned a few quick clicks into a full-page error. Writes always use the person's bucket.
 */
export const BFF_READ_HEADER = "x-bff-read";

export function bffReadKey(internalSecret: string): string {
  return createHmac("sha256", internalSecret).update("workspace:bff-read:v1").digest("hex");
}

export function isBffRead(method: string, header: string | undefined, key: string): boolean {
  if (method !== "GET" || !header || header.length !== key.length) return false;
  return timingSafeEqual(Buffer.from(header), Buffer.from(key));
}
