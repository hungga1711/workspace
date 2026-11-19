"use client";

import { ProjectBadge } from "@/components/ui/ProjectBadge";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useDirectory } from "@/lib/people";
import { useT } from "@/lib/i18n/client";
import { cx, menuItem } from "@/lib/ui";
import { Picker } from "@/components/ui/Picker";
import { Segmented } from "@/components/ui/Segmented";
import { ArrowRightIcon, ChevronRightIcon } from "@/components/app/icons";
import type { Project } from "./types";
import { SCOPE_COOKIE, scopeCookieValue } from "./scopeCookie";

export type Scope = "mine" | "owned" | "projects" | { project: string };

const value = (s: Scope) => (typeof s === "string" ? `scope:${s}` : s.project);

/**
 * The left end of Việc's toolbar. The section itself is a tab above (TasksNav); "Việc của tôi" adds its two sides
 * (giao cho tôi · tôi giao) and an open project its crumb,
 * "Dự án › Tuyển dụng 2026 ▾": "Dự án" goes back to every project, the name switches to another one, and the menu's
 * last row opens the project's own page. It also remembers the scope, so Việc reopens where this person left it.
 */
export function ScopeCrumb({ scope, projects }: { scope: Scope; projects: Project[] }) {
  const t = useT();
  const router = useRouter();
  const { me } = useDirectory();
  const key = value(scope);
  useEffect(() => {
    if (!me) return;
    document.cookie = `${SCOPE_COOKIE}=${scopeCookieValue(me, scope)}; path=/; max-age=31536000; samesite=lax`;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is the scope's identity
  }, [me, key]);
  if (scope === "projects") return null;
  // "Việc của tôi" is one tab: what was handed to me and what I handed out are two sides of it.
  if (scope === "mine" || scope === "owned")
    return (
      <Segmented
        label={t("work.page.scopeMine")}
        value={scope}
        options={[
          { value: "mine", label: t("work.page.mineAssigned"), href: "/app/work/tasks?scope=assigned" },
          { value: "owned", label: t("work.page.mineOwned"), href: "/app/work/tasks?scope=owned" },
        ]}
      />
    );
  return (
    <nav aria-label={t("work.page.scope")} className="flex min-w-0 items-center gap-1">
      <Link href="/app/work/tasks?view=projects" className="text-ink-2 hover:text-ink shrink-0 text-sm font-medium no-underline">
        {t("work.page.projectsGroup")}
      </Link>
      <ChevronRightIcon className="text-ink-2 size-4 shrink-0" aria-hidden />
      <Picker
        variant="title"
        label={t("work.page.projectsGroup")}
        value={scope.project}
        onChange={(id) => router.push(`/app/work/tasks?project=${id}`)}
        className="max-w-[55vw] shrink md:max-w-[360px]"
        options={projects.map((p) => ({ value: p.id, label: p.name, icon: <ProjectBadge id={p.id} name={p.name} size="sm" /> }))}
        footer={
          <Link href={`/app/work/projects/${scope.project}`} className={cx(menuItem, "text-ink-2 no-underline")}>
            <ArrowRightIcon className="size-4" />
            {t("work.page.projectPage")}
          </Link>
        }
      />
    </nav>
  );
}
