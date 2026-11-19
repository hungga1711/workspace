import { detectLang, type Lang } from "./local-model.js";
import type { Deps } from "./runtime.js";

/**
 * The languages AI answers in, as locale codes. Every caller decides the answer's language here: the question's own
 * when it shows one, else the person's interface language (x-locale, forwarded by the gateway), else English.
 * Prompts name the language with LANGUAGE_NAME; text the product writes itself (lists, refusals) uses `say`.
 */
export const LOCALES = ["en", "vi", "zh", "es"] as const;
export type Loc = (typeof LOCALES)[number];

export const LANGUAGE_NAME: Record<Loc, string> = { en: "English", vi: "Vietnamese", zh: "Simplified Chinese", es: "Spanish" };

export const isLoc = (v: unknown): v is Loc => typeof v === "string" && (LOCALES as readonly string[]).includes(v);

/** The person's interface language from the request (x-locale: "en", "zh-CN", "es-MX"…), English when unknown. */
export function requestLocale(req: { headers: Record<string, unknown> }): Loc {
  const raw = String(req.headers["x-locale"] ?? "")
    .toLowerCase()
    .split(/[-_]/)[0];
  return isLoc(raw) ? raw : "en";
}

const HAN = /\p{Script=Han}/u;
// Marks Spanish does not use (á é í ó ú are shared with Vietnamese, so they decide nothing alone).
const VI_ONLY = /[ăâđêôơưàảãạằắặẳẵầấậẩẫèẻẽẹềếệểễìỉĩịòỏõọồốộổỗờớợởỡùủũụừứựửữỳỷỹỵ]/i;
const ES_MARKS = /[ñ¿¡]/i;
const ES_WORDS =
  /\b(qué|quién|quiénes|cómo|cuál|cuáles|cuántos?|cuántas?|está|están|semana|tareas?|equipo|proyectos?|retrasad[oa]s?|atrasad[oa]s?|vencid[oa]s?|terminó|terminaron|completó|completaron|hoy|vacaciones|bloquead[oa]s?|departamento|por favor|tiene|tienen|mis|nuestro|nuestra|esta|este|del|las|los|para|hay)\b/gi;

/** The language a piece of text is written in, or null when it does not say (a name, a code, "T-104"). */
export function detectLocale(text: string): Loc | null {
  if (HAN.test(text)) return "zh";
  if (VI_ONLY.test(text)) return "vi";
  if (ES_MARKS.test(text) || (text.match(ES_WORDS)?.length ?? 0) >= 2) return "es";
  return detectLang(text);
}

/** The answer's language: the question's own, else the person's interface language. */
export const replyLocale = (text: string, req: { headers: Record<string, unknown> }): Loc => detectLocale(text) ?? requestLocale(req);

/** The language for tool output and other text that exists only in English and Vietnamese (read by models). */
export const dataLang = (l: Loc): Lang => (l === "vi" ? "vi" : "en");

/** The instruction that ends every system prompt that writes for a person. */
export const replyIn = (l: Loc) => `Reply in ${LANGUAGE_NAME[l]}.`;

/** Product-written text in the answer's language. */
export const say = (l: Loc, t: Record<Loc, string>) => t[l];

/** The workspace's default language (Admin › Settings), English when it cannot be read. */
export async function workspaceLocale(d: Pick<Deps, "platform">): Promise<Loc> {
  const t = await d.platform?.request<{ locale?: string }>("GET", "/internal/workspace").catch(() => null);
  return isLoc(t?.locale) ? t.locale : "en";
}
