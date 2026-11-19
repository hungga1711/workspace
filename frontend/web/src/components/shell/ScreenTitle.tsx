"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { CrumbRender } from "@/components/ui/PageCrumb";

/**
 * One title per screen: the shell's top bar names the destination and, on an entity screen, the thing
 * itself ("Việc / Tuyển dụng 2026"); pages never repeat it as a big H1. Pages reach the bar through this context:
 * - `crumb`: the entity's name for the breadcrumb. Entity pages set it with <ScreenCrumb label=… /> (or a 28px
 *   `PageHeader size="entity"` does it for them); without one, the top bar falls back to the page's <title>.
 * - `switcher`: a frame's destination switcher ("Lịch ▾"), which stands in for the bar's title on phones.
 * - `actionsEl`: the phone top bar's actions slot. A full-height screen (a conversation) puts its few actions there
 *   with <ScreenActions> so phones show one header row, not the bar plus its own.
 * A page outside the app shell (Quản trị) has no provider: `useScreenTitle()` is null there.
 */
interface ScreenTitleState {
  crumb: string | null;
  switcher: CrumbRender | null;
  setCrumb: (v: string | null) => void;
  setSwitcher: (v: CrumbRender | null) => void;
  actionsEl: HTMLElement | null;
  setActionsEl: (el: HTMLElement | null) => void;
}

const ScreenTitleContext = createContext<ScreenTitleState | null>(null);

export function ScreenTitleProvider({ children }: { children: React.ReactNode }) {
  const [crumb, setCrumb] = useState<string | null>(null);
  const [switcher, setSwitcherState] = useState<CrumbRender | null>(null);
  // A render function is a function: wrap it so React stores it instead of calling it as an updater.
  // Stable, so the effects that call it do not re-run on every change they cause.
  const setSwitcher = useCallback((v: CrumbRender | null) => setSwitcherState(() => v), []);
  const [actionsEl, setActionsEl] = useState<HTMLElement | null>(null);
  const value = useMemo(() => ({ crumb, switcher, setCrumb, setSwitcher, actionsEl, setActionsEl }), [crumb, switcher, setSwitcher, actionsEl]);
  return <ScreenTitleContext.Provider value={value}>{children}</ScreenTitleContext.Provider>;
}

export const useScreenTitle = () => useContext(ScreenTitleContext);

/** Puts an entity's name in the top bar's breadcrumb while the page is shown. Renders nothing. */
export function ScreenCrumb({ label }: { label: string | null | undefined }) {
  const ctx = useScreenTitle();
  const set = ctx?.setCrumb;
  useEffect(() => {
    if (!set || !label) return;
    set(label);
    return () => set(null);
  }, [set, label]);
  return null;
}

/**
 * Renders its children into the phone top bar's actions slot (a portal, so they keep the page's own React context).
 * Below 768px only: the slot lives in the phone bar, which wide screens hide. Keep it to ≤ 3 icon buttons; the bar's
 * search button steps aside while the slot is filled (the bell stays).
 */
export function ScreenActions({ children }: { children: React.ReactNode }) {
  const el = useScreenTitle()?.actionsEl ?? null;
  return el ? createPortal(children, el) : null;
}
