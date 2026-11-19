import { config } from "@/lib/config";

/**
 * The workspace logo, public (the sign-in page shows it before anyone signs in). Passed through from the gateway with
 * its headers: the type, a year of caching for the versioned URL, and the sandboxing CSP an SVG needs.
 */
export async function GET(req: Request) {
  const up = await fetch(`${config.gatewayUrl}/api/workspace-logo${new URL(req.url).search}`, { cache: "no-store" }).catch(() => null);
  if (!up) return new Response(null, { status: 502 });
  const headers = new Headers();
  for (const h of ["content-type", "cache-control", "content-security-policy", "x-content-type-options"]) {
    const v = up.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new Response(up.ok ? await up.arrayBuffer() : null, { status: up.status, headers });
}
