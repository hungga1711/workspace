import { requireFeature } from "@/lib/features";
import { PeekModal } from "@/components/ui/PeekModal";
import { MeetingView } from "@/components/work/MeetingView";
import { loadMeeting } from "@/components/work/loaders";
import { getT } from "@/lib/i18n/server";
import { meetingHref } from "@/lib/links";

/**
 * A calendar entry opened from the calendar, Home or a list: the large centred view, like a task (a
 * drawer is too narrow for notes, attendees and follow-ups side by side).
 */
export default async function MeetingPeek({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireFeature("calendar");
  const [m, tx] = await Promise.all([loadMeeting(id), getT()]);
  const e = m.detail.event;
  const kind = e.kind === "deadline" ? tx("work.calendarview.han_chot") : e.kind === "event" ? tx("work.calendarview.su_kien") : tx("work.page.cuoc_hop");
  // The header gives the context; the entry's name is the body's one title.
  return (
    <PeekModal title={e.code ? `${kind} · ${e.code}` : kind} href={meetingHref(e)}>
      <MeetingView detail={m.detail} projects={m.projects} aiEnabled={m.aiEnabled} peek />
    </PeekModal>
  );
}
