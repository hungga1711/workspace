"use client";

import { useT } from "@/lib/i18n/client";
import { PageHeader } from "@/components/ui/PageHeader";
import { Tabs } from "@/components/ui/Tabs";
import { workSubTabs } from "@/components/work/workTabAlias";

/** Tài liệu's header, shared by Trang (DocsHome) and Tệp (DriveView): the two sub-views (the top bar names Tài liệu), the view's actions. */
export function DocsHeader({ active, actions, className }: { active: "pages" | "files"; actions?: React.ReactNode; className?: string }) {
  const t = useT();
  return (
    <>
      <PageHeader
        title={t("work.page.tai_lieu")}
        actions={actions}
        tabs={<Tabs label={t("docs.switch.label")} active={active} tabs={workSubTabs("docs", t)} />}
        className={className}
      />
    </>
  );
}
