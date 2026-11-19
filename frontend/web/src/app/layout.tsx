import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "@/styles/globals.css";
import { config } from "@/lib/config";
import { WebVitals } from "@/components/rum/WebVitals";
import { ErrorReporter } from "@/components/rum/ErrorReporter";
import { ServiceWorker } from "@/components/rum/ServiceWorker";
import { I18nProvider } from "@/lib/i18n/client";
import { getLocale, getMessages, getT } from "@/lib/i18n/server";
import { getTimeZone, meetEnabled } from "@/lib/setup";
import { cookies } from "next/headers";
import { SYSTEM_THEME_SCRIPT, THEME_COOKIE, isThemePref } from "@/lib/theme";

const OG_LOCALE = { en: "en_US", vi: "vi_VN", zh: "zh_CN", es: "es_ES" } as const;

/*
 * Fonts (DESIGN.md → Typography), self-hosted from src/fonts. Geist and Geist Mono are one file each with the
 * Vietnamese letters in it (Geist 1.9, subset to what the app writes): the `geist` package's older files had no
 * ắ, ấ, ế…, so the browser drew those letters without their tone mark. One file per face, so a
 * Vietnamese word is never set half in one font and half in another.
 */
const geistSans = localFont({
  src: "../fonts/geist-sans.woff2",
  weight: "100 900",
  display: "swap",
  variable: "--font-geist-sans",
});
const geistMono = localFont({
  src: "../fonts/geist-mono.woff2",
  weight: "100 900",
  display: "swap",
  variable: "--font-geist-mono",
  adjustFontFallback: false,
  fallback: ["ui-monospace", "SFMono-Regular", "Menlo", "Monaco", "Consolas", "monospace"],
});
// next/font needs literal options, so the two ranges are written out in each.
// Inter Tight sets big headings and numbers (Home greeting, KPI figures); DESIGN.md › Typography.
// Inter Tight is only for display sizes, so it is not preloaded: the swap is on large text above the fold at most.
const interTight = localFont({
  src: "../fonts/inter-tight-latin.woff2",
  weight: "100 900",
  display: "swap",
  variable: "--font-inter-tight-latin",
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
    },
  ],
  adjustFontFallback: false,
  preload: false,
});
const interTightVi = localFont({
  src: "../fonts/inter-tight-vietnamese.woff2",
  weight: "100 900",
  display: "swap",
  variable: "--font-inter-tight-vi",
  declarations: [
    {
      prop: "unicode-range",
      value: "U+0102-0103, U+0110-0111, U+0128-0129, U+0168-0169, U+01A0-01A1, U+01AF-01B0, U+0300-0301, U+0303-0304, U+0308-0309, U+0323, U+0329, U+1EA0-1EF9, U+20AB",
    },
  ],
  preload: false,
});
const fontVars = [geistSans, geistMono, interTight, interTightVi].map((f) => f.variable).join(" ");

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return {
    metadataBase: new URL(config.appUrl),
    title: { default: t("meta.title"), template: "%s · workspace" },
    description: t("meta.description"),
    applicationName: "workspace",
    openGraph: { siteName: "workspace", type: "website", locale: OG_LOCALE[await getLocale()] },
    twitter: { card: "summary_large_image" },
  };
}

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#171717" },
  ],
  colorScheme: "light dark",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const pref = (await cookies()).get(THEME_COOKIE)?.value;
  const theme = isThemePref(pref) ? pref : "light";
  return (
    // The theme is on <html> from the server ("system" is settled by the script before paint).
    <html lang={locale} className={fontVars} data-theme={theme === "system" ? undefined : theme} data-theme-pref={theme} suppressHydrationWarning>
      <head>{theme === "system" ? <script dangerouslySetInnerHTML={{ __html: SYSTEM_THEME_SCRIPT }} /> : null}</head>
      <body>
        <I18nProvider locale={locale} messages={await getMessages("base")} timeZone={await getTimeZone()} features={{ meet: await meetEnabled() }}>
          {children}
        </I18nProvider>
        <WebVitals />
        <ErrorReporter />
        <ServiceWorker />
      </body>
    </html>
  );
}
