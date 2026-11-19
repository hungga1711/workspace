/**
 * Supported UI languages. English is the default and the source catalog (messages/en.ts); the others are partial
 * catalogs merged over it, so a key not yet translated shows in English. Add a locale here plus a messages file.
 */
export const LOCALES = ["en", "vi", "zh", "es"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";
/** Readable by the client (the language menu writes it); one year. */
export const LOCALE_COOKIE = "wos_locale";
/** BCP 47 tags for Intl formatting. */
export const INTL_TAG: Record<Locale, string> = { en: "en-US", vi: "vi-VN", zh: "zh-CN", es: "es-ES" };
export const LOCALE_NAME: Record<Locale, string> = { en: "English", vi: "Tiếng Việt", zh: "中文 (简体)", es: "Español" };

export const isLocale = (v: unknown): v is Locale => typeof v === "string" && (LOCALES as readonly string[]).includes(v);

/** The first of our languages the browser lists, in its order of preference (zh-TW, es-MX… match by language); null when it lists none. */
export function browserLocale(acceptLanguage: string | null): Locale | null {
  if (!acceptLanguage) return null;
  const ranked = acceptLanguage
    .split(",")
    .map((part, i) => {
      const [tag = "", ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      return { lang: tag.toLowerCase().split("-")[0], q: q ? Number(q.slice(2)) : 1, i };
    })
    .filter((x) => x.lang && x.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i);
  for (const { lang } of ranked) if (isLocale(lang)) return lang;
  return null;
}
