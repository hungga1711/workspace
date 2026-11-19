/**
 * Identity colours (DESIGN.md › Colors): eight flat hues (`art-0`…`art-7` in globals.css), picked
 * deterministically so a department, a person or a channel keeps the same colour on every screen. Departments
 * are hashed by their name (the same name in Home, Tiến độ, Lịch and Mục tiêu gives the same colour). Identity
 * only: never for status (blue = needs you and progress, red = late/blocked).
 *
 * The class strings are spelled out in full so Tailwind generates them.
 */
export interface Tone {
  /** Solid fill: dots, department chips, channel pictures, calendar event edges. White bold text on it passes 4.6:1. */
  fill: string;
  /** Pale wash: avatar and chip backgrounds, calendar event bodies. */
  wash: string;
  /** Text on the wash or on white (≥ 5.2:1). */
  text: string;
  /** Border in the fill colour (calendar events, goal cards). */
  border: string;
}

const TONES: Tone[] = [
  { fill: "bg-art-0", wash: "bg-art-0-wash", text: "text-art-0-text", border: "border-art-0" },
  { fill: "bg-art-1", wash: "bg-art-1-wash", text: "text-art-1-text", border: "border-art-1" },
  { fill: "bg-art-2", wash: "bg-art-2-wash", text: "text-art-2-text", border: "border-art-2" },
  { fill: "bg-art-3", wash: "bg-art-3-wash", text: "text-art-3-text", border: "border-art-3" },
  { fill: "bg-art-4", wash: "bg-art-4-wash", text: "text-art-4-text", border: "border-art-4" },
  { fill: "bg-art-5", wash: "bg-art-5-wash", text: "text-art-5-text", border: "border-art-5" },
  { fill: "bg-art-6", wash: "bg-art-6-wash", text: "text-art-6-text", border: "border-art-6" },
  { fill: "bg-art-7", wash: "bg-art-7-wash", text: "text-art-7-text", border: "border-art-7" },
];

/** People and things with no department ("Chưa có phòng ban"): neutral, so they never look like a ninth team. */
export const NO_TONE: Tone = { fill: "bg-ink-2", wash: "bg-hover", text: "text-ink-2", border: "border-hairline" };

/**
 * The name reduced to plain letters and digits, so "Kỹ thuật", "kỹ thuật " and the channel slug "ky-thuat" are one
 * key: the department and its channel get the same colour.
 */
const key = (seed: string) =>
  seed
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** A stable index 0–7 for any seed (FNV-1a over `key`). */
export function toneIndex(seed: string): number {
  let h = 0x811c9dc5;
  for (const ch of key(seed)) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % TONES.length;
}

export const toneAt = (i: number): Tone => TONES[((i % TONES.length) + TONES.length) % TONES.length]!;

/** The colour of a department, by name; neutral when there is none. */
export function deptTone(name: string | null | undefined): Tone {
  return name && name.trim() ? toneAt(toneIndex(name)) : NO_TONE;
}

/** The colour of a person (their avatar), by id. */
export const personTone = (id: string): Tone => toneAt(toneIndex(id));
