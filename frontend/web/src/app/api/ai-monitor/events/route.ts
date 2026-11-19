import { config } from "@/lib/config";
import { visitorHeaders } from "@/lib/public-gateway";

/**
 * The workspace AI browser extension posts the prompts it saw on ChatGPT, Claude, Gemini or Copilot
 * here, with its connection code (Bearer aim_…) as the only credential; the gateway checks it.
 * Called from the extension's background worker, so it needs CORS for chrome-extension:// origins.
 */
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-max-age": "86400",
};

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function POST(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  if (!/^Bearer aim_[A-Za-z0-9_-]{20,64}$/.test(auth)) return Response.json({ error: "connection code required" }, { status: 401, headers: CORS });
  const body = await req.text();
  if (body.length > 1_000_000) return Response.json({ error: "too large" }, { status: 413, headers: CORS });
  const r = await fetch(`${config.gatewayUrl}/api/ai-monitor/events`, {
    method: "POST",
    headers: { ...(await visitorHeaders()), authorization: auth, "content-type": "application/json" },
    body,
    cache: "no-store",
  }).catch(() => null);
  if (!r) return Response.json({ error: "unavailable" }, { status: 502, headers: CORS });
  return new Response(await r.text(), { status: r.status, headers: { ...CORS, "content-type": "application/json" } });
}
