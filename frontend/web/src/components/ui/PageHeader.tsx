"use client";

import { isValidElement, useEffect } from "react";
import { cx } from "@/lib/ui";
import { Avatar } from "@/lib/people";
import { usePageCrumb } from "./PageCrumb";
import { useScreenTitle } from "@/components/shell/ScreenTitle";

/**
 * The header of every page (one title per screen).
 *
 * Destination pages (Việc, Tiến độ, Tài liệu, Lịch, Yêu cầu, Của tôi's sections, Quản trị, search) — the default,
 * `size="page"`: the shell's top bar already names the destination, so the title is NOT drawn; it stays the page's
 * h1 for screen readers only. What is drawn is one row on a hairline, directly under the top bar: the page `Tabs`
 * on the left and the view controls (`toolbar`) and `actions` on the right. Without tabs the row carries the `meta`
 * line (and `count`) on the left instead, with no hairline; with tabs the meta line sits under the hairline. A
 * header with nothing visible renders only the hidden h1 and takes no room.
 *
 * Entity pages (one person, one project, one doc) — `size="entity"`: the entity's name is the page's 28px h1 (the
 * top bar shows only the breadcrumb "Destination / Name", which a string title fills in), with `lead` (an avatar)
 * before it, `meta` under it and `actions` on its right; `tabs` go on a second row on the hairline.
 *
 * Placement (DESIGN.md › Layout): the header is the first thing in the page column (16–20px under the top bar), on
 * the column's left edge; pages never add their own top padding or centre it.
 */
