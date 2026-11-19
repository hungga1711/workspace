"use client";

import type { Participant } from "livekit-client";
import { personTone } from "@/lib/identity";
import { initials } from "@/lib/people";
import { cx } from "@/lib/ui";

/**
 * The person's avatar tone (lib/identity.ts, the same as `<Avatar>`), so someone's tile matches their picture in
 * chat and the directory. Members join as `u:<userId>` (work rooms.ts), so the user id is the seed; guests fall back
 * to their name, like `AvatarFace`.
 */
const toneSeed = (seed: string | undefined, name: string) => (seed?.startsWith("u:") ? seed.slice(2) : (seed ?? name));

/** Initials on the person's colour: what a tile shows when the camera is off. */
export function Monogram({ name, seed, className }: { name: string; seed?: string; className?: string }) {
  const tone = personTone(toneSeed(seed, name));
  return (
    <span aria-hidden="true" className={cx("grid aspect-square shrink-0 select-none place-items-center rounded-full font-semibold", tone.wash, tone.text, className)}>
      {initials(name || "?")}
    </span>
  );
}

export const displayName = (p: Participant) => p.name || p.identity;

export const kindOf = (p: Participant): "member" | "guest" => {
  try {
    return (JSON.parse(p.metadata || "{}") as { kind?: string }).kind === "member" ? "member" : "guest";
  } catch {
    return "guest";
  }
};

/** mm:ss, or h:mm:ss after an hour. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${String(m).padStart(2, "0")}:${ss}`;
}
