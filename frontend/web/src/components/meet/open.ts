import type { useRouter } from "next/navigation";
import { api } from "@/lib/client";
import type { MeetRoomInfo } from "./types";

/** Creates (or, for a calendar meeting, reuses) a video room and opens it. */
export async function openMeeting(router: ReturnType<typeof useRouter>, body: { title?: string; eventId?: string } = {}) {
  const room = await api<MeetRoomInfo>("work/meet/rooms", { method: "POST", body });
  router.push(`/meet/${room.code}`);
}
