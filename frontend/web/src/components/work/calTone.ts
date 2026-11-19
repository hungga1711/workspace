import type { CalEvent } from "./types";

/**
 * An entry's colour by kind, the same in the week grid, the month grid and the list: meetings blue, deadlines red,
 * other events violet. A pending invitation is dashed, a declined one grey and struck through.
 */
export const KIND_TONE: Record<string, { block: string; dot: string }> = {
  meeting: { block: "border-l-accent bg-accent-wash", dot: "bg-accent" },
  deadline: { block: "border-l-block bg-block-wash", dot: "bg-block" },
  event: { block: "border-l-violet bg-violet-wash", dot: "bg-violet" },
};
export const toneOf = (e: CalEvent) => KIND_TONE[e.kind] ?? KIND_TONE.event!;
