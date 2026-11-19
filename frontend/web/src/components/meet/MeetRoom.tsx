"use client";

import { LiveKitRoom, type LocalUserChoices } from "@livekit/components-react";
import { DisconnectReason } from "livekit-client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import { useT } from "@/lib/i18n/client";
import { btn, btnGhost, btnPrimary, btnSm, cx } from "@/lib/ui";
import { ChevronLeftIcon } from "@/components/app/icons";
import { goBack } from "@/lib/go-back";
import { askToJoin, checkRequest } from "@/app/meet/[code]/actions";
import { Conference } from "./Conference";
import { BrandMark, Wordmark } from "@/components/ui/BrandMark";
import { PreJoin } from "./PreJoin";
import type { GuestAccess, JoinGrant, MeetRoomInfo } from "./types";
import { CallSession, hangup, type CallOutcome } from "@/components/call/CallSession";
import { callUrl, type CallInfo } from "@/components/call/calls";

type Props =
  | {
      mode: "member";
      code: string;
      title: string;
      defaultName: string;
      room: MeetRoomInfo;
      me: string;
      recordingEnabled: boolean;
      /** A one-to-one call (?call=): straight in, no device check; ends when either side hangs up. */
      call?: { info: CallInfo; peer: string; peerName: string } | null;
    }
  | { mode: "guest"; code: string; title: string; defaultName: string; guestAccess: GuestAccess };

type Stage =
  | { kind: "prejoin"; error?: string }
  | { kind: "waiting"; requestId: string; secret: string }
  | { kind: "call"; grant: JoinGrant }
  | { kind: "left"; why?: "removed" | "ended"; call?: CallOutcome }
  | { kind: "closed"; message: string };

/**
 * One meeting link, start to finish: device check and name, the lobby for guests, the call, and the
 * "you left" screen. Audio and video go browser ⇄ LiveKit; this only fetches a join token.
 */
