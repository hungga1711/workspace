/**
 * Light, dark or the device's choice. Kept in a cookie so the server renders the right theme on the
 * first paint; "system" is resolved by a two-line script in <head> (and follows the device while the page is open).
 */
export type ThemePref = "light" | "dark" | "system";
export const THEME_COOKIE = "wos_theme";
export const isThemePref = (v: unknown): v is ThemePref => v === "light" || v === "dark" || v === "system";

/** Runs before the page paints, only for "system". */
export const SYSTEM_THEME_SCRIPT = `(function(){var m=matchMedia("(prefers-color-scheme: dark)");function s(){if(document.documentElement.dataset.themePref==="system")document.documentElement.dataset.theme=m.matches?"dark":"light"}s();m.addEventListener("change",s)})();`;

/** Applies a choice at once and remembers it for a year. */
export function setThemePref(p: ThemePref) {
  const el = document.documentElement;
  el.dataset.themePref = p;
  el.dataset.theme = p === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : p;
  document.cookie = `${THEME_COOKIE}=${p}; path=/; max-age=31536000; samesite=lax`;
}

export function themePref(): ThemePref {
  const v = typeof document === "undefined" ? undefined : document.documentElement.dataset.themePref;
  return isThemePref(v) ? v : "light";
}
