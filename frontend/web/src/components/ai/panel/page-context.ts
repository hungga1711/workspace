import { refFromPath, titleLabel, type AskContextRef } from "@/lib/ask-context";

/** One chip per record (and per thread of a channel). */
export const refKey = (r: Pick<AskContextRef, "kind" | "id" | "thread">) => `${r.kind}:${r.id}${r.thread ? `:${r.thread}` : ""}`;

/**
 * The screen the panel was opened on, from the address, the tab title (its name) and, in chat, the thread open beside
 * the channel (ThreadPanel marks it). A peeked task (opened over another screen) is what the person is looking at.
 */
export function pageContext(): AskContextRef | null {
  // A record peeked over another screen (PeekModal) names itself on its dialog; the tab title is still the screen's.
  const peeked = document.querySelector<HTMLElement>("[role=dialog][aria-modal=true][aria-label]")?.getAttribute("aria-label")?.trim();
  const ref = refFromPath(window.location.pathname, window.location.search, peeked || titleLabel(document.title));
  if (!ref) return null;
  if (ref.code && !ref.label.includes(ref.code)) return { ...ref, label: `${ref.code} ${ref.label}`.slice(0, 200) };
  if (ref.kind === "channel" && !ref.thread) {
    const thread = document.querySelector<HTMLElement>("[data-ask-thread]")?.dataset.askThread;
    if (thread && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(thread)) return { ...ref, thread };
  }
  return ref;
}
