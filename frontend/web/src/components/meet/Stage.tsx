"use client";

import {
  isTrackReference,
  useIsMuted,
  useIsSpeaking,
  useParticipantAttribute,
  useSpeakingParticipants,
  VideoTrack,
  type TrackReferenceOrPlaceholder,
} from "@livekit/components-react";
import { Track } from "livekit-client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n/client";
import { btn, cx } from "@/lib/ui";
import { CopyIcon, HandIcon, MicOffIcon, PinIcon, ScreenIcon } from "@/components/app/icons";
import { displayName, kindOf, Monogram } from "./parts";

export type Layout = "grid" | "speaker";
const GAP = 12;
const MAX_TILES = 16;

const keyOf = (r: TrackReferenceOrPlaceholder) => `${r.participant.identity}:${r.source}`;

/** The column count that gives the largest tiles of the given aspect inside w × h. */
function fit(n: number, w: number, h: number, aspect: number) {
  let best = { cols: 1, width: 0 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const width = Math.min((w - GAP * (cols - 1)) / cols, ((h - GAP * (rows - 1)) / rows) * aspect);
    if (width > best.width) best = { cols, width };
  }
  return best;
}

function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => e && setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

/**
 * The video area. Grid: every tile the same size, as large as the space allows, centred. Speaker: one
 * large tile (a shared screen, the pinned person, or whoever spoke last) with the others in a strip.
 */
export function Stage({
  tracks,
  layout,
  pinned,
  setPinned,
  alone,
  code,
}: {
  tracks: TrackReferenceOrPlaceholder[];
  layout: Layout;
  pinned: string | null;
  setPinned: (k: string | null) => void;
  alone: boolean;
  code: string;
}) {
  const screen = tracks.find((r) => r.source === Track.Source.ScreenShare && isTrackReference(r));
  const speakers = useSpeakingParticipants();
  const [lastSpeaker, setLastSpeaker] = useState<string | null>(null);
  const loudest = speakers.find((p) => !p.isLocal)?.identity;
  useEffect(() => {
    if (loudest) setLastSpeaker(loudest);
  }, [loudest]);

  const cams = tracks.filter((r) => r.source === Track.Source.Camera);
  const main = tracks.find((r) => keyOf(r) === pinned) ?? screen ?? cams.find((r) => r.participant.identity === lastSpeaker) ?? cams.find((r) => !r.participant.isLocal) ?? cams[0];

  if ((layout === "speaker" || screen || pinned) && main && tracks.length > 1) {
    const rest = tracks.filter((r) => r !== main);
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 md:flex-row">
        <div className="relative min-h-0 flex-1">
          <Tile trackRef={main} pinned={keyOf(main) === pinned} onPin={() => setPinned(keyOf(main) === pinned ? null : keyOf(main))} className="absolute inset-0" />
        </div>
        <ol className="m-0 flex shrink-0 list-none gap-3 overflow-auto p-0 md:w-[232px] md:flex-col">
          {rest.map((r) => (
            <li key={keyOf(r)} className="aspect-video w-[168px] shrink-0 md:w-full">
              <Tile trackRef={r} small pinned={false} onPin={() => setPinned(keyOf(r))} className="size-full" />
            </li>
          ))}
        </ol>
      </div>
    );
  }
  return <Grid tracks={cams} alone={alone} code={code} pinned={pinned} setPinned={setPinned} />;
}

