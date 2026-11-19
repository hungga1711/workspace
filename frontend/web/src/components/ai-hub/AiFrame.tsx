"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n/client";
import { PageHeader } from "@/components/ui/PageHeader";
import { PageToolbarSlot } from "@/components/ui/PageToolbar";
import { Tabs } from "@/components/ui/Tabs";

export type AiSection = "progress" | "ask" | "adoption" | "workflows" | "connect";

/** Which AI section a path is in (/app/ai/ask…, /app/ai/adoption/report…). */
export const sectionOf = (path: string): AiSection =>
  path.startsWith("/app/ai/ask")
    ? "ask"
    : path.startsWith("/app/ai/adoption")
      ? "adoption"
      : path.startsWith("/app/ai/workflows")
        ? "workflows"
        : path.startsWith("/app/ai/connect")
          ? "connect"
          : "progress";

/**
 * AI's frame: one page header with the three sections (Tiến độ · Hỏi đáp · Áp dụng AI), in the layout so it stays put
 * while a section loads. Hỏi đáp is a full-height chat (the shell gives it the whole window), so there the tab row is
 * drawn as a strip above the chat instead of in the page column.
 */
export function AiFrame({ sections, children }: { sections: AiSection[]; children: React.ReactNode }) {
  const t = useT();
  const path = usePathname();
  const current = sectionOf(path);
  const [clicked, setClicked] = useState<string | null>(null);
  useEffect(() => setClicked(null), [current]);
  const tabs = (
    <Tabs
      label={t("aiHub.tabsLabel")}
      active={clicked ?? current}
      onSelect={setClicked}
      tabs={sections.map((key) => ({ key, label: t(`aiHub.tabs.${key}`), href: `/app/ai/${key}` }))}
    />
  );
  if (current === "ask")
    return (
      <div className="flex h-full min-h-0 flex-col">
        <h1 className="sr-only">{t("aiHub.tabs.ask")}</h1>
        {/* The same place as the other sections' tab row: the page column's sides and top, a divider under the tabs. */}
        <div className="mx-auto w-full max-w-[1600px] shrink-0 px-4 pt-4 md:px-7 md:pt-5">
          <div className="border-divider -mt-1 flex min-h-10 items-end border-b">{tabs}</div>
        </div>
        {children}
      </div>
    );
  return (
    <>
      <PageHeader title={t("aiHub.title")} className="mb-4" toolbar={<PageToolbarSlot />} tabs={tabs} />
      {children}
    </>
  );
}
