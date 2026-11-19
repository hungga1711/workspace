/**
 * Colours that live in the board's scene data. The canvas paints them itself (it cannot read CSS variables), and they
 * are saved with every element, so they are hex values here and nowhere else. Each one is a DESIGN.md token, named
 * in the comment beside it; change the token and its twin here together.
 */

/** Ink for strokes and text (`--ink`), the canvas (`--surface`). */
export const INK = "#18181b"; // --ink
export const CANVAS = "#ffffff"; // --surface

/**
 * Sticky fills: the soft washes of the design system, so a board reads like the rest of the app. The work module's
 * templates use the same six (backend whiteboard-templates.ts); keep them in step.
 */
export const STICKY_COLORS = [
  { key: "yellow", color: "#fef3c7" }, // --warn-wash
  { key: "blue", color: "#e6eefe" }, // --nav-active
  { key: "green", color: "#ecfdf5" }, // --ok-wash
  { key: "rose", color: "#fef0f0" }, // --block-wash
  { key: "sky", color: "#eff4ff" }, // --accent-wash
  { key: "grey", color: "#f4f4f5" }, // --lane
] as const;
export type StickyColor = (typeof STICKY_COLORS)[number]["key"];
export const stickyFill = (key: StickyColor) => STICKY_COLORS.find((c) => c.key === key)?.color ?? STICKY_COLORS[0].color;

/** Cluster frames (AI grouping): the lane grey with the pill edge (`--lane`, `--edge`). */
export const LANE = "#f4f4f5"; // --lane
export const EDGE = "#e4e4e7"; // --edge

/** Text drawn as soft bars in template previews (`--ink-2`). */
export const MUTED = "#6b6b72"; // --ink-2

/** Other people's cursors and selections: the eight identity hues (`--art-0` … `--art-7`). */
const PEER_COLORS = ["#5b5fd6", "#1f7f95", "#b85a26", "#c23f73", "#9b3fa0", "#7650c8", "#4d7c2a", "#8b5e3c"] as const;
export const peerColor = (id: string) => PEER_COLORS[[...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % PEER_COLORS.length]!;

/** The editor's font numbers (its FONT_FAMILY): Nunito is the clean sans it ships. */
export const FONT_NUNITO = 6;

/** A sticky's size when placed: square, like paper notes. */
export const STICKY_SIZE = 200;
