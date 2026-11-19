import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Script from "next/script";
import { SITE } from "@/lib/site";
import "./global.css";

const sans = Geist({ subsets: ["latin", "latin-ext"], variable: "--font-geist" });
const mono = Geist_Mono({ subsets: ["latin", "latin-ext"], variable: "--font-geist-mono" });

export const metadata: Metadata = {
  metadataBase: new URL(SITE.url),
  title: {
    default: "Workspace: your team's workspace, connected to its AI agents",
    template: "%s · Workspace",
  },
  description:
    "A self-hosted, open-source workspace for tasks, chat and docs. Assign tasks to AI agents with workflows that wait for a person's approval, and see how your team uses AI and whether it helps.",
  alternates: { canonical: "/" },
  icons: { icon: "/favicon.svg" },
  openGraph: { images: "/og.png", siteName: "Workspace", type: "website" },
  twitter: { card: "summary_large_image" },
};

export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${sans.variable} ${mono.variable}`}
      suppressHydrationWarning
    >
      <body className="flex min-h-screen flex-col font-sans antialiased">
        {/* The landing page's motion styles are gated on this flag, so nothing is hidden when JavaScript is off. */}
        <Script id="js-flag" strategy="beforeInteractive">{"document.documentElement.dataset.js='1'"}</Script>
        {children}
      </body>
    </html>
  );
}
