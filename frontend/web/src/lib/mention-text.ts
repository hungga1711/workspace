/**
 * Editing text that carries <@userId> mention tokens: people see "@Lan Nguyễn" while they edit, and the tokens come
 * back on save. A name typed by hand ("@Huy Trần") also becomes a mention when it is exactly someone's display name.
 */
export function tokensToNames(body: string, names: Record<string, string>): string {
  return body.replace(/<@([\w-]{1,64})>/g, (m, id: string) => (names[id] ? `@${names[id]}` : m));
}

export function namesToTokens(text: string, people: { id: string; name: string }[]): string {
  // Longest names first so "Lan Nguyễn Thị" wins over "Lan"; a name must end at a word boundary ("@Lan" ≠ "@Lanh").
  return [...people]
    .filter((p) => p.name.trim())
    .sort((a, b) => b.name.length - a.name.length)
    .reduce((s, p) => s.replace(new RegExp(`@${p.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "gu"), `<@${p.id}>`), text);
}
