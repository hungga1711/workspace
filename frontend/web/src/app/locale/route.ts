import { NextResponse, type NextRequest } from "next/server";
import { LOCALE_COOKIE, isLocale } from "@/lib/i18n/config";

/**
 * Language switch for pages that ship no JavaScript (the sign-in screens): sets the locale cookie and returns to the
 * page the link was on. Only same-origin paths are followed back.
 */
export function GET(req: NextRequest) {
  const l = req.nextUrl.searchParams.get("l");
  const next = req.nextUrl.searchParams.get("next") ?? "/";
  // Resolve, then require the same origin: "/\\evil.com" passes a startsWith("/") check but browsers read it as "//evil.com".
  let target = new URL("/", req.nextUrl.origin);
  try {
    const u = new URL(next, req.nextUrl.origin);
    if (u.origin === req.nextUrl.origin) target = u;
  } catch {
    /* malformed: go home */
  }
  const res = NextResponse.redirect(target, 303);
  if (isLocale(l)) res.cookies.set(LOCALE_COOKIE, l, { path: "/", maxAge: 31536000, sameSite: "lax" });
  return res;
}