export function PageHeader({
  title,
  count,
  lead,
  meta,
  actions,
  tabs,
  toolbar,
  className,
  size: sizeProp = "page",
  as: Tag = "h1",
}: {
  title: React.ReactNode;
  count?: number | string | null;
  lead?: React.ReactNode;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
  /** Usually <Tabs/>; rendered on the hairline. */
  tabs?: React.ReactNode;
  /** The tab row's right side: view switches, filters (≤ 3 controls). */
  toolbar?: React.ReactNode;
  className?: string;
  /** "entity" for a single thing's page (person, project): a visible 28px title. */
  size?: "page" | "entity";
  as?: "h1" | "h2";
}) {
  // A header led by someone's avatar is about that person (Của tôi, a teammate's page): an entity, whatever the
  // call site passed. Other leads (a phone back link) sit before the tabs.
  const size = isValidElement(lead) && lead.type === Avatar ? "entity" : sizeProp;
  const shell = useScreenTitle();
  const crumb = usePageCrumb();
  // An entity's name fills the top bar's breadcrumb ("Tiến độ / Phan Lan").
  const setCrumb = shell?.setCrumb;
  const crumbLabel = size === "entity" && typeof title === "string" ? title : null;
  useEffect(() => {
    if (!setCrumb || !crumbLabel) return;
    setCrumb(crumbLabel);
    return () => setCrumb(null);
  }, [setCrumb, crumbLabel]);

  const hasCount = count !== undefined && count !== null && count !== "";
  const countPill = hasCount ? <span className="bg-hover text-ink-2 shrink-0 rounded-md px-2 text-[13px] font-medium tabular-nums">{count}</span> : null;

  if (size === "entity") {
    const row2 = Boolean(tabs || toolbar);
    return (
      <header className={cx("mb-5 min-w-0", row2 && "border-divider border-b", className)}>
        <div className={cx("flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2", row2 && "pb-3")}>
          {lead ? <div className="contents [&>*]:shrink-0">{lead}</div> : null}
          <div className="min-w-[min(100%,12rem)] flex-1">
            <div className="flex min-w-0 items-center gap-2">
              {typeof title === "string" ? (
                <Tag data-page-title="" className="font-display text-ink m-0 truncate text-2xl/8 font-medium tracking-[-0.025em]">
                  {title}
                </Tag>
              ) : (
                title
              )}
              {countPill}
            </div>
            {meta ? <div className="text-ink-2 mt-0.5 w-0 min-w-full text-sm/[1.45] max-sm:line-clamp-2 sm:truncate">{meta}</div> : null}
          </div>
          {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
        {row2 ? (
          <div className="flex min-h-10 min-w-0 items-end justify-between gap-3">
            <div className="min-w-0 flex-1">{tabs}</div>
            {toolbar ? <div className="flex shrink-0 items-center gap-2 pb-1.5">{toolbar}</div> : null}
          </div>
        ) : null}
      </header>
    );
  }

  // Destination page: no visible title. Outside the app shell (Quản trị on phones) the frame's switcher has no
  // top bar to live in, so it leads the row here.
  const phoneSwitcher = crumb && !shell ? <div className="shrink-0 md:hidden">{crumb("title")}</div> : null;
  const hiddenTitle =
    typeof title === "string" ? (
      <Tag data-page-title="" className="sr-only">
        {title}
      </Tag>
    ) : (
      // A node title (a scope picker) stays visible: it says what is shown, not where you are.
      <div className="flex min-w-0 items-center gap-2">{title}</div>
    );
  const right =
    toolbar || actions ? (
      // Phones: the controls take a compact line under the tabs (tabs first, at full width).
      // The negative top margin lets a 36px control sit in the 40px row, so every page's tabs start at the same height.
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 pb-1.5 max-sm:w-full max-sm:justify-start max-sm:pb-0 max-sm:pt-2.5 sm:-mt-1 max-sm:[&_button]:min-h-8">
        {toolbar}
        {actions}
      </div>
    ) : null;

  if (tabs) {
    return (
      // Text tabs carry their own air above the label: pulled up 4px, their top gap reads like a boxed control's.
      <header className={cx("-mt-1 mb-5 min-w-0", className)}>
        {hiddenTitle}
        {phoneSwitcher ? <div className="mb-1 flex min-w-0 items-center gap-2">{phoneSwitcher}</div> : null}
        {/* The hairline runs under the tabs: under the whole row from 640px, under the tabs' own line on phones. */}
        <div className="border-divider flex min-h-10 min-w-0 flex-wrap items-end justify-between gap-x-3 sm:border-b">
          <div className="border-divider flex min-w-0 flex-1 items-end gap-2 max-sm:basis-full max-sm:border-b">
            {lead ? <div className="flex shrink-0 items-center self-center [&>*]:shrink-0">{lead}</div> : null}
            <div className="min-w-0 flex-1">{tabs}</div>
            {countPill ? <span className="mb-2.5">{countPill}</span> : null}
          </div>
          {right}
        </div>
        {meta ? <div className="text-ink-2 mt-3 text-sm/[1.45]">{meta}</div> : null}
      </header>
    );
  }

  // A count on its own is not worth a row (it would be dead space); it rides along with meta or actions.
  const visible = Boolean(phoneSwitcher || lead || meta || right || typeof title !== "string");
  if (!visible) return hiddenTitle;
  // Only the phone switcher to show: the row exists on phones only (no empty row on wide screens).
  const phoneOnly = Boolean(phoneSwitcher) && !(lead || meta || right || typeof title !== "string");
  return (
    <>
      {/* Outside the row, so a phone-only row (display: none on wide screens) never hides the page's h1. */}
      {typeof title === "string" ? hiddenTitle : null}
      <header className={cx("mb-5 flex min-h-9 min-w-0 flex-wrap items-center gap-x-3 gap-y-2", phoneOnly && "md:hidden", className)}>
        {phoneSwitcher}
        {lead ? <div className="contents [&>*]:shrink-0">{lead}</div> : null}
        <div className="flex min-w-[min(100%,12rem)] flex-1 items-center gap-2">
          {typeof title === "string" ? null : hiddenTitle}
          {countPill}
          {meta ? <div className="text-ink-2 min-w-0 text-sm/[1.45]">{meta}</div> : null}
        </div>
        {toolbar || actions ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {toolbar}
            {actions}
          </div>
        ) : null}
      </header>
    </>
  );
}

/** For a string title rendered as a node (e.g. next to a Picker): the same type as an entity title's row. */
export const pageTitle = "font-display m-0 truncate text-2xl/8 font-semibold tracking-[-0.01em] text-ink";
