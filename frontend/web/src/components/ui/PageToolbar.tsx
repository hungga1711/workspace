"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** The id of the right end of a frame's tab row (Tiến độ's header), where a view puts its own actions. */
const PAGE_TOOLBAR_ID = "page-toolbar";

/** The slot, rendered by a frame's PageHeader as its `toolbar`. */
export function PageToolbarSlot() {
  const ref = useRef<HTMLDivElement>(null);
  // Marked once React has hydrated it: a portal into a node that is still waiting to hydrate (the header streams in
  // after the view) adds children React does not expect there, and hydration fails.
  useEffect(() => {
    if (ref.current) ref.current.dataset.ready = "1";
  }, []);
  // Phones: the actions shrink to their icons (the text stays as their accessible name) so the tabs keep the row.
  return (
    <div
      ref={ref}
      id={PAGE_TOOLBAR_ID}
      className="flex items-center gap-2 empty:hidden [&_button]:h-8 [&_button]:min-h-8 max-sm:[&_button]:min-w-8 max-sm:[&_button]:gap-0 max-sm:[&_button]:px-2 max-sm:[&_button]:text-[0px]"
    />
  );
}

/**
 * A view's actions for the frame's tab row (e.g. Đội ngũ's "Nhắc cập nhật" and "Báo cáo tuần" next to the tabs,
 * instead of a row of their own). Without a slot on the page they render where they are.
 */
export function PageToolbar({ children }: { children: React.ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [looked, setLooked] = useState(false);
  useEffect(() => {
    // The frame's header can re-render into a new node (its streamed version replaces the fallback): follow it.
    const find = () => {
      const el = document.getElementById(PAGE_TOOLBAR_ID);
      setSlot(el?.dataset.ready ? el : null);
    };
    find();
    setLooked(true);
    const mo = new MutationObserver(find);
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-ready"] });
    return () => mo.disconnect();
  }, []);
  if (slot) return createPortal(children, slot);
  return looked ? <div className="mb-4 flex justify-end gap-2">{children}</div> : null;
}