function Grid({
  tracks,
  alone,
  code,
  pinned,
  setPinned,
}: {
  tracks: TrackReferenceOrPlaceholder[];
  alone: boolean;
  code: string;
  pinned: string | null;
  setPinned: (k: string | null) => void;
}) {
  const [ref, { w, h }] = useSize<HTMLDivElement>();
  const overflow = Math.max(0, tracks.length - MAX_TILES);
  const shown = overflow ? tracks.slice(0, MAX_TILES - 1) : tracks;
  const count = shown.length + (overflow ? 1 : 0) + (alone ? 1 : 0);
  // Phones held upright get portrait tiles; everything else 16:9.
  const aspect = h > w * 1.1 ? 3 / 4 : 16 / 9;
  const { width } = fit(count, w, h, aspect);
  const box = { width: `${Math.floor(width)}px`, height: `${Math.floor(width / aspect)}px` };
  return (
    <div ref={ref} className="relative min-h-0 min-w-0 flex-1">
      {w ? (
        <ul className="absolute inset-0 m-0 flex list-none flex-wrap content-center items-center justify-center gap-3 p-0">
          {shown.map((r) => (
            <li key={keyOf(r)} style={box}>
              <Tile trackRef={r} pinned={keyOf(r) === pinned} onPin={() => setPinned(keyOf(r))} className="size-full" />
            </li>
          ))}
          {overflow ? (
            <li style={box} className="bg-surface text-ink-2 grid place-items-center rounded-xl text-lg font-semibold">
              <More count={overflow + 1} />
            </li>
          ) : null}
          {alone ? (
            <li style={box}>
              <Invite code={code} />
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

function More({ count }: { count: number }) {
  const t = useT();
  return <span>{t("meet.more", { count })}</span>;
}

/** Shown next to your own tile while nobody else is here: the link, ready to send. */
function Invite({ code }: { code: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const link = typeof location === "undefined" ? `/meet/${code}` : `${location.host}/meet/${code}`;
  const copy = async () => {
    await navigator.clipboard.writeText(`${location.origin}/meet/${code}`).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="border-ink-2/40 grid size-full content-center justify-items-center gap-3 overflow-hidden rounded-xl border border-dashed p-5 text-center">
      <p className="m-0 max-w-[32ch] text-base font-semibold">{t("meet.alone")}</p>
      <p className="bg-surface text-ink-2 m-0 max-w-full truncate rounded-md px-3 py-1.5 font-mono text-xs tabular-nums">{link}</p>
      <button type="button" className={btn} onClick={() => void copy()}>
        <CopyIcon className="size-4" />
        <span aria-live="polite">{copied ? t("meet.linkCopied") : t("meet.copyLink")}</span>
      </button>
    </div>
  );
}

/** One person (or one shared screen): video or their monogram, a name chip, a speaking ring, pin on hover. */
function Tile({ trackRef, pinned, onPin, small, className }: { trackRef: TrackReferenceOrPlaceholder; pinned: boolean; onPin: () => void; small?: boolean; className?: string }) {
  const t = useT();
  const p = trackRef.participant;
  const name = displayName(p);
  const isScreen = trackRef.source === Track.Source.ScreenShare;
  const speaking = useIsSpeaking(p);
  const camMuted = useIsMuted(trackRef);
  const micMuted = useIsMuted({ participant: p, source: Track.Source.Microphone, publication: p.getTrackPublication(Track.Source.Microphone) });
  const video = isTrackReference(trackRef) && !camMuted;
  const hand = useParticipantAttribute("hand", { participant: p });
  return (
    <div
      className={cx(
        "bg-surface group relative overflow-hidden rounded-xl outline outline-2 -outline-offset-2 transition-[outline-color] duration-200",
        speaking && !isScreen ? "outline-accent" : "outline-transparent",
        className,
      )}
    >
      {video ? (
        <VideoTrack trackRef={trackRef} className={cx("size-full", isScreen ? "bg-ground object-contain" : "object-cover", p.isLocal && !isScreen && "-scale-x-100")} />
      ) : (
        <div className="grid size-full place-items-center">
          <Monogram
            name={name}
            seed={p.identity}
            className={cx(small ? "w-[30%] max-w-14 text-base" : "w-[24%] min-w-12 max-w-32 text-[clamp(1rem,3vw,2.5rem)]", speaking && "ring-accent/60 ring-4")}
          />
        </div>
      )}
      {hand && !isScreen ? (
        <span role="img" aria-label={t("meet.handRaised", { name })} className="bg-warn-wash text-warn absolute left-2 top-2 grid size-8 place-items-center rounded-md">
          <HandIcon className="size-4" />
        </span>
      ) : null}
      <span className="bg-ground/90 text-ink absolute bottom-2 left-2 flex max-w-[calc(100%-1rem)] items-center gap-1.5 rounded-sm px-2 py-1 text-xs font-medium">
        {isScreen ? <ScreenIcon className="size-3.5 shrink-0" /> : micMuted ? <MicOffIcon className="text-block size-3.5 shrink-0" /> : null}
        {micMuted && !isScreen ? <span className="sr-only">{t("meet.micMuted")}</span> : null}
        <span className="truncate">
          {p.isLocal && !isScreen ? t("meet.you2") : name}
          {isScreen ? ` · ${t("meet.present")}` : kindOf(p) === "guest" ? <span className="text-ink-2"> · {t("meet.guest")}</span> : null}
        </span>
      </span>
      <button
        type="button"
        onClick={onPin}
        aria-pressed={pinned}
        aria-label={pinned ? t("meet.unpin") : t("meet.pin", { name })}
        title={pinned ? t("meet.unpin") : t("meet.pin", { name })}
        className={cx(
          "bg-ground/90 text-ink absolute right-2 top-2 grid size-8 place-items-center rounded-md transition-opacity focus-visible:opacity-100",
          pinned ? "opacity-100" : "opacity-0 group-hover:opacity-100",
        )}
      >
        <PinIcon className="size-4" />
      </button>
    </div>
  );
}
