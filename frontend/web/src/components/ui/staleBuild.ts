/**
 * A page open across an upgrade still runs the old build's JavaScript: the first screen it has not loaded yet asks
 * for a chunk the new server no longer has, and the boundary would show "something went wrong" although a reload
 * fixes it. Such errors reload the page once instead; a second one within a minute is a real failure and shows.
 */
const KEY = "wos_stale_reload";
const WINDOW_MS = 60_000;

/** webpack's ChunkLoadError and the CSS loader's, by name or by message (minified builds keep both). */
export const isStaleBuildError = (e: { name?: string; message?: string } | null | undefined) =>
  !!e && (e.name === "ChunkLoadError" || /Loading (CSS )?chunk [\w/-]+ failed/i.test(e.message ?? ""));

/** Whether to reload now, given when this tab last reloaded for the same reason (ms, or null). */
export const shouldReload = (now: number, last: number | null) => last === null || now - last > WINDOW_MS;

/** Reloads once for a stale build; false when it did not (not that kind of error, or it already tried). */
export function reloadIfStale(e: { name?: string; message?: string }): boolean {
  if (typeof window === "undefined" || !isStaleBuildError(e)) return false;
  let last: number | null = null;
  try {
    const v = Number(sessionStorage.getItem(KEY));
    last = v > 0 ? v : null;
  } catch {
    // Storage blocked: reloading without the guard could loop, so show the screen.
    return false;
  }
  const now = Date.now();
  if (!shouldReload(now, last)) return false;
  try {
    sessionStorage.setItem(KEY, String(now));
  } catch {
    return false;
  }
  location.reload();
  return true;
}
