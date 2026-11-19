"use client";

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useMemo } from "react";
import { DEFAULT_LOCALE, LOCALE_COOKIE, type Locale } from "./config";
import { tFrom, type Messages } from "./core";
import { makeFormat } from "@/lib/format";
import { setWorkspaceTimeZone } from "@/lib/timezone";

const LocaleCtx = createContext<Locale>(DEFAULT_LOCALE);
const MessagesCtx = createContext<Messages | null>(null);

/** What this server offers, from the root layout (lib/setup.ts): the UI hides what is not there. */
export interface AppFeatures {
  /** Video meetings and calls (LiveKit configured). */
  meet: boolean;
}
const FeaturesCtx = createContext<AppFeatures>({ meet: true });

/**
 * Set once in the root layout from the server's getLocale(), getTimeZone() and meetEnabled(), so SSR and hydration
 * agree. Only the active locale's messages reach the browser (the catalogs are not bundled into client code).
 * Nested providers (I18nScope) pass the root's features through.
 */
export function I18nProvider({
  locale,
  messages,
  timeZone,
  features,
  children,
}: {
  locale: Locale;
  messages: Messages;
  timeZone?: string;
  features?: AppFeatures;
  children: React.ReactNode;
}) {
  // The workspace's zone, set before any child formats a date (lib/timezone.ts).
  setWorkspaceTimeZone(timeZone);
  const inherited = useContext(FeaturesCtx);
  return (
    <LocaleCtx.Provider value={locale}>
      <MessagesCtx.Provider value={messages}>
        <FeaturesCtx.Provider value={features ?? inherited}>{children}</FeaturesCtx.Provider>
      </MessagesCtx.Provider>
    </LocaleCtx.Provider>
  );
}

const useFeatures = () => useContext(FeaturesCtx);
/** Whether to show anything that needs LiveKit: "Họp ngay", call buttons, meeting rooms. */
export const useMeetEnabled = () => useFeatures().meet;

export const useLocale = () => useContext(LocaleCtx);
export function useT() {
  const l = useLocale();
  const m = useContext(MessagesCtx);
  if (!m) throw new Error("useT() outside I18nProvider");
  return useMemo(() => tFrom(m, l), [m, l]);
}
export function useFormat() {
  const l = useLocale();
  const t = useT();
  return useMemo(() => makeFormat(l, t), [l, t]);
}

/** Switches language for this browser and re-renders server components in it. */
export function useSetLocale() {
  const router = useRouter();
  return useCallback(
    (l: Locale) => {
      document.cookie = `${LOCALE_COOKIE}=${l}; path=/; max-age=31536000; samesite=lax`;
      document.documentElement.lang = l;
      router.refresh();
    },
    [router],
  );
}
