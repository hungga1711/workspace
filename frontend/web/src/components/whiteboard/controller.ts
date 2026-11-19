import type { StickyColor } from "./palette";
import type { TemplateKey, WbLink } from "./types";

/**
 * What the board's header and panels may ask of the canvas. The canvas (and the editor package behind it) loads on
 * its own after the page paints; the header holds only this handle, so it never imports the editor.
 */
export interface BoardController {
  /** A new sticky at the pointer (or the middle of the view), selected and ready for typing (Enter). */
  addSticky: (color: StickyColor) => void;
  /** Recolours the selected stickies. */
  recolor: (color: StickyColor) => void;
  /** Places a template (the work module's, in the reader's language) in the middle of the view. */
  insertTemplate: (key: TemplateKey) => Promise<void>;
  /** New stickies, one per text, in a grid in the middle of the view (AI ideas). */
  addStickies: (texts: string[], color?: StickyColor) => void;
  /** A wide grey note with a text (an AI summary). */
  addNote: (text: string) => void;
  /** Moves stickies into titled columns, one per group (AI grouping). */
  arrange: (groups: { title: string; elementIds: string[] }[]) => void;
  /** Gives linked stickies their task's address and shows the badges. */
  setLinks: (links: WbLink[]) => void;
  exportImage: (kind: "png" | "svg") => Promise<void>;
  /** Saves now if anything changed (before the AI reads the board, before leaving). */
  save: () => Promise<void>;
}

/** A selected sticky, for "Create tasks". */
export interface SelectedSticky {
  id: string;
  text: string;
  linked: boolean;
}

export type SaveState = "idle" | "saving" | "saved" | "error";

export interface Presence {
  clientId: number;
  id: string;
  name: string;
}
