import type { MetadataRoute } from "next";
import { getLocale } from "@/lib/i18n/server";

/** Installable web app (web/PWA instead of native apps). Light theme only. */
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  // Only the Vietnamese UI gets the Vietnamese description; every other language reads the English one.
  const locale = await getLocale();
  const en = locale !== "vi";
  return {
    name: "workspace",
    short_name: "workspace",
    description: en ? "Self-hosted work management for companies." : "Quản lý công việc tự triển khai cho doanh nghiệp.",
    lang: locale,
    start_url: "/app/home",
    scope: "/",
    display: "standalone",
    // The splash is the `ground` token; the theme colour is the light one in app/layout.tsx's viewport (the top bar's
    // `surface`), since a manifest cannot follow the colour scheme.
    background_color: "#fafafa",
    theme_color: "#ffffff",
    icons: [
      { src: "/pwa-icon/192", sizes: "192x192", type: "image/png" },
      { src: "/pwa-icon/512", sizes: "512x512", type: "image/png" },
      { src: "/pwa-icon/512-maskable", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Chat", url: "/app/chat" },
      { name: en ? "Work" : "Công việc", url: "/app/work" },
    ],
  };
}
