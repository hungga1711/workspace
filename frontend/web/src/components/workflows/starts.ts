"use client";

import { dateFormat } from "@/lib/intl";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { useFormat, useLocale, useT } from "@/lib/i18n/client";
import type { Trigger } from "./types";

/** Short weekday names in the reader's language, Sunday first (the index a schedule stores). */
export function useWeekdays(): string[] {
  const locale = useLocale();
  // 2023-01-01 was a Sunday.
  return Array.from({ length: 7 }, (_, d) => dateFormat(locale, { weekday: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2023, 0, 1 + d))));
}

export type ProjectNames = { id: string; name: string }[];
/**
 * The projects a trigger may name, read once. `failed` instead of a crash when they cannot be read (the names then
 * show as "a project"); `retry` reads again.
 */
export function useProjects(wanted: boolean) {
  const [state, setState] = useState<{ projects: ProjectNames | null; failed: boolean }>({ projects: null, failed: false });
  const [turn, setTurn] = useState(0);
  useEffect(() => {
    if (!wanted) return;
    let off = false;
    api<{ projects: ProjectNames }>("work/projects")
      .then((r) => !off && setState({ projects: r.projects.map((p) => ({ id: p.id, name: p.name })), failed: false }))
      .catch(() => !off && setState((s) => ({ ...s, failed: true })));
    return () => {
      off = true;
    };
  }, [wanted, turn]);
  return { ...state, retry: () => setTurn((n) => n + 1) };
}

/**
 * A way of starting in words, as short facts: "A task moves to In review", "Projects: Website", "Every day at 09:00".
 * Facts, not one sentence, so every language reads right.
 */
export function useTriggerText() {
  const t = useT();
  const f = useFormat();
  const days = useWeekdays();
  return (x: Trigger, projects: ProjectNames | null): string[] => {
    const name = (id: string) => projects?.find((p) => p.id === id)?.name ?? t("workflows.start.text.aProject");
    const inProjects = (ids: string[]) => (ids.length ? t("workflows.start.text.projects", { list: ids.map(name).join(", ") }) : "");
    if (x.kind === "task")
      return [
        x.on === "created" ? t("workflows.start.text.created") : t("workflows.start.text.moved", { status: f.status(x.status ?? "") ?? x.status ?? "" }),
        inProjects(x.projects),
        x.labels.length ? t("workflows.start.text.labels", { list: x.labels.join(", ") }) : "",
      ].filter(Boolean);
    if (x.kind === "schedule")
      return [
        x.every === "week" && x.days.length
          ? t("workflows.start.text.weekly", { days: x.days.map((d) => days[d]).join(", "), time: x.time })
          : t("workflows.start.text.daily", { time: x.time }),
        x.projectId ? t("workflows.start.text.newTaskIn", { project: name(x.projectId) }) : t("workflows.start.text.newTask"),
      ];
    if (x.kind === "hook")
      return [t("workflows.start.text.hook"), x.projectId ? t("workflows.start.text.newTaskIn", { project: name(x.projectId) }) : t("workflows.start.text.newTask")];
    return [t(x.on === "opened" ? "workflows.start.text.opened" : "workflows.start.text.merged"), inProjects(x.projects)].filter(Boolean);
  };
}
