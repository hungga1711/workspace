import type { T } from "@/lib/i18n/core";

/**
 * Admin errors the modules return as codes (`error`), worded in the reader's language. The modules' `message` is
 * English for logs and API clients; it is shown only for a code this list does not know.
 */
export function adminErrorText(tx: T, e: unknown, fallback: string): string {
  const b = (e as { body?: { error?: string; message?: string } }).body;
  switch (b?.error) {
    case "cannot_disable_self":
      return tx("admin.apiErrors.cannot_disable_self");
    case "owner_cannot_be_disabled":
      return tx("admin.apiErrors.owner_cannot_be_disabled");
    case "member_invited":
      return tx("admin.apiErrors.member_invited");
    case "role_not_allowed":
      return tx("admin.apiErrors.role_not_allowed");
    case "module_off":
      return tx("admin.apiErrors.module_off");
  }
  if ((e as { status?: number }).status === 403) return tx("admin.apiErrors.forbidden");
  return b?.message ?? fallback;
}

/** A webhook's stored reason for being switched off: a code from the platform module, or older free text. */
export const webhookDisabledText = (tx: T, reason: string) => (reason === "auto_disabled_failures" ? tx("admin.apiErrors.auto_disabled_failures") : reason);
