/** Markdown as one line of plain text, for places that clamp it (a workflow card's description). */
export function plainText(md: string): string {
  return md
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+\.\s+)/gm, "")
    .replace(/```[a-z]*|\*\*|__|~~|`/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}
