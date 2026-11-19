"use client";

import { Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";

// The hero's stage: one video, the 65-second product tour (public/media/tour.mp4). It plays muted and looping so the
// page moves without asking for sound; "Watch the tour" starts it over with sound and controls.

const TOUR = { src: "/media/tour.mp4", poster: "/media/tour-poster.jpg" };

export function TourPlayer() {
  const video = useRef<HTMLVideoElement>(null);
  const [tour, setTour] = useState(false);

  // Playback starts on the first sign of a person (pointer, scroll, touch or key), never on its own: decoding video
  // is the heaviest thing this page could do, and a visitor who has not moved yet sees the poster just the same.
  useEffect(() => {
    const v = video.current;
    const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;
    if (!v || saveData || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const events = ["pointermove", "scroll", "touchstart", "keydown"] as const;
    const start = () => {
      stop();
      if (v.src) return;
      v.src = TOUR.src;
      void v.play().catch(() => {});
    };
    const stop = () => events.forEach((e) => window.removeEventListener(e, start));
    events.forEach((e) => window.addEventListener(e, start, { once: true, passive: true }));
    return stop;
  }, []);

  function play() {
    const v = video.current;
    if (!v) return;
    setTour(true);
    if (!v.src) v.src = TOUR.src;
    v.loop = false;
    v.muted = false;
    v.controls = true;
    v.currentTime = 0;
    void v.play().catch(() => {});
  }

  return (
    <div className="stage-in relative overflow-hidden rounded-2xl bg-[#05060a] shadow-[0_0_0_1px_#242424,0_50px_100px_-40px_rgba(0,0,0,1)]">
      <video
        ref={video}
        className="block aspect-video w-full"
        poster={TOUR.poster}
        width={1280}
        height={720}
        muted
        loop
        playsInline
        preload="none"
        aria-label="Product tour: assign a task to an AI agent with a workflow that stops for your approval, see how your team uses AI and whether it helps, and the workspace underneath"
      />
      {!tour ? (
        <button
          type="button"
          onClick={play}
          className="focus-visible:outline-signal group absolute inset-0 flex items-end justify-start bg-gradient-to-t from-black/70 via-black/0 to-black/0 p-5 text-left focus-visible:outline-2 focus-visible:outline-offset-[-4px] sm:p-7"
        >
          <span className="inline-flex items-center gap-3 rounded-full bg-white py-1.5 pl-1.5 pr-4 text-sm font-medium text-black shadow-[0_10px_30px_-10px_rgba(0,0,0,0.8)] transition-transform group-hover:-translate-y-0.5">
            <span className="inline-flex size-8 items-center justify-center rounded-full bg-black text-white">
              <Play className="size-3.5 translate-x-px fill-current" />
            </span>
            Watch the 65-second tour
            <span className="text-black/60">with sound</span>
          </span>
        </button>
      ) : null}
    </div>
  );
}
