/* Kept out of lib/ui.ts so routes without icon tiles (the assistant) do not ship the map. */
/* Icon tiles: a 28px square on a pale wash with the icon in the deep tone. They mark what a card
   or a number is about, so a screen scans by shape and colour before anyone reads a word. */
export type Hue = "blue" | "green" | "red" | "orange" | "violet" | "teal" | "grey";
/* Every header icon is drawn in plain grey; the hue is kept in the API so a later theme
   can colour them again, but today each maps to the same quiet ink. */
export const HUE: Record<Hue, string> = {
  blue: "text-ink-2",
  green: "text-ink-2",
  red: "text-ink-2",
  orange: "text-ink-2",
  violet: "text-ink-2",
  teal: "text-ink-2",
  grey: "text-ink-2",
};
export const iconTile = "inline-grid size-5 shrink-0 place-items-center [&_svg]:size-4";
