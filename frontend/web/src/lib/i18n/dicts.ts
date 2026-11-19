import type { Locale } from "./config";
import { mergeCatalog, tFrom, type Messages, type T } from "./core";
import { en } from "./messages/en";
import { vi } from "./messages/vi";
import { zh } from "./messages/zh";
import { es } from "./messages/es";

/**
 * Every catalog, each merged over English so a key not yet translated reads in English rather than as a raw key.
 * Server-side and tests only: client components get one locale's messages through I18nProvider.
 */
export const DICTS: Record<Locale, Messages> = { en, vi: mergeCatalog(en, vi), zh: mergeCatalog(en, zh), es: mergeCatalog(en, es) };

export function makeT(locale: Locale): T {
  return tFrom(DICTS[locale] ?? en, locale);
}
