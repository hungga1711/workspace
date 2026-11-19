"use client";

import "@/styles/globals.css";
import { useEffect, useState } from "react";
import { ErrorScreen } from "@/components/ui/ErrorScreen";
import { reportClientError } from "@/components/rum/report";
import { I18nProvider } from "@/lib/i18n/client";
import { DEFAULT_LOCALE, isLocale, LOCALE_COOKIE, type Locale } from "@/lib/i18n/config";
import { mergeCatalog, type Catalog, type Messages } from "@/lib/i18n/core";

const CATALOGS: Record<Exclude<Locale, "en">, () => Promise<Catalog>> = {
  vi: () => import("@/lib/i18n/messages/vi").then((m) => m.vi),
  zh: () => import("@/lib/i18n/messages/zh").then((m) => m.zh),
  es: () => import("@/lib/i18n/messages/es").then((m) => m.es),
};
/** English plus the viewer's catalog over it, each downloaded only when this screen shows. */
async function loadMessages(locale: Locale): Promise<Messages> {
  const { en } = await import("@/lib/i18n/messages/en");
  return locale === "en" ? en : mergeCatalog(en, await CATALOGS[locale]());
}

/**
 * Last resort when the root layout itself fails: same screen, its own html/body. The root layout's I18nProvider is
 * gone here (ErrorScreen's useT() would throw), so the viewer's catalog loads on demand: it stays out of every page's
 * initial JavaScript and only downloads when this screen is shown.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const [i18n, setI18n] = useState<{ locale: Locale; messages: Messages } | null>(null);
  useEffect(() => {
    const cookie = document.cookie.match(new RegExp(`(?:^|; )${LOCALE_COOKIE}=([^;]*)`))?.[1];
    const locale = isLocale(cookie) ? cookie : DEFAULT_LOCALE;
    let live = true;
    loadMessages(locale).then(
      (messages) => {
        if (live) setI18n({ locale, messages });
      },
      // The catalog could not load either (offline, a new deploy): at least the error reaches the log.
      () => reportClientError({ message: error.message, stack: error.stack, digest: error.digest, kind: "boundary" }),
    );
    return () => {
      live = false;
    };
  }, [error]);
  return (
    <html lang={i18n?.locale ?? DEFAULT_LOCALE}>
      <body className="bg-ground text-ink">
        {i18n ? (
          <I18nProvider locale={i18n.locale} messages={i18n.messages}>
            <ErrorScreen error={error} reset={reset} home="/" page />
          </I18nProvider>
        ) : null}
      </body>
    </html>
  );
}
