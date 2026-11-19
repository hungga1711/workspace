"use client";

import { useParticipants, useRoomContext } from "@livekit/components-react";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import { useT } from "@/lib/i18n/client";
import { connectRealtime, releaseRealtime } from "@/lib/realtime";
import { Avatar } from "@/lib/people";
import { PhoneOffIcon } from "@/components/app/icons";
import type { CallInfo } from "./calls";

export type CallOutcome = "declined" | "missed" | "cancelled" | "ended";

/** Hangs up (or cancels the ring); survives the tab closing. */
export function hangup(id: string) {
  void fetch(`/api/proxy/chat/calls/${id}/hangup`, { method: "POST", keepalive: true, headers: { "content-type": "application/json", "x-wos-csrf": "1" }, body: "{}" }).catch(
    () => undefined,
  );
}

/**
 * A one-to-one call inside the meeting room: "Calling Lan…" until she answers, then out of the way.
 * Either side hanging up ends it for both, as on a phone: when she declines, does not answer, or leaves,
 * this ends the room for this side too and says why.
 */
export function CallSession({ call, peer, peerName, onOutcome }: { call: CallInfo; peer: string; peerName: string; onOutcome: (o: CallOutcome) => void }) {
  const t = useT();
  const room = useRoomContext();
  const others = useParticipants().filter((p) => !p.isLocal).length;
  const [state, setState] = useState(call.state);
  const done = useRef(false);
  const finish = (o: CallOutcome) => {
    if (done.current) return;
    done.current = true;
    onOutcome(o);
    void room.disconnect();
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;

  // Word from the server (instantly over the realtime connection; every 3 s by asking, while it rings).
  useEffect(() => {
    let off = () => undefined as void;
    let alive = true;
    const seen = (c: CallInfo) => {
      if (c.id !== call.id || !alive) return;
      setState(c.state);
      if (c.state === "declined" || c.state === "missed" || c.state === "cancelled" || c.state === "ended") finishRef.current(c.state);
    };
    void connectRealtime().then((s) => {
      if (!alive) return;
      const events = ["call:accepted", "call:declined", "call:missed", "call:cancelled", "call:ended"];
      events.forEach((e) => s.on(e, seen));
      off = () => events.forEach((e) => s.off(e, seen));
    });
    const poll = window.setInterval(() => {
      void api<CallInfo>(`chat/calls/${call.id}`)
        .then(seen)
        .catch(() => undefined);
    }, 3000);
    return () => {
      alive = false;
      window.clearInterval(poll);
      off();
      releaseRealtime();
    };
  }, [call.id]);

  // The other person was here and is gone (closed the tab, lost the connection): the call is over.
  const met = useRef(false);
  useEffect(() => {
    if (others > 0) met.current = true;
    else if (met.current && state === "accepted") {
      hangup(call.id);
      finishRef.current("ended");
    }
  }, [others, state, call.id]);

  // Answered but never arrived (their tab failed to open, the connection never came): stop waiting.
  useEffect(() => {
    if (state !== "accepted" || others > 0 || met.current) return;
    const id = window.setTimeout(() => {
      hangup(call.id);
      finishRef.current("ended");
    }, 45_000);
    return () => window.clearTimeout(id);
  }, [state, others, call.id]);

  // Closing the tab hangs up too.
  useEffect(() => {
    const bye = () => !done.current && hangup(call.id);
    window.addEventListener("pagehide", bye);
    return () => window.removeEventListener("pagehide", bye);
  }, [call.id]);

  if (state !== "ringing") return null;
  return (
    <div
      role="status"
      className="bg-surface border-hairline shadow-soft absolute inset-x-4 top-1/4 z-20 mx-auto grid max-w-[360px] justify-items-center gap-3 rounded-xl border px-8 py-7 text-center"
    >
      <span className="relative grid place-items-center">
        <span className="bg-accent/30 absolute inset-0 animate-ping rounded-full motion-reduce:animate-none" aria-hidden="true" />
        <Avatar id={peer} name={peerName} size="xl" />
      </span>
      <p className="m-0 text-xl font-semibold tracking-tight">{t("call.ringing", { name: peerName })}</p>
      <p className="text-ink-2 m-0 text-sm">{t("call.ringingHint", { name: peerName })}</p>
      <button
        type="button"
        onClick={() => {
          hangup(call.id);
          finish("cancelled");
        }}
        className="bg-block text-on-brand hover:bg-block/90 mt-2 inline-flex min-h-10 items-center gap-1.5 rounded-md px-5 text-sm font-medium"
      >
        <PhoneOffIcon className="size-4" />
        {t("call.cancel")}
      </button>
    </div>
  );
}
