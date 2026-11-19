import { gw } from "@/lib/gateway";

/**
 * A stable address for a work file (`/app/files/<id>`), so a picture pasted into a task's description or a comment
 * can be written as Markdown: each view asks the work module (which checks the reader may see the file) for a
 * short-lived link and is sent there.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[\w-]{1,64}$/.test(id)) return new Response(null, { status: 404 });
  const r = await gw<{ url: string }>(`/api/work/files/${id}/download`).catch(() => null);
  if (!r?.url) return new Response(null, { status: 404 });
  return new Response(null, { status: 302, headers: { location: r.url, "cache-control": "private, no-store" } });
}
