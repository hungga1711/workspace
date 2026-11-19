import { requireFeature } from "@/lib/features";
import { MeetingView } from "@/components/work/MeetingView";
import { loadMeeting } from "@/components/work/loaders";
import type { Metadata } from "next";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  await requireFeature("calendar");
  const r = await loadMeeting(id).catch(() => null);
  return r ? { title: r.detail.event.code ? `${r.detail.event.code} · ${r.detail.event.title}` : r.detail.event.title } : {};
}

/** A meeting by its id or its code (`/app/work/meetings/H-012`, `H-012-3` in a series). */
export default async function MeetingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const m = await loadMeeting(id);
  return <MeetingView detail={m.detail} projects={m.projects} aiEnabled={m.aiEnabled} />;
}
