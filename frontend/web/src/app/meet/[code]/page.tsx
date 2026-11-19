import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { config } from "@/lib/config";
import { visitorHeaders } from "@/lib/public-gateway";
import { gw } from "@/lib/gateway";
import { readSession } from "@/lib/session";
import { meetEnabled } from "@/lib/setup";
import { authCard } from "@/lib/ui";
import { getT } from "@/lib/i18n/server";
import { I18nScope } from "@/lib/i18n/scope";
import { MeetRoom } from "@/components/meet/MeetRoom";
import { MEET_CODE, type GuestAccess, type MeetRoomInfo } from "@/components/meet/types";
import type { CallInfo } from "@/components/call/calls";

type Params = { params: Promise<{ code: string }>; searchParams: Promise<{ call?: string }> };

/**
 * A meeting link (/meet/abc-defg-hij). Members of the room's workspace join with their account;
 * anyone else joins as a guest (straight in, or through the lobby, as the host chose).
 */
const load = cache(async (code: string) => {
  if (!MEET_CODE.test(code)) return null;
  const session = await readSession();
  if (session) {
    const [member, people] = await Promise.all([
      gw<{ room: MeetRoomInfo; recording: boolean }>(`/api/work/meet/rooms/${code}`).catch(() => null),
      gw<{ members: { userId: string; displayName: string }[] }>("/api/identity/members").catch(() => ({ members: [] })),
    ]);
    // The name colleagues know you by in this workspace (the directory), not the login provider's.
    const name = people.members.find((x) => x.userId === session.userId)?.displayName ?? session.name;
    // `recording`: the server has recording set up (LiveKit Egress and storage).
    if (member) return { kind: "member" as const, session, name, people: people.members, ...member };
  }
  // Per-IP limits apply to each guest, not to the web server that asks for all of them.
  const res = await fetch(`${config.gatewayUrl}/api/meet/${code}`, { cache: "no-store", headers: await visitorHeaders() }).catch(() => null);
  if (!res?.ok) return null;
  const preview = (await res.json()) as { code: string; title: string; guestAccess: GuestAccess };
  return { kind: "guest" as const, session, preview };
});

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const t = await getT();
  const m = await load((await params).code);
  const title = m ? (m.kind === "member" ? m.room.title : m.preview.title) : t("meet.title");
  return { title, robots: { index: false, follow: false } };
}

export default async function MeetPage({ params, searchParams }: Params) {
  const { code } = await params;
  // A meeting link on a server without video meetings: say so instead of a 404.
  if (!(await meetEnabled())) {
    const t = await getT();
    return (
      <main className="grid min-h-dvh place-items-center p-4">
        <div className={authCard}>
          <h1 className="font-display m-0 mb-2 text-xl font-semibold tracking-tight">{t("meet.notConfigured")}</h1>
          <p className="text-ink-2 m-0 text-sm">{t("meet.notConfiguredBody")}</p>
        </div>
      </main>
    );
  }
  const m = await load(code);
  if (!m) notFound();
  // A one-to-one call: only its two people see it, and only in its own room.
  const callId = (await searchParams).call;
  const info = m.kind === "member" && callId && /^[0-9A-Z]{26}$/.test(callId) ? await gw<CallInfo>(`/api/chat/calls/${callId}`).catch(() => null) : null;
  const call =
    m.kind === "member" && info && info.code === code
      ? (() => {
          const peer = info.from === m.session.userId ? info.to : info.from;
          return { info, peer, peerName: m.people.find((x) => x.userId === peer)?.displayName ?? "" };
        })()
      : null;
  return (
    <I18nScope area="meet">
      {m.kind === "member" ? (
        <MeetRoom
          mode="member"
          code={code}
          title={call ? call.peerName : m.room.title}
          defaultName={m.name}
          room={m.room}
          me={m.session.userId}
          recordingEnabled={m.recording}
          call={call}
        />
      ) : (
        <MeetRoom mode="guest" code={code} title={m.preview.title} defaultName={m.session?.name ?? ""} guestAccess={m.preview.guestAccess} />
      )}
    </I18nScope>
  );
}
