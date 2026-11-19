import { NextResponse, type NextRequest } from "next/server";
import { gw } from "@/lib/gateway";
import { readSession, writeSession } from "@/lib/session";

/**
 * After "Tên gọi" changes, refresh the greeting name kept in the session. The value is read back
 * from the identity module, never taken from the request body.
 */
export async function POST(req: NextRequest) {
  if (req.headers.get("x-wos-csrf") !== "1") return NextResponse.json({ error: "csrf" }, { status: 403 });
  const s = await readSession();
  if (!s) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const { givenName } = await gw<{ givenName: string }>("/api/identity/me/name");
  await writeSession({ ...s, givenName });
  return NextResponse.json({ givenName });
}
