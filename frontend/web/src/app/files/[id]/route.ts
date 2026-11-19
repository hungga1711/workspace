import { NextResponse } from "next/server";
import { gw } from "@/lib/gateway";

/**
 * An image or file inside a page: checks the reader may see it (through the page it belongs to), then
 * redirects to a short-lived signed address in storage. The page keeps a stable link.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const r = await gw<{ url: string }>(`/api/work/files/${id}/download`);
    return NextResponse.redirect(r.url, { headers: { "cache-control": "private, max-age=50" } });
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}
