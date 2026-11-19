/**
 * Puts text into a chat composer from elsewhere on the page (an AI answer's follow-up), never sending it. The composer
 * with that id listens (Composer.tsx); `id` is "composer" for a channel's box and "thread-reply" for a thread's.
 */
export const COMPOSE_EVENT = "workspace:compose";

export function composeInto(id: string, text: string): void {
  window.dispatchEvent(new CustomEvent(COMPOSE_EVENT, { detail: { id, text } }));
}
