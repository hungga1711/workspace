import { createHmac } from "node:crypto";

/** Same derivation as backend/server/src/modules/gateway/bff-read.ts; the secret never leaves the server. */
const BFF_READ_HEADER = "x-bff-read";
let key: string | undefined;
export function bffReadHeaders(): Record<string, string> {
  key ??= createHmac("sha256", process.env.INTERNAL_TOKEN_SECRET ?? "dev-internal-secret-change-me-32bytes!")
    .update("workspace:bff-read:v1")
    .digest("hex");
  return { [BFF_READ_HEADER]: key };
}

/**
 * How long a read waits before trying again (attempt 0, 1). A Retry-After from the gateway is honoured but capped:
 * the person is waiting on the page, so a long wait is worse than showing the section's retry.
 */
export function retryDelayMs(attempt: number, retryAfter: string | null | undefined): number {
  const backoff = 600 * (attempt + 1);
  const secs = retryAfter ? Number(retryAfter) : NaN;
  if (!Number.isFinite(secs) || secs < 0) return backoff;
  return Math.min(1500, Math.max(200, secs * 1000));
}
