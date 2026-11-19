import "server-only";

/**
 * The visitor's IP for per-IP limits. X-Forwarded-For is "what the client sent, …, what each proxy
 * appended", so the left end is whatever the browser chose to send. Count TRUSTED_PROXY_HOPS proxies
 * (default 1: one load balancer or reverse proxy in front of the web app) from the right instead.
 */
export function clientIpFrom(h: Headers, hops = Number(process.env.TRUSTED_PROXY_HOPS ?? 1)): string {
  const chain = (h.get("x-forwarded-for") ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const n = Number.isInteger(hops) && hops > 0 ? hops : 1;
  return chain[Math.max(0, chain.length - n)] ?? h.get("x-real-ip")?.trim() ?? "";
}
