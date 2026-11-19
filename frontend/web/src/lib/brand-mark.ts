/**
 * The workspace mark: one thick, soft w stroke that is also a cat's mouth, with a small
 * triangle nose over its middle peak. Blue to violet across the tile, on a white tile (a dark one in the dark theme).
 * One drawing on the 40-unit tile; the same drawing serves the app, icons, the offline page and the website.
 */
export const MARK = {
  /** Round-capped strokes: the w (the cat's mouth). */
  strokes: [{ d: "M10 17 C11.5 30 16 30 17.6 22.5 C18.6 18 21.4 18 22.4 22.5 C24 30 28.5 30 30 17", w: 4.4 }],
  /** Filled shapes, edged with a thin stroke so their corners round off: the nose. */
  fills: [{ d: "M18.2 12.6 H21.8 L20 15.2z" }],
  /** The gradient runs across the tile in tile units. */
  gradient: { x1: 6, y1: 8, x2: 34, y2: 32 },
} as const;

export interface MarkColors {
  tile: string;
  from: string;
  to: string;
}
/** White tile, #3B6BFF blue into #8B5CF6 violet. */
export const MARK_ON_LIGHT: MarkColors = { tile: "#ffffff", from: "#3b6bff", to: "#8b5cf6" };

/** The mark as a standalone square SVG string (icons, offline page): the tile, a hairline, the w. */
export function markSvg(c: MarkColors = MARK_ON_LIGHT): string {
  const g = MARK.gradient;
  const tile =
    c.tile === "transparent"
      ? ""
      : `<rect width="40" height="40" rx="10" fill="${c.tile}"/><rect x=".5" y=".5" width="39" height="39" rx="9.5" fill="none" stroke="#18181b" stroke-opacity=".12"/>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><defs><linearGradient id="m" gradientUnits="userSpaceOnUse" x1="${g.x1}" y1="${g.y1}" x2="${g.x2}" y2="${g.y2}">` +
    `<stop offset="0" stop-color="${c.from}"/><stop offset="1" stop-color="${c.to}"/></linearGradient></defs>${tile}` +
    `<g fill="none" stroke="url(#m)" stroke-linecap="round" stroke-linejoin="round">${MARK.strokes.map((x) => `<path d="${x.d}" stroke-width="${x.w}"/>`).join("")}</g>` +
    MARK.fills.map((x) => `<path d="${x.d}" fill="url(#m)" stroke="url(#m)" stroke-width=".8" stroke-linejoin="round"/>`).join("") +
    `</svg>`
  );
}
