import type { SceneElement } from "./types";

/**
 * Pure scene logic shared by the editor, the collab binding and the saver: no editor package here, so it is unit
 * tested and cheap to import. Elements follow the editor's rules: every change bumps `version` (ties are broken by
 * the lower `versionNonce`, as the editor's own reconcile does), deletion is a tombstone (`isDeleted`), and the
 * stacking order is the fractional `index`.
 */

/** The newer of two copies of one element (same rule on every client, so everyone converges). */
export function newer<E extends Pick<SceneElement, "version" | "versionNonce">>(a: E, b: E): E {
  if (a.version !== b.version) return a.version > b.version ? a : b;
  return a.versionNonce <= b.versionNonce ? a : b;
}

/** Stacking order: fractional index, then id (elements without an index keep their place at the end). */
const byIndex = (a: SceneElement, b: SceneElement) => {
  const x = a.index ?? "￿";
  const y = b.index ?? "￿";
  return x < y ? -1 : x > y ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/** Two scenes as one: per element id the newer copy wins; the result is in stacking order. */
export function mergeElements<E extends SceneElement>(local: readonly E[], remote: readonly E[]): E[] {
  const out = new Map<string, E>();
  for (const e of local) out.set(e.id, e);
  for (const e of remote) {
    const have = out.get(e.id);
    out.set(e.id, have ? newer(have, e) : e);
  }
  return [...out.values()].sort(byIndex);
}

/**
 * What changed since we last sent: elements whose version differs from the one recorded per id. The caller records
 * the new versions once they are sent.
 */
export function changedSince<E extends Pick<SceneElement, "id" | "version">>(sent: ReadonlyMap<string, number>, elements: readonly E[]): E[] {
  return elements.filter((e) => sent.get(e.id) !== e.version);
}

/** Deleted elements are kept a day (so a late collaborator does not bring them back), then left out of snapshots. */
export const TOMBSTONE_MS = 24 * 3600e3;
export function snapshotElements<E extends SceneElement>(elements: readonly E[], now: number): E[] {
  return elements.filter((e) => !e.isDeleted || (e.updated ?? now) > now - TOMBSTONE_MS);
}

const visible = (e: SceneElement) => !e.isDeleted;
const textOf = (e: SceneElement) => (e.originalText ?? e.text ?? "").trim();

/** Every text on the board, top to bottom, left to right: what search and the AI read. */
export function sceneText(elements: readonly SceneElement[], max = 100_000): string {
  const texts = elements
    .filter((e) => visible(e) && e.type === "text" && textOf(e))
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map(textOf);
  return texts.join("\n").slice(0, max);
}

/**
 * A sticky note: a filled rectangle with no outline, its text bound inside. Ours carry `customData.sticky`; boards
 * made elsewhere (pasted, older templates) count when they look like one.
 */
export function isSticky(e: SceneElement): boolean {
  if (e.isDeleted || e.type !== "rectangle") return false;
  if (e.customData?.sticky === true) return true;
  const filled = !!e.backgroundColor && e.backgroundColor !== "transparent";
  const hasText = !!e.boundElements?.some((b) => b.type === "text");
  return filled && e.strokeColor === "transparent" && hasText;
}

/** The stickies of a scene with their text (the bound text element's). */
export function stickies(elements: readonly SceneElement[]): { element: SceneElement; text: string }[] {
  const texts = new Map<string, string>();
  for (const e of elements) if (visible(e) && e.type === "text" && e.containerId) texts.set(e.containerId, textOf(e));
  return elements.filter(isSticky).map((element) => ({ element, text: texts.get(element.id) ?? "" }));
}

/** A task from a sticky: the first line is the title (≤ 200 characters), the whole note the description. */
export function stickyTask(text: string): { title: string; description?: string } | null {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return null;
  const first = lines[0]!;
  const title = first.length > 200 ? `${first.slice(0, 199)}…` : first;
  return lines.length > 1 || first.length > 200 ? { title, description: lines.join("\n") } : { title };
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
const overlaps = (a: Box, b: Box, margin: number) => a.x < b.x + b.width + margin && b.x < a.x + a.width + margin && a.y < b.y + b.height + margin && b.y < a.y + a.height + margin;

/** Grid offsets around the centre, nearest first; on a ring, clockwise from the right (right, down, left, up). */
function spiral(maxRing: number): [number, number][] {
  const out: [number, number][] = [];
  for (let dx = -maxRing; dx <= maxRing; dx++) for (let dy = -maxRing; dy <= maxRing; dy++) out.push([dx, dy]);
  const angle = ([dx, dy]: [number, number]) => (Math.atan2(dy, dx) + 2 * Math.PI) % (2 * Math.PI);
  return out.sort((a, b) => Math.hypot(...a) - Math.hypot(...b) || angle(a) - angle(b));
}
const SPIRAL = spiral(8);

/**
 * Where a new note goes: centred on `center` when that spot is free, else the nearest free cell of a grid around it
 * (one note plus a gap per step), spiralling out from the right as Miro does. `taken` are the notes already there.
 */
export function freeSlot(center: { x: number; y: number }, taken: readonly Box[], size: { width: number; height: number }, step = 220, margin = 8): { x: number; y: number } {
  const x0 = Math.round(center.x - size.width / 2);
  const y0 = Math.round(center.y - size.height / 2);
  for (const [dx, dy] of SPIRAL) {
    const at = { x: x0 + dx * Math.max(step, size.width + 20), y: y0 + dy * Math.max(step, size.height + 20) };
    if (!taken.some((t) => overlaps({ ...at, ...size }, t, margin))) return at;
  }
  return { x: x0, y: y0 };
}

/** Free places for several notes at once (AI ideas): each one counts as taken for the next. */
export function freeSlots(n: number, center: { x: number; y: number }, taken: readonly Box[], size: { width: number; height: number }, step = 220) {
  const all = [...taken];
  return Array.from({ length: n }, () => {
    const at = freeSlot(center, all, size, step);
    all.push({ ...at, ...size });
    return at;
  });
}

/**
 * Grouped notes as clusters: one labelled frame per group, side by side from `origin`, its notes in a
 * grid inside (two across once a group has more than three). Returns the frames and every note's new corner.
 */
export function clusterLayout(
  groups: readonly { title: string; elementIds: readonly string[] }[],
  origin: { x: number; y: number },
  size: number,
  gap = 24,
  pad = 32,
  titleH = 64,
) {
  const frames: { title: string; x: number; y: number; width: number; height: number }[] = [];
  const moves = new Map<string, { x: number; y: number }>();
  let x = origin.x;
  for (const g of groups) {
    const ids = g.elementIds.filter((id) => !moves.has(id));
    if (!ids.length) continue;
    const cols = ids.length > 3 ? 2 : 1;
    const rows = Math.ceil(ids.length / cols);
    const width = cols * size + (cols - 1) * gap + 2 * pad;
    const height = titleH + rows * size + (rows - 1) * gap + pad;
    frames.push({ title: g.title, x, y: origin.y, width, height });
    ids.forEach((id, i) => moves.set(id, { x: x + pad + (i % cols) * (size + gap), y: origin.y + titleH + Math.floor(i / cols) * (size + gap) }));
    x += width + 80;
  }
  return { frames, moves };
}
