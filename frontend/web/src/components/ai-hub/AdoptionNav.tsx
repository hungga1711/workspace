"use client";

import { usePathname } from "next/navigation";
import { useT } from "@/lib/i18n/client";
import { Segmented } from "@/components/ui/Segmented";
import { BookmarkIcon, ChartIcon, FileIcon, SparkleIcon } from "@/components/app/icons";

export type AdoptionView = "ideas" | "usage" | "report" | "library";
const HREF: Record<AdoptionView, string> = {
  ideas: "/app/ai/adoption",
  usage: "/app/ai/adoption/usage",
  report: "/app/ai/adoption/report",
  library: "/app/ai/adoption/library",
};
const ICON: Record<AdoptionView, React.ReactNode> = {
  ideas: <SparkleIcon />,
  usage: <ChartIcon />,
  report: <FileIcon />,
  library: <BookmarkIcon />,
};

/**
 * Áp dụng AI's views: the ideas, then (while staff AI use is recorded) usage, the weekly report and the prompt library.
 * The app's own pill track, the current view raised: four cards with hints read as decoration, not as tabs.
 * What each view is for stays as the tooltip.
 */
export function AdoptionNav({ views }: { views: AdoptionView[] }) {
  const t = useT();
  const path = usePathname();
  if (views.length < 2) return null;
  const current = (Object.entries(HREF) as [AdoptionView, string][]).reverse().find(([, href]) => path.startsWith(href))?.[0] ?? "ideas";
  return (
    <nav aria-label={t("aiHub.adoption.navLabel")} className="mb-5 print:hidden">
      <Segmented
        label={t("aiHub.adoption.navLabel")}
        // Phones: a 2×2 grid, so no view is cut off at the screen edge in any language.
        phoneGrid={views.length === 3 ? 3 : 2}
        className="max-sm:[&_svg]:hidden"
        value={current}
        options={views.map((v) => ({ value: v, label: t(`aiHub.adoption.nav.${v}`), icon: ICON[v], href: HREF[v] }))}
      />
    </nav>
  );
}
