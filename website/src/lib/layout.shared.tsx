import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { Wordmark } from "@/components/brand";
import { SITE } from "./site";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: <Wordmark />,
      url: "/",
    },
    // GitHub and Changelog as text links at the top of the sidebar; the sidebar footer keeps only the theme switch.
    themeSwitch: { enabled: true, mode: "light-dark" },
    links: [
      { text: "GitHub", url: SITE.repo, external: true },
      { text: "Changelog", url: `${SITE.repo}/blob/main/CHANGELOG.md`, external: true },
    ],
  };
}
