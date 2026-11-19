"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { useT } from "@/lib/i18n/client";
import { Avatar, useDirectory } from "@/lib/people";
import { cx } from "@/lib/ui";
import { PhoneIcon, PhoneOffIcon, VideoIcon } from "@/components/app/icons";
import { callUrl, type CallInfo } from "./calls";

/** A soft two-tone ring (synthesised, no audio file): 1 s on, 2 s off, until stopped. */
function ring(): () => void {
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return () => undefined;
  const ctx = new Ctx();
  // Browsers only play sound after the person has used the page; otherwise the card alone has to do.
  void ctx.resume().catch(() => undefined);
  const gain = ctx.createGain();
  gain.gain.value = 0;
  gain.connect(ctx.destination);
  for (const f of [440, 480]) {
    const o = ctx.createOscillator();
    o.frequency.value = f;
    o.connect(gain);
    o.start();
  }
  const burst = () => {
    const t = ctx.currentTime;
    gain.gain.setTargetAtTime(0.06, t, 0.02);
    gain.gain.setTargetAtTime(0, t + 1, 0.02);
  };
  burst();
  const timer = window.setInterval(burst, 3000);
  return () => {
    window.clearInterval(timer);
    void ctx.close().catch(() => undefined);
  };
}

/**
 * Someone is calling: their name and face over whatever page is open, ringing, with Answer and Decline
 * (and answer with video for a video call). The tab title blinks while the tab is in the background.
 */
export function IncomingCall({ call, onClose }: { call: CallInfo; onClose: (id: string) => void }) {
  const t = useT();
  const dir = useDirectory();
  const name = dir.name(call.from);
  const [busy, setBusy] = useState(false);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    const stop = ring();
    const title = document.title;
    const label = t("call.incomingTitle", { name });
    const blink = window.setInterval(() => (document.title = document.title === label ? title : label), 1000);
    // The server calls it missed after 30 s; this is the backstop if that word never arrives.
    const expire = window.setTimeout(() => onClose(call.id), 40_000);
    let note: Notification | null = null;
    if (document.hidden && "Notification" in window && Notification.permission === "granted") {
      note = new Notification(label, { body: t(call.video ? "call.incomingVideo" : "call.incomingVoice"), tag: call.id, requireInteraction: true });
      note.onclick = () => window.focus();
    }
    return () => {
      stop();
      window.clearInterval(blink);
      window.clearTimeout(expire);
      document.title = title;
      note?.close();
    };
  }, [call.id, call.video, name, onClose, t]);

  const answer = async () => {
    setBusy(true);
    // Opened inside the click so the browser allows it; pointed at the call once it is ours.
    const tab = window.open("about:blank", "_blank");
    try {
      await api(`chat/calls/${call.id}/accept`, { method: "POST" });
      if (tab) tab.location.href = callUrl(call);
      else window.location.href = callUrl(call);
      onClose(call.id);
    } catch {
      tab?.close();
      setGone(true);
      window.setTimeout(() => onClose(call.id), 2500);
    }
  };
  const decline = () => {
    onClose(call.id);
    void api(`chat/calls/${call.id}/decline`, { method: "POST" }).catch(() => undefined);
  };

  return (
    <div
      role="alertdialog"
      aria-modal="false"
      aria-labelledby={`call-${call.id}`}
      className="bg-surface border-hairline shadow-soft fixed inset-x-3 top-3 z-50 rounded-xl border p-4 sm:inset-x-auto sm:bottom-6 sm:right-6 sm:top-auto sm:w-[340px] print:hidden"
    >
      <div className="flex items-center gap-3">
        <span className="relative grid place-items-center">
          <span className="bg-ok/30 absolute inset-0 animate-ping rounded-full motion-reduce:animate-none" aria-hidden="true" />
          <Avatar id={call.from} size="lg" />
        </span>
        <div className="min-w-0">
          <p id={`call-${call.id}`} className="text-ink m-0 truncate text-base font-semibold">
            {name}
          </p>
          <p className="text-ink-2 m-0 text-sm" aria-live="polite">
            {gone ? t("call.gone") : t(call.video ? "call.incomingVideo" : "call.incomingVoice")}
          </p>
        </div>
      </div>
      {gone ? null : (
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={decline}
            className="bg-block text-on-brand inline-flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium hover:opacity-90"
          >
            <PhoneOffIcon className="size-4" />
            {t("call.decline")}
          </button>
          <button
            type="button"
            autoFocus
            disabled={busy}
            onClick={() => void answer()}
            className={cx(
              "bg-ok text-on-brand inline-flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium hover:opacity-90",
              busy && "opacity-60",
            )}
          >
            {call.video ? <VideoIcon className="size-4" /> : <PhoneIcon className="size-4" />}
            {t("call.answer")}
          </button>
        </div>
      )}
    </div>
  );
}
