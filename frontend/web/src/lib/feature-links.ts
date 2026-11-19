// A plain module (not "use client"): server pages and client menus both read it.
/** The features a deployment can leave out (`DISABLED_FEATURES` on the server, ADR 0026). Chat and tasks are not among them. */
export type Feature = "docs" | "whiteboards" | "calendar" | "time" | "ai";

/** The optional feature an in-app address belongs to, if any: menus and palettes drop links to a feature left out. */
export function featureOfHref(href: string): Feature | null {
  if (/^\/app\/ai(\/|\?|$)/.test(href) || /^\/app\/work\?(.*&)?tab=ai(&|$)/.test(href)) return "ai";
  if (/^\/app\/time(\/|\?|$)/.test(href)) return "time";
  if (/^\/app\/work\/docs(\/|\?|$)/.test(href) || /^\/app\/work\?(.*&)?tab=(docs|files)(&|$)/.test(href)) return "docs";
  if (/^\/app\/work\/whiteboards(\/|\?|$)/.test(href) || /^\/app\/work\?(.*&)?tab=whiteboards(&|$)/.test(href)) return "whiteboards";
  if (/^\/app\/work\/(meetings|calendar)(\/|\?|$)/.test(href) || /^\/app\/work\?(.*&)?tab=(calendar|meetings)(&|$)/.test(href)) return "calendar";
  return null;
}
