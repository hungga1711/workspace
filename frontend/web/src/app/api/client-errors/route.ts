import { NextResponse, type NextRequest } from "next/server";
import { clientIpFrom } from "@/lib/client-ip";
import { gw } from "@/lib/gateway";
import { rateLimiter } from "@/lib/rate-limit";
import { readSession } from "@/lib/session";
import { symbolicate } from "@/lib/symbolicate";

const allow = rateLimiter(60, 60_000);
const CODE = /^[A-Z0-9-]{4,40}$/;

/**
 * Browser error sink: one structured log line per error, tagged with the user from the session (never from the
 * body), and, for a signed-in person, a row the admin can find by the code the error screen showed
 * (Admin › Lỗi trình duyệt). The minified stack is resolved to file and line with the build's source maps first.
 * Bodies are capped; the browser sends at most a few per page.
 */
export async function POST(req: NextRequest) {
  // Over the limit the sample is dropped without an error: the page has nothing to retry, and a 429 would show in its console.
  if (!allow(clientIpFrom(req.headers) || "local")) return new NextResponse(null, { status: 204 });
  const raw = await req.text();
  if (raw.length > 8000) return new NextResponse(null, { status: 413 });
  let b: { message?: string; stack?: string; componentStack?: string; route?: string; path?: string; digest?: string; kind?: string };
  try {
    b = JSON.parse(raw);
  } catch {
    return new NextResponse(null, { status: 400 });
  }
  if (typeof b.message !== "string" || !b.message) return new NextResponse(null, { status: 400 });
  const s = await readSession().catch(() => null);
  // The component stack (from our own boundary) names the owner chain that the js stack, all React internals when a
  // render or effect throws, cannot; it is resolved with the same source maps and kept after the js frames.
  const componentStack = String(b.componentStack ?? "").slice(0, 3000);
  const stack = (String(b.stack ?? "").slice(0, 4000) + (componentStack ? "\n\nComponent stack:" + componentStack : "")).slice(0, 7000);
  const frames = [...(await symbolicate(b.stack).catch(() => [])), ...(componentStack ? await symbolicate(componentStack).catch(() => []) : [])];
  const report = {
    kind: b.kind === "boundary" ? ("boundary" as const) : ("uncaught" as const),
    message: b.message.slice(0, 500),
    stack,
    frames,
    code: typeof b.digest === "string" && CODE.test(b.digest) ? b.digest : null,
    route: String(b.route ?? "").slice(0, 120),
    path: String(b.path ?? "")
      .split("?")[0]!
      .slice(0, 300),
    userAgent: (req.headers.get("user-agent") ?? "").slice(0, 200),
  };
  console.error(JSON.stringify({ type: "client_error", ...report, user: s?.userId ?? null, at: new Date().toISOString() }));
  // Only a signed-in person's error gets a row (the gateway stamps who it was); the log line is all there is for a
  // visitor on the sign-in page. A failure here must not reach the browser: the page is already broken.
  if (s && report.code) await gw("/api/platform/client-errors", { method: "POST", body: report }).catch(() => undefined);
  return new NextResponse(null, { status: 204 });
}
