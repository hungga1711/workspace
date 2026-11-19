import { config } from "@/lib/config";
import { visitorHeaders } from "@/lib/public-gateway";

/**
 * Private calendar subscription (https://…/cal/<token>.ics): Google Calendar, Outlook and Apple
 * Calendar poll this without signing in. The token is the only credential; the gateway checks it.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  if (!/^[A-Za-z0-9_-]{20,64}\.ics$/.test(file)) return new Response("Not found", { status: 404 });
  // Calendar services poll from many addresses: each keeps its own per-IP limit.
  const r = await fetch(`${config.gatewayUrl}/api/calendar/${file}`, { cache: "no-store", headers: await visitorHeaders() }).catch(() => null);
  if (!r?.ok) return new Response("Not found", { status: r?.status === 429 ? 429 : 404 });
  return new Response(await r.text(), {
    headers: { "content-type": "text/calendar; charset=utf-8", "cache-control": "private, max-age=900", "x-robots-tag": "noindex" },
  });
}
