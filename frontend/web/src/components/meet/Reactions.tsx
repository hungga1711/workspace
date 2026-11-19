"use client";

import { useDataChannel, useLocalParticipant, useParticipantAttribute, useRoomContext } from "@livekit/components-react";
import { useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n/client";
import { cx, popover } from "@/lib/ui";
import { SmileIcon } from "@/components/app/icons";

const EMOJIS = ["👍", "👏", "😂", "❤️", "🎉", "🙏"] as const;
const TOPIC = "reactions";

interface Burst {
  id: number;
  emoji: string;
  name: string;
  left: number;
}

/** Emoji reactions float up the stage for a few seconds; sent to everyone over a lossy data channel. */
export function useReactions() {
  const [bursts, setBursts] = useState<Burst[]>([]);
  const n = useRef(0);
  const add = (emoji: string, name: string) => {
    if (!(EMOJIS as readonly string[]).includes(emoji)) return;
    const id = ++n.current;
    setBursts((b) => [...b.slice(-12), { id, emoji, name, left: 8 + Math.random() * 24 }]);
    setTimeout(() => setBursts((b) => b.filter((x) => x.id !== id)), 4000);
  };
  const { send } = useDataChannel(TOPIC, (msg) => {
    try {
      const emoji = new TextDecoder().decode(msg.payload);
      add(emoji, msg.from?.name || msg.from?.identity || "");
    } catch {
      /* ignore malformed */
    }
  });
  const { localParticipant } = useLocalParticipant();
  const react = (emoji: string) => {
    add(emoji, localParticipant.name || "");
    void send(new TextEncoder().encode(emoji), { reliable: false });
  };
  return { bursts, react };
}

export function ReactionLayer({ bursts }: { bursts: Burst[] }) {
  return (
    <div aria-live="polite" className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
      {bursts.map((b) => (
        <span key={b.id} className="animate-float-up absolute bottom-4 flex flex-col items-center" style={{ left: `${b.left}%` }}>
          <span className="text-4xl drop-shadow">{b.emoji}</span>
          {b.name ? <span className="bg-ground/90 text-ink mt-1 rounded px-1.5 text-xs">{b.name}</span> : null}
        </span>
      ))}
    </div>
  );
}

/** My raised hand lives in my participant attributes, so people who join later see it too. */
export function useMyHand() {
  const room = useRoomContext();
  const { localParticipant } = useLocalParticipant();
  const hand = useParticipantAttribute("hand", { participant: localParticipant });
  const toggle = () => void room.localParticipant.setAttributes({ hand: hand ? "" : String(Date.now()) }).catch(() => undefined);
  return { raised: !!hand, toggle };
}

export function ReactionPicker({ onPick, className }: { onPick: (e: string) => void; className?: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  return (
    <div ref={box} className="relative">
      <button type="button" aria-haspopup="menu" aria-expanded={open} title={t("meet.react")} aria-label={t("meet.react")} onClick={() => setOpen(!open)} className={className}>
        <SmileIcon className="size-5" />
        <span aria-hidden="true" className="sr-only sm:not-sr-only">
          {t("meet.react")}
        </span>
      </button>
      {open ? (
        <div role="menu" aria-label={t("meet.react")} className={cx(popover, "absolute bottom-[calc(100%+10px)] left-1/2 z-30 flex -translate-x-1/2 gap-1")}>
          {EMOJIS.map((e) => (
            <button
              key={e}
              type="button"
              role="menuitem"
              aria-label={e}
              onClick={() => onPick(e)}
              className={cx("hover:bg-hover grid size-10 place-items-center rounded-lg text-2xl")}
            >
              {e}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
