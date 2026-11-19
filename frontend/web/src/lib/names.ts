/**
 * Plain-text rendering for previews (lists, notifications, search): <@userId> mentions become display
 * names (unknown ids: "@…") and chat/document Markdown markers are dropped.
 */
export function formatMentions(text: string, names: Record<string, string>): string {
  return (
    text
      .replace(/<@(agent:)?([\w-]{1,64})>/g, (_m, agent: string | undefined, id: string) => (agent ? "@Agent" : `@${names[id] ?? "…"}`))
      .replace(/```[a-z0-9+-]*\n?/gi, "")
      // Markdown tables (doc snippets in search): drop the |---| rule, read each row as "cell, cell".
      .replace(/(^|\n)[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*(?=\n|$)/g, "$1")
      .replace(
        /(^|\n)[ \t]*\|([^\n]*)\|[ \t]*(?=\n|$)/g,
        (_m, pre: string, cells: string) =>
          `${pre}${cells
            .split("|")
            .map((c) => c.trim())
            .filter(Boolean)
            .join(", ")}`,
      )
      .replace(/(^|\n)\s*(#{1,6}|>|[-*•])\s+/g, "$1")
      .replace(/\*\*([^*\n]+)\*\*/g, "$1")
      .replace(/~~([^~\n]+)~~/g, "$1")
      .replace(/`([^`\n]+)`/g, "$1")
      .replace(/(^|[^\w*])\*([^*\n]+)\*(?![\w*])/g, "$1$2")
      .replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, "$1$2")
      .replace(/\s*\n+\s*/g, " · ")
      .trim()
  );
}