export function MeetRoom(props: Props) {
  const t = useT();
  const [stage, setStage] = useState<Stage>(props.mode === "guest" && props.guestAccess === "off" ? { kind: "closed", message: t("meet.membersOnly") } : { kind: "prejoin" });
  const [choices, setChoices] = useState<LocalUserChoices | null>(null);
  const [busy, setBusy] = useState(false);
  const call = props.mode === "member" ? (props.call ?? null) : null;
  const callOutcome = useRef<CallOutcome | null>(null);

  const guestOutcome = (r: Awaited<ReturnType<typeof askToJoin>>) => {
    if (r.status === "admitted") return setStage({ kind: "call", grant: { url: r.url, token: r.token } });
    if (r.status === "waiting" && r.requestId && r.secret) return setStage({ kind: "waiting", requestId: r.requestId, secret: r.secret });
    if (r.status === "waiting") return; // still waiting: keep polling
    if (r.status === "denied") return setStage({ kind: "closed", message: t("meet.denied") });
    if (r.status === "expired") return setStage({ kind: "prejoin", error: t("meet.expired") });
    if (r.status === "members_only") return setStage({ kind: "closed", message: t("meet.membersOnly") });
    if (r.status === "not_found") return setStage({ kind: "closed", message: t("meet.notFound") });
    setStage({ kind: "prejoin", error: t("meet.failed") });
  };

  const join = async (c: LocalUserChoices) => {
    setChoices(c);
    setBusy(true);
    try {
      if (props.mode === "member") {
        const g = await api<JoinGrant>(`work/meet/rooms/${props.code}/join`, { method: "POST", body: { name: c.username } });
        setStage({ kind: "call", grant: g });
      } else {
        guestOutcome(await askToJoin(props.code, c.username));
      }
    } catch {
      setStage({ kind: "prejoin", error: t("meet.failed") });
    } finally {
      setBusy(false);
    }
  };

  // A call goes straight in: microphone on, camera on for a video call (both can be changed in the call).
  const autoJoined = useRef(false);
  useEffect(() => {
    if (!call || autoJoined.current) return;
    autoJoined.current = true;
    const s = call.info.state;
    if (s === "ringing" || s === "accepted") void join({ username: props.defaultName, audioEnabled: true, videoEnabled: call.info.video, audioDeviceId: "", videoDeviceId: "" });
    else setStage({ kind: "left", call: s === "declined" || s === "missed" || s === "cancelled" ? s : "ended" });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on arrival
  }, []);

  // A waiting guest asks every 2.5 s whether someone let them in.
  const waiting = stage.kind === "waiting" ? stage : null;
  const outcome = useRef(guestOutcome);
  outcome.current = guestOutcome;
  useEffect(() => {
    if (!waiting) return;
    let alive = true;
    const tick = async () => {
      const r = await checkRequest(props.code, waiting.requestId, waiting.secret).catch(() => null);
      if (!alive) return;
      if (r && r.status !== "waiting") outcome.current(r);
      else timer = setTimeout(tick, 2500);
    };
    let timer = setTimeout(tick, 2500);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [waiting, props.code]);

  if (stage.kind === "call" && choices) {
    // The call is a dark stage (video reads best on dark); everything before and after it is the app's light theme.
    return (
      <div data-theme="dark" className="bg-ground text-ink h-dvh">
        <LiveKitRoom
          className="relative h-full"
          serverUrl={stage.grant.url}
          token={stage.grant.token}
          connect
          video={choices.videoEnabled ? { deviceId: choices.videoDeviceId } : false}
          audio={choices.audioEnabled ? { deviceId: choices.audioDeviceId } : false}
          options={{ adaptiveStream: true, dynacast: true }}
          onDisconnected={(reason) => {
            if (call) {
              // Leaving a call hangs it up (cancels the ring if nobody answered yet).
              if (!callOutcome.current) hangup(call.info.id);
              return setStage({ kind: "left", call: callOutcome.current ?? "ended" });
            }
            setStage({
              kind: "left",
              why: reason === DisconnectReason.PARTICIPANT_REMOVED ? "removed" : reason === DisconnectReason.ROOM_DELETED ? "ended" : undefined,
            });
          }}
          onError={() => {
            // In a call, failing to connect (or hanging up while connecting) ends it like hanging up.
            if (call) {
              if (!callOutcome.current) hangup(call.info.id);
              return setStage({ kind: "left", call: callOutcome.current ?? "ended" });
            }
            setStage({ kind: "prejoin", error: t("meet.failed") });
          }}
        >
          {call ? <CallSession call={call.info} peer={call.peer} peerName={call.peerName} onOutcome={(o) => (callOutcome.current = o)} /> : null}
          <Conference
            code={props.code}
            title={props.title}
            member={props.mode === "member" ? { me: props.me, room: props.room, recordingEnabled: props.recordingEnabled } : null}
            oneToOne={!!call}
          />
        </LiveKitRoom>
      </div>
    );
  }

  return (
    <div className="bg-ground text-ink flex min-h-dvh flex-col">
      <header className="flex h-14 items-center gap-2 px-4 md:px-8">
        {props.mode === "member" ? (
          <Link href="/app/home" className="text-ink flex items-center gap-2 text-base font-bold no-underline">
            <BrandMark />
            <Wordmark />
          </Link>
        ) : (
          <span className="text-ink flex items-center gap-2 text-base font-bold">
            <BrandMark />
            <Wordmark />
          </span>
        )}
        {/* Before joining, the way back to where the meeting was opened from (the desktop app has no browser Back). */}
        {props.mode === "member" ? <BackButton /> : null}
      </header>
      <main className="mx-auto grid w-full max-w-[1120px] flex-1 content-center px-4 pb-10 md:px-8">
        {stage.kind === "prejoin" ? (
          <PreJoin
            code={props.code}
            title={props.title}
            guest={props.mode === "guest"}
            lobby={props.mode === "guest" && props.guestAccess === "lobby"}
            defaultName={choices?.username ?? props.defaultName}
            busy={busy}
            error={stage.error}
            onJoin={(c) => void join(c)}
          />
        ) : (
          <section
            role={stage.kind === "waiting" ? "status" : undefined}
            className="bg-surface border-hairline mx-auto grid w-full max-w-[440px] justify-items-center gap-3 rounded-xl border px-6 py-10 text-center"
          >
            {stage.kind === "waiting" ? (
              <>
                <span aria-hidden="true" className="border-hairline border-t-accent size-9 animate-spin rounded-full border-[3px]" />
                <p className="m-0 mt-1 text-lg font-semibold">{t("meet.waiting")}</p>
                <p className="text-ink-2 m-0 text-sm">{t("meet.waitingHint")}</p>
                <p className="text-ink-2 m-0 text-xs">
                  {props.title} · <span className="font-mono tabular-nums">{props.code}</span>
                </p>
              </>
            ) : (
              <>
                <p className="m-0 text-xl/tight font-semibold tracking-tight">
                  {stage.kind === "left" && stage.call && call
                    ? t(stage.call === "declined" ? "call.declined" : stage.call === "missed" ? "call.missed" : stage.call === "cancelled" ? "call.cancelled" : "call.ended", {
                        name: call.peerName,
                      })
                    : stage.kind === "closed"
                      ? stage.message
                      : stage.kind === "left" && stage.why === "removed"
                        ? t("meet.removed")
                        : stage.kind === "left" && stage.why === "ended"
                          ? t("meet.ended")
                          : t("meet.left")}
                </p>
                {stage.kind === "left" && stage.call ? null : <p className="text-ink-2 m-0 text-sm">{props.title}</p>}
                <div className="mt-3 flex flex-wrap justify-center gap-2">
                  {stage.kind === "left" && stage.call && call ? (
                    <CallAgain peer={call.peer} video={call.info.video} channelId={call.info.channelId} />
                  ) : stage.kind === "left" && stage.why !== "removed" ? (
                    <button type="button" className={btnPrimary} onClick={() => setStage({ kind: "prejoin" })}>
                      {t("meet.rejoin")}
                    </button>
                  ) : null}
                  {props.mode === "member" ? (
                    <Link href="/app/home" className={cx(btn, "no-underline")}>
                      {t("meet.backHome")}
                    </Link>
                  ) : null}
                </div>
              </>
            )}
          </section>
        )}
      </main>
    </div>
  );
}

function BackButton() {
  const t = useT();
  const router = useRouter();
  return (
    <button type="button" className={cx(btnGhost, btnSm, "ml-auto")} onClick={() => goBack(router)}>
      <ChevronLeftIcon />
      {t("meet.back")}
    </button>
  );
}

/** After a call: ring again (in this tab) or write to them instead. */
function CallAgain({ peer, video, channelId }: { peer: string; video: boolean; channelId: string }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  return (
    <>
      <button
        type="button"
        className={btnPrimary}
        disabled={busy}
        onClick={() => {
          setBusy(true);
          api<CallInfo>("chat/calls", { method: "POST", body: { userId: peer, video } })
            .then((c) => window.location.replace(callUrl(c)))
            .catch(() => setBusy(false));
        }}
      >
        {t("call.again")}
      </button>
      <Link href={`/app/chat/${channelId}`} className={cx(btn, "no-underline")}>
        {t("call.message")}
      </Link>
    </>
  );
}
