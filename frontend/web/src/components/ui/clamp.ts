"use client";

import { useCallback } from "react";

/**
 * A ref callback for an absolutely placed popover: once it is in the page, keep it at least 8px inside the
 * viewport. Popovers are aligned to their trigger's edge, which on a phone or a narrow tablet column can push
 * them past the screen (a right-aligned panel under a left-side button). A popover that would cross an edge is
 * pinned (`position: fixed`) where it fits: a moved absolute box would still widen the page's scroll area. One that
 * a scrolling box (a dialog's body) would cut off is pinned the same way, so it shows in full above that box.
 * Vertically, one that would run past the bottom (or top) of the screen, such as a picker near the end of a task
 * panel, opens on the side of its trigger with more room and scrolls inside when even that is too short.
 */
export function useClampX<T extends HTMLElement>() {
  return useCallback((el: T | null) => {
    if (!el) return;
    const fit = () => {
      if (!el.isConnected) return;
      el.style.position = el.style.left = el.style.right = el.style.top = el.style.bottom = el.style.width = "";
      el.style.maxHeight = el.style.overflowY = "";
      const r = el.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;
      // The popover's parent is the relative box around its trigger: the edge it opens from.
      const anchor = el.parentElement?.getBoundingClientRect() ?? r;
      const offY = r.bottom > vh - 8 || r.top < 8;
      let top = r.top;
      let maxHeight: number | null = null;
      if (offY) {
        const below = vh - 8 - anchor.bottom - 4;
        const above = anchor.top - 4 - 8;
        const down = below >= r.height || below >= above;
        const room = Math.max(0, down ? below : above);
        if (r.height > room) maxHeight = room;
        const h = Math.min(r.height, room);
        top = down ? anchor.bottom + 4 : anchor.top - 4 - h;
      }
      // A scrolling box around it (a dialog's body) would cut it off: pin it where it is, above that box.
      let clipped = false;
      let a: HTMLElement | null = el.parentElement;
      while (a && a !== document.body) {
        const cs = getComputedStyle(a);
        if (cs.overflowY !== "visible" || cs.overflowX !== "visible") {
          const b = a.getBoundingClientRect();
          clipped = r.bottom > b.bottom + 1 || r.top < b.top - 1;
          break;
        }
        a = a.parentElement;
      }
      if (!clipped && !offY && r.left >= 8 && r.right <= vw - 8) return;
      const width = Math.min(el.offsetWidth, vw - 16);
      const left = Math.min(Math.max(8, r.left), vw - 8 - width);
      if (maxHeight !== null) Object.assign(el.style, { maxHeight: `${Math.floor(maxHeight)}px`, overflowY: "auto" });
      // Fixed, a "w-full" box would take the screen's width: keep the width it had beside its trigger.
      Object.assign(el.style, {
        position: "fixed",
        top: `${Math.round(top)}px`,
        bottom: "auto",
        left: `${Math.round(left)}px`,
        right: "auto",
        width: `${width}px`,
        maxWidth: `${vw - 16}px`,
      });
      // Under a transformed or size-contained ancestor (a page's entry animation, an @container), "fixed" is placed
      // against that ancestor, not the screen: a probe pinned at 0,0 beside the popover shows where that origin is.
      const probe = document.createElement("div");
      probe.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;visibility:hidden";
      el.parentElement?.appendChild(probe);
      const o = probe.getBoundingClientRect();
      probe.remove();
      if (o.top || o.left) Object.assign(el.style, { top: `${Math.round(top - o.top)}px`, left: `${Math.round(left - o.left)}px` });
    };
    fit();
    // The opening animation scales the popover for ~150ms, so its drawn box is a little off: measure again after.
    setTimeout(fit, 200);
    // Options that load when the list opens (a project's tasks) make it taller after that: measure again then too.
    if (typeof ResizeObserver === "undefined") return;
    let h = el.offsetHeight;
    const ro = new ResizeObserver(() => {
      if (!el.isConnected) return ro.disconnect();
      if (el.offsetHeight === h) return;
      h = el.offsetHeight;
      fit();
      h = el.offsetHeight;
    });
    ro.observe(el);
  }, []);
}
