"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n/client";
import { PageHeader } from "@/components/ui/PageHeader";
import { Tabs } from "@/components/ui/Tabs";
import { Picker } from "@/components/ui/Picker";
import { PageCrumbProvider, type CrumbRender } from "@/components/ui/PageCrumb";
import { ApprovalIcon, BoardIcon, CalendarIcon, FileIcon, SparkleIcon, WhiteboardIcon } from "@/components/app/icons";
import { TASK_TABS, workTabOf } from "./workTabAlias";
import { useFeatures } from "@/lib/features-context";

/** Work's five destinations and AI (the sidebar lists them on wide screens; phones switch from the page header). */
const DESTINATIONS = [
  { key: "tasks", label: "work.page.tasks", Icon: BoardIcon },
  // Its own destination (/app/ai), listed here so phones reach it from the same switcher.
  { key: "ai", label: "shell.nav.aiHub", Icon: SparkleIcon },
  { key: "docs", label: "work.page.tai_lieu", Icon: FileIcon },
  { key: "whiteboards", label: "work.page.whiteboards", Icon: WhiteboardIcon },
  { key: "calendar", label: "work.page.lich", Icon: CalendarIcon },
  { key: "ops", label: "work.page.requests", Icon: ApprovalIcon },
] as const;

/** Which Work destination the URL shows, and the switcher between them (phones' page-header crumb). */
function useDestination() {
  const t = useT();
  const has = useFeatures();
  const router = useRouter();
  const tab = workTabOf(usePathname()) ?? "";
  const [clicked, setClicked] = useState<string | null>(null);
  useEffect(() => setClicked(null), [tab]);
  const render: CrumbRender = (variant) => {
    const current = clicked ?? tab;
    const destination = TASK_TABS.includes(current) ? "tasks" : DESTINATIONS.some((d) => d.key === current) ? current : "tasks";
    return (
      <Picker
        variant={variant}
        label={t("work.page.destination")}
        value={destination}
        onChange={(key) => {
          setClicked(key);
          router.push(key === "ai" ? "/app/ai/progress" : `/app/work/${key}`);
        }}
        // "ops" has no flag; the other keys are the names of the features a deployment can leave out.
        options={DESTINATIONS.filter((d) => d.key === "tasks" || d.key === "ops" || has(d.key)).map(({ key, label, Icon }) => ({
          value: key,
          label: t(label),
          icon: <Icon className="text-ink-2 size-4" />,
        }))}
      />
    );
  };
  return { render };
}

/** Work's frame around every view: gives each view's page header the destination switcher for phones. */
export function WorkFrame({ children }: { children: React.ReactNode }) {
  const { render } = useDestination();
  return <PageCrumbProvider render={render}>{children}</PageCrumbProvider>;
}

export type TasksSection = "mine" | "projects" | "goals";
const SECTION_HREF: Record<TasksSection, string> = {
  mine: "/app/work/tasks?scope=assigned",
  projects: "/app/work/tasks?view=projects",
  goals: "/app/work/goals",
};

/**
 * Việc's sections as tabs (Việc của tôi · Dự án · Mục tiêu; "tôi giao" is a switch inside Việc của tôi), so where to switch is always in sight; a
 * project's board lights "Dự án" and its crumb (Dự án › Tên dự án ▾) switches between projects.
 */
export function TasksNav({ active }: { active: TasksSection }) {
  const t = useT();
  const [clicked, setClicked] = useState<string | null>(null);
  useEffect(() => setClicked(null), [active]);
  const label = (s: TasksSection) => (s === "mine" ? t("work.page.scopeMine") : s === "projects" ? t("work.page.projectsGroup") : t("goals.tab"));
  return (
    <>
      {/* Home's head: today's date as the eyebrow over the destination's name; the h1 stays PageHeader's. */}
      <PageHeader
        title={t("work.page.tasks")}
        className="mb-4"
        tabs={
          <Tabs
            label={t("work.page.tasksTabs")}
            active={clicked ?? active}
            onSelect={setClicked}
            tabs={(Object.keys(SECTION_HREF) as TasksSection[]).map((key) => ({ key, label: label(key), href: SECTION_HREF[key] }))}
          />
        }
      />
    </>
  );
}
