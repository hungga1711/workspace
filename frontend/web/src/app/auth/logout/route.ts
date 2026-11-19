import { NextResponse, type NextRequest } from "next/server";
import { config } from "@/lib/config";
import { revokeTokens } from "@/lib/auth";
import { clearSession, readSession } from "@/lib/session";

/** Ends the session at the identity module (refresh token revoked, access tokens refused), then clears ours. */
export async function POST(req: NextRequest) {
  // Only our own pages sign people out: a form on another site posting here would otherwise clear the cookies
  // (the Lax cookie is not sent cross-site, but the response's Set-Cookie still applies).
  if (req.headers.get("sec-fetch-site") === "cross-site") return new NextResponse(null, { status: 403 });
  const s = await readSession();
  if (s) await revokeTokens(s.refreshToken).catch(() => undefined);
  await clearSession();
  return NextResponse.redirect(new URL("/login?notice=signed_out", config.appUrl), 303);
}
