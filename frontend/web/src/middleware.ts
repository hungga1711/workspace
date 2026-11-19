import { NextResponse, type NextRequest } from "next/server";
import { REQUEST_ID_HEADER, requestIdFrom } from "@/lib/request-id";
import { SESSION_COOKIE, SESSION_IDLE_SECONDS, SESSION_SID } from "@/lib/session-cookie";

/**
 * Every request gets a request id (the browser's if well-formed), visible to server code via headers() and returned
 * in the response header. The BFF forwards it to the gateway, so one id follows an action end to end.
 */
export function middleware(req: NextRequest) {
  // AI Insights once lived under Progress › Overview (?view=ai); bookmarks and old shared links land on its own tab.
  const sp = req.nextUrl.searchParams;
  if (req.nextUrl.pathname === "/app/work" && sp.get("tab") === "overview" && sp.get("view") === "ai") {
    const to = req.nextUrl.clone();
    to.searchParams.set("tab", "ai");
    to.searchParams.delete("view");
    return NextResponse.redirect(to);
  }
  // A task's address is /app/work/tasks/T-1. Links from before (`?task=T-1` over any page) open it there;
  // AI › Hỏi đáp's own `?task=` (the task a question is about) is not one of them.
  const task = sp.get("task");
  if (task && req.nextUrl.pathname.startsWith("/app/") && !req.nextUrl.pathname.startsWith("/app/ai/ask")) {
    const to = req.nextUrl.clone();
    to.pathname = `/app/work/tasks/${encodeURIComponent(task)}`;
    to.search = "";
    return NextResponse.redirect(to);
  }
  const requestId = requestIdFrom(req.headers.get(REQUEST_ID_HEADER));
  const headers = new Headers(req.headers);
  headers.set(REQUEST_ID_HEADER, requestId);
  // Server layouts read the path (the admin nav's current item, the sign-in screens' language links).
  headers.set("x-pathname", req.nextUrl.pathname + req.nextUrl.search);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set(REQUEST_ID_HEADER, requestId);
  // Sliding expiry: a person who keeps using the app stays signed in (the stored session slides with each refresh).
  const sid = req.cookies.get(SESSION_COOKIE)?.value;
  if (sid && SESSION_SID.test(sid)) {
    res.cookies.set(SESSION_COOKIE, sid, {
      httpOnly: true,
      sameSite: "lax",
      secure: (req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol).startsWith("https"),
      path: "/",
      maxAge: SESSION_IDLE_SECONDS,
    });
  }
  return res;
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico|sw.js|robots.txt).*)"] };
