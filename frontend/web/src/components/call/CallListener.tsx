"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { useMeetEnabled } from "@/lib/i18n/client";
import { connectRealtime, releaseRealtime } from "@/lib/realtime";
import type { CallInfo } from "./calls";

// The ringing card (and its ringtone) is code nobody needs until a call comes in.
const IncomingCall = dynamic(() => import("./IncomingCall").then((m) => m.IncomingCall), { ssr: false });

/**
 * Listens for calls anywhere in the app. Joins the app's one realtime connection once the page is idle,
 * so it never competes with the first paint; shows the ringing card when someone calls.
 */
export function CallListener({ me }: { me: string }) {
  const meet = useMeetEnabled();
  const [ringing, setRinging] = useState<CallInfo[]>([]);
  useEffect(() => {
    // Nobody can place a call on a server without LiveKit, so there is nothing to listen for.
    if (!meet) return;
    let off = () => undefined as void;
    let cancelled = false;
    let started = false;
    const start = () => {
      started = true;
      void connectRealtime().then((s) => {
        if (cancelled) return;
        const ring = (c: CallInfo) => c.to === me && setRinging((cur) => [...cur.filter((x) => x.id !== c.id), c]);
        // Any other outcome (answered on another device, cancelled, missed) stops the ringing.
        const done = (c: CallInfo) => setRinging((cur) => cur.filter((x) => x.id !== c.id));
        const events = ["call:accepted", "call:declined", "call:missed", "call:cancelled", "call:ended"];
        s.on("call:ring", ring);
        events.forEach((e) => s.on(e, done));
        off = () => {
          s.off("call:ring", ring);
          events.forEach((e) => s.off(e, done));
        };
      });
    };
    const idle = window.requestIdleCallback ? window.requestIdleCallback(start, { timeout: 3000 }) : window.setTimeout(start, 1500);
    return () => {
      cancelled = true;
      if (window.cancelIdleCallback) window.cancelIdleCallback(idle);
      else window.clearTimeout(idle);
      off();
      if (started) releaseRealtime();
    };
  }, [me, meet]);
  if (!ringing.length) return null;
  return <IncomingCall call={ringing[ringing.length - 1]!} onClose={(id) => setRinging((cur) => cur.filter((x) => x.id !== id))} />;
}
