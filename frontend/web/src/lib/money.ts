import { numberFormat } from "@/lib/intl";
import { INTL_TAG, type Locale } from "@/lib/i18n/config";

/**
 * Money, one format everywhere (DESIGN.md › Numbers). VND reads short ("165 tr", "2,1 tỷ", "850 ng"); every other
 * currency is Intl's own currency style in the UI language ("$0.16", "€1,250.00", "¥1,200"). `full` is the exact
 * figure for a tooltip (title attribute). Only Vietnamese says "tỷ"/"tr"/"ng"; every other language uses "B"/"M"/"k".
 */
export function formatMoney(amount: number, currency = "VND", locale: Locale = "en"): { short: string; full: string } {
  if (currency !== "VND") {
    // The UI language decides separators and where the symbol goes ("$1,250" in English, "1250 US$" in Spanish).
    const tag = INTL_TAG[locale];
    const nf = (opts: Intl.NumberFormatOptions) => {
      try {
        return numberFormat(tag, { style: "currency", currency, ...opts });
      } catch {
        // An unknown code (bad data) still prints as a number with the code behind it.
        return { format: (n: number) => `${numberFormat(tag, opts).format(n)} ${currency}`, resolvedOptions: () => ({ maximumFractionDigits: 2 }) };
      }
    };
    // Small amounts keep the currency's minor unit (cents, none for yen); from 100 up whole units are enough.
    const minor = nf({}).resolvedOptions().maximumFractionDigits ?? 2;
    const digits = Math.abs(amount) < 100 ? minor : 0;
    const short = nf({ minimumFractionDigits: digits, maximumFractionDigits: digits }).format(amount);
    return { short, full: nf({ maximumFractionDigits: 4 }).format(amount) };
  }
  const tag = INTL_TAG[locale];
  const full = numberFormat(tag, { style: "currency", currency: "VND", maximumFractionDigits: 0 }).format(amount);
  const abs = Math.abs(amount);
  const n = (v: number, max = 1) => numberFormat(tag, { maximumFractionDigits: v >= 100 ? 0 : max }).format(v);
  const units = locale === "vi" ? (["tỷ", "tr", "ng"] as const) : (["B", "M", "k"] as const);
  const sign = amount < 0 ? "-" : "";
  let short: string;
  if (abs >= 1e9) short = `${sign}${n(abs / 1e9)} ${units[0]}`;
  else if (abs >= 1e6) short = `${sign}${n(abs / 1e6)} ${units[1]}`;
  else if (abs >= 1e4) short = `${sign}${n(abs / 1e3, 0)} ${units[2]}`;
  else short = full;
  return { short, full };
}

/** The currencies the request form offers; any ISO 4217 code is accepted by the API. */
export const CURRENCIES = ["VND", "USD", "EUR", "GBP", "JPY", "SGD", "THB", "KRW", "CNY", "AUD"] as const;
