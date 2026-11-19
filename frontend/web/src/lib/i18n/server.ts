import "server-only";
import { cookies, headers } from "next/headers";
import { cache } from "react";
import { browserLocale, isLocale, LOCALE_COOKIE, type Locale } from "./config";
import { makeT } from "./dicts";
import { AREA_EXTRA, areaHasGroup, type MessageArea } from "./areas";
export type { MessageArea } from "./areas";

import type { Messages } from "./core";
import { makeFormat } from "@/lib/format";
import { getTimeZone, getWorkspaceLocale } from "@/lib/setup";

/**
 * The viewer's language: the cookie set from the language menu, else the browser's Accept-Language when it lists one
 * of ours (English-first product: a Spanish or Chinese browser gets its language on the first visit), else the
 * workspace's language (Admin › Settings), else English.
 */
export const getLocale = cache(async (): Promise<Locale> => {
  const h = await headers();
  const c = (await cookies()).get(LOCALE_COOKIE)?.value;
  if (isLocale(c)) return c;
  return browserLocale(h.get("accept-language")) ?? getWorkspaceLocale();
});

export async function getT() {
  return makeT(await getLocale());
}
export async function getFormat() {
  const [l] = await Promise.all([getLocale(), getTimeZone()]);
  return makeFormat(l, makeT(l));
}

/** The active locale's messages for one area (and any `extra` dotted subtrees), handed to I18nProvider. */
export async function getMessages(area: MessageArea = "base", extra: readonly string[] = []): Promise<Messages> {
  const { DICTS } = await import("./dicts");
  const all = DICTS[await getLocale()] as Record<string, unknown>;
  // Missing groups are fine at runtime: a key outside them renders as the key, which the e2e crawl catches.
  const out: Record<string, unknown> = Object.fromEntries(Object.entries(all).filter(([k]) => areaHasGroup(area, k)));
  for (const path of [...(AREA_EXTRA[area] ?? []), ...extra]) {
    const parts = path.split(".");
    let from: unknown = all;
    for (const p of parts) from = (from as Record<string, unknown> | undefined)?.[p];
    if (from === undefined) continue;
    let to = out;
    for (const p of parts.slice(0, -1)) to = (to[p] = { ...((to[p] as Record<string, unknown> | undefined) ?? {}) }) as Record<string, unknown>;
    to[parts.at(-1)!] = from;
  }
  return out as Messages;
}
