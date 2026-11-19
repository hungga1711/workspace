import { requireFeature } from "@/lib/features";
import type { Metadata } from "next";
import { gwOnce } from "@/lib/gateway";
import { refParam } from "@/components/work/loaders";
import { readPage } from "@/lib/page-read";
import { ReadFailed } from "@/components/ui/ReadFailed";
import { WhiteboardEditor } from "@/components/whiteboard/WhiteboardEditor";
import type { Whiteboard } from "@/components/whiteboard/types";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  await requireFeature("whiteboards");
  const b = await gwOnce<Whiteboard>(`/api/work/whiteboards/${refParam(id)}`).catch(() => null);
  return b ? { title: b.title } : {};
}

/**
 * One whiteboard (by id or code, `W-001`), full height in the panel. The page ships the board's header and the saved
 * scene; the canvas, live editing and the AI panel load in the browser after it paints.
 */
export default async function WhiteboardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await readPage(gwOnce<Whiteboard>(`/api/work/whiteboards/${refParam(id)}`));
  if (!r.data) return <ReadFailed status={r.failed} />;
  const board = r.data;
  return <WhiteboardEditor key={board.id} board={board} />;
}
