"use client";

import { useState } from "react";
import { useMeetEnabled, useT } from "@/lib/i18n/client";
import { useDirectory } from "@/lib/people";
import { btn, cx } from "@/lib/ui";
import { PhoneIcon, VideoIcon } from "@/components/app/icons";
import { startCall } from "./calls";

/**
 * Voice and video call buttons for one person: compact icons (a conversation header) or labelled
 * buttons (a profile). Why it could not ring (busy, Do not disturb) shows for a few seconds.
 */
export function CallButtons({ userId, variant = "icon" }: { userId: string; variant?: "icon" | "button" }) {
  const t = useT();
  const dir = useDirectory();
  const name = dir.name(userId);
  const [busy, setBusy] = useState(false);
  const [why, setWhy] = useState<string | null>(null);
  const meet = useMeetEnabled();
  // Calls ring into a LiveKit room: nothing to offer on a server without one.
  if (!meet || userId === dir.me) return null;
  const call = async (video: boolean) => {
    setBusy(true);
    const r = await startCall(userId, video);
    setBusy(false);
    if (!r) return;
    setWhy(t(r === "busy" ? "call.busy" : r === "dnd" ? "call.dnd" : "call.failed", { name }));
    window.setTimeout(() => setWhy(null), 5000);
  };
  const icon = "text-ink-soft hover:bg-hover hover:text-ink grid size-8 shrink-0 place-items-center rounded-md transition-colors disabled:opacity-50";
  return (
    <>
      {[false, true].map((video) => {
        const label = t(video ? "call.videoFor" : "call.voiceFor", { name });
        return variant === "icon" ? (
          <button key={String(video)} type="button" className={icon} disabled={busy} onClick={() => void call(video)} aria-label={label} title={label}>
            {video ? <VideoIcon /> : <PhoneIcon />}
          </button>
        ) : (
          <button key={String(video)} type="button" className={cx(btn)} disabled={busy} onClick={() => void call(video)} aria-label={label}>
            {video ? <VideoIcon className="size-4" /> : <PhoneIcon className="size-4" />}
            {t(video ? "call.video" : "call.voice")}
          </button>
        );
      })}
      {why ? (
        <p
          role="status"
          className="bg-ink text-surface shadow-soft fixed bottom-20 left-1/2 z-50 m-0 max-w-[calc(100vw-32px)] -translate-x-1/2 rounded-md px-4 py-2.5 text-sm md:bottom-8"
        >
          {why}
        </p>
      ) : null}
    </>
  );
}
