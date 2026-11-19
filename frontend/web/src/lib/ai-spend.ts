import { numberFormat } from "@/lib/intl";
import { INTL_TAG, type Locale } from "@/lib/i18n/config";
import type { T } from "@/lib/i18n/core";

/**
 * What company AI costs (prices entered in Admin › Kết nối AI) and the monthly budgets that limit it
 * (ai module budgets.ts). Prices and costs are USD, the currency AI vendors bill in.
 */

/** USD with enough decimals for small amounts ($0.0042), two for the rest. */
export function usd(n: number, locale: Locale): string {
  return numberFormat(INTL_TAG[locale], {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: n > 0 && n < 1 ? 4 : 2,
  }).format(n);
}

/**
 * The message for an AI call refused because a monthly budget ran out (HTTP 429 `ai_budget_exceeded`), saying
 * whose budget it was; null for any other error, so callers keep their own message for those.
 */
export function budgetMessage(t: T, e: unknown): string | null {
  const x = e as { status?: number; body?: { error?: string; scope?: string } | null };
  if (x?.status !== 429 || x.body?.error !== "ai_budget_exceeded") return null;
  const scope = x.body.scope === "person" || x.body.scope === "department" ? x.body.scope : "workspace";
  return t(`aiw.budget.${scope}`);
}

/**
 * The message for an AI call that failed for a reason the person should know about: a budget that ran out, or the
 * AI not answering (HTTP 503 `ai_unavailable`: every connected model failed). Null for any other error.
 */
export function aiProblem(t: T, e: unknown): string | null {
  const x = e as { status?: number; body?: { error?: string } | null };
  return budgetMessage(t, e) ?? (x?.status === 503 && x.body?.error === "ai_unavailable" ? t("aiw.unavailable") : null);
}
