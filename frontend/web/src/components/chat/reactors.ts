import type { T } from "@/lib/i18n/core";

/**
 * Who reacted, in words: "Bạn, Lan và 3 người khác". The viewer comes first as "Bạn", then up to two more names
 * in the order they reacted; the API sends the first 20 people and the total.
 */
export function reactorsText(t: T, users: string[], count: number, me: string, name: (id: string) => string): string {
  const ordered = [...users.filter((u) => u === me), ...users.filter((u) => u !== me)];
  const shown = ordered.slice(0, 3).map((u) => (u === me ? t("chat.reactors.you") : name(u)));
  const rest = Math.max(count - shown.length, 0);
  if (!shown.length) return t("chat.reactors.people", { count });
  if (rest > 0) return t("chat.reactors.andMore", { names: shown.join(", "), count: rest });
  if (shown.length === 1) return shown[0]!;
  return t("chat.reactors.and", { names: shown.slice(0, -1).join(", "), last: shown.at(-1)! });
}
