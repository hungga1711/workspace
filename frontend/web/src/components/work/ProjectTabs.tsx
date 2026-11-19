import Link from "next/link";
import { getT } from "@/lib/i18n/server";
import { cx } from "@/lib/ui";

/**
 * Overview | Board under a project's header. Links, so each view has its own address and the back button works.
 * Reviews (pull and merge requests linked to the project's tasks) joins them once a code host is connected.
 */
export async function ProjectTabs({ id, current, reviews }: { id: string; current: "overview" | "board" | "reviews"; reviews?: boolean }) {
  const t = await getT();
  const tabs = [
    { key: "overview", href: `/app/work/projects/${id}?view=overview`, label: t("projectOverview.overview") },
    { key: "board", href: `/app/work/projects/${id}`, label: t("projectOverview.board") },
    ...(reviews ? [{ key: "reviews", href: `/app/work/projects/${id}?view=reviews`, label: t("hub.reviews.tab") }] : []),
  ];
  return (
    <nav aria-label={t("projectOverview.tabs")} className="border-hairline mb-4 flex gap-5 border-b">
      {tabs.map((x) => (
        <Link
          key={x.key}
          href={x.href}
          aria-current={current === x.key ? "page" : undefined}
          className={cx("-mb-px border-b-2 pb-2.5 text-sm no-underline", current === x.key ? "border-ink text-ink font-medium" : "text-ink-2 hover:text-ink border-transparent")}
        >
          {x.label}
        </Link>
      ))}
    </nav>
  );
}
