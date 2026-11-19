"use client";

import { createContext, useContext, useEffect } from "react";
import { useScreenTitle } from "@/components/shell/ScreenTitle";

/**
 * Phones have no sidebar, so a destination with siblings (Work's Việc · Tiến độ · Tài liệu · Lịch · Yêu cầu, the
 * admin sections) offers a switcher instead. The frame provides it. Inside the app shell it becomes the top bar's
 * title on phones ("Lịch ▾": one title per screen); outside it (Quản trị has no phone top bar)
 * `PageHeader` shows it on its first row. Wide screens never show it.
 */
export type CrumbRender = (variant: "crumb" | "title") => React.ReactNode;

const PageCrumbContext = createContext<CrumbRender | null>(null);

export function PageCrumbProvider({ render, children }: { render: CrumbRender; children: React.ReactNode }) {
  const set = useScreenTitle()?.setSwitcher;
  useEffect(() => {
    if (!set) return;
    set(render);
    return () => set(null);
  }, [set, render]);
  return <PageCrumbContext.Provider value={render}>{children}</PageCrumbContext.Provider>;
}

export const usePageCrumb = () => useContext(PageCrumbContext);
