import { brandIcon } from "@/lib/brand-icon";

const SIZES = new Set(["192", "512", "512-maskable"]);

/** PNG icons for the web app manifest. */
export async function GET(_req: Request, { params }: { params: Promise<{ size: string }> }) {
  const { size } = await params;
  if (!SIZES.has(size)) return new Response("not found", { status: 404 });
  const res = brandIcon(Number(size.split("-")[0]), size.endsWith("maskable"));
  res.headers.set("cache-control", "public, max-age=604800, immutable");
  return res;
}
