import { NextResponse, type NextRequest } from "next/server";
import { clientIpFrom } from "@/lib/client-ip";
import { rateLimiter } from "@/lib/rate-limit";

const METRICS = new Set(["LCP", "INP", "CLS", "TTFB", "FCP"]);

const allow = rateLimiter(600, 60_000);

/**
 * RUM sink. Emits one structured log line per sample (route, device, network, country) for the metrics
 * pipeline.
 */
export async function POST(req: NextRequest) {
  // Over the limit the sample is dropped without an error: the page has nothing to retry, and a 429 would show in its console.
  if (!allow(clientIpFrom(req.headers) || "local")) return new NextResponse(null, { status: 204 });
  const raw = await req.text();
  if (raw.length > 2000) return new NextResponse(null, { status: 413 });
  let m: { name?: string; value?: number; rating?: string; route?: string; device?: string; network?: string };
  try {
    m = JSON.parse(raw);
  } catch {
    return new NextResponse(null, { status: 400 });
  }
  if (!m.name || !METRICS.has(m.name) || typeof m.value !== "number") return new NextResponse(null, { status: 400 });
  const geo = req.headers.get("cf-ipcountry") ?? req.headers.get("x-vercel-ip-country") ?? "unknown";
  console.log(
    JSON.stringify({
      type: "rum",
      metric: m.name,
      value: m.value,
      rating: m.rating,
      route: String(m.route).slice(0, 120),
      device: m.device,
      network: m.network,
      geo,
      at: new Date().toISOString(),
    }),
  );
  return new NextResponse(null, { status: 204 });
}
