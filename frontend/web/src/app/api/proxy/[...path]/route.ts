import { browserLocale, isLocale, LOCALE_COOKIE } from "@/lib/i18n/config";
import { getWorkspaceLocale } from "@/lib/setup";
import { NextResponse, type NextRequest } from "next/server";
import { config } from "@/lib/config";
import { forceRefresh, freshSession } from "@/lib/session";
import { REQUEST_ID_HEADER, requestIdFrom } from "@/lib/request-id";
import { getT } from "@/lib/i18n/server";
import { clientIpFrom } from "@/lib/client-ip";
import { hasDotSegment } from "@/lib/gateway-path";

/**
 * Same-origin proxy for client components: attaches the httpOnly session token
 * and workspace selector, so tokens never reach browser JavaScript.
 * CSRF: state-changing calls must carry the custom header set by our fetch helper, and come from this
 * app's own origin when the browser says where they come from.
 */
const APP_ORIGIN = new URL(config.appUrl).origin;
async function handle(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const requestId = requestIdFrom(req.headers.get(REQUEST_ID_HEADER));
  const idHeader = { [REQUEST_ID_HEADER]: requestId };
  let s = await freshSession();
  if (!s) return NextResponse.json({ error: "unauthenticated", requestId }, { status: 401, headers: idHeader });
  const origin = req.headers.get("origin");
  if (req.method !== "GET" && (req.headers.get("x-wos-csrf") !== "1" || (origin && origin !== APP_ORIGIN)))
    return NextResponse.json({ error: "csrf", requestId }, { status: 403, headers: idHeader });
  const { path } = await params;
  const target = `${config.gatewayUrl}/api/${path.map(encodeURIComponent).join("/")}${req.nextUrl.search}`;
  // "." and ".." survive encodeURIComponent and fetch() would resolve them out of /api/.
  if (hasDotSegment(path.join("/"))) return NextResponse.json({ error: "not_found", requestId }, { status: 404, headers: idHeader });
  const body = ["GET", "HEAD"].includes(req.method) ? undefined : await req.text();
  // The viewer's language for modules that write text, chosen as the pages choose it (i18n/server.ts getLocale): their
  // own choice, else their browser's language, else the workspace's. Any other order answers in a language the screen
  // around it is not in (a Vietnamese page listing webhook events in English).
  const cookieLocale = req.cookies.get(LOCALE_COOKIE)?.value;
  const locale = isLocale(cookieLocale) ? cookieLocale : (browserLocale(req.headers.get("accept-language")) ?? (await getWorkspaceLocale()));
  // The visitor's address, for the gateway's per-IP limits (the public demo counts per IP, not per account).
  const ip = clientIpFrom(req.headers);
  const ua = req.headers.get("user-agent")?.slice(0, 300);
  const send = (token: string) =>
    fetch(target, {
      method: req.method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...idHeader,
        "x-locale": locale,
        ...(ip ? { "x-forwarded-for": ip } : {}),
        // The browser, for the audit trail (Admin › Nhật ký).
        ...(ua ? { "user-agent": ua } : {}),
      },
      ...(body === undefined ? {} : { body }),
      cache: "no-store",
      // The person left: a streamed answer stops being written (the backend ends the model call too).
      signal: req.signal,
    });
  let upstream = await send(s.accessToken);
  // The account changed elsewhere (password, signed out everywhere): a new token, then once more.
  if (upstream.status === 401 && (await upstream.clone().text()).includes('"token_stale"')) {
    s = await forceRefresh();
    if (!s) return NextResponse.json({ error: "unauthenticated", requestId }, { status: 401, headers: idHeader });
    upstream = await send(s.accessToken);
  }
  // The public demo refuses some admin actions (gateway, demo.ts): say so in the visitor's language, since the UI
  // shows the error's message as it is.
  if (config.demoMode && upstream.status === 403) {
    const text = await upstream.text();
    const parsed = (() => {
      try {
        return JSON.parse(text) as Record<string, unknown>;
      } catch {
        return null;
      }
    })();
    if (parsed?.error === "demo_locked") return NextResponse.json({ ...parsed, message: (await getT())("demo.locked") }, { status: 403, headers: idHeader });
    return new NextResponse(text, { status: 403, headers: { "content-type": upstream.headers.get("content-type") ?? "application/json", ...idHeader } });
  }
  // Cache headers only when the module set them (a member's photo at a versioned URL); everything else stays uncached.
  const pass = Object.fromEntries(["cache-control", "x-content-type-options"].flatMap((h) => (upstream.headers.get(h) ? [[h, upstream.headers.get(h)!]] : [])));
  // Server-Sent Events (Hỏi đáp's answer as it is written): no buffering by a proxy in front; the module's
  // "no-transform" keeps compression from holding pieces back.
  const events: Record<string, string> = upstream.headers.get("content-type")?.startsWith("text/event-stream") ? { "x-accel-buffering": "no" } : {};
  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers: { "content-type": upstream.headers.get("content-type") ?? "application/json", ...pass, ...events, ...idHeader },
  });
}

export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE };
