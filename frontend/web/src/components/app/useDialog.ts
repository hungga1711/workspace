"use client";

import { useEffect, useRef } from "react";

/** Focus trap + Esc + focus restore for modal overlays (WCAG 2.2, design Issue 2). */
export function useDialog<T extends HTMLElement>(onClose: () => void) {
  const ref = useRef<T>(null);
  // Callers pass inline closures; reading the latest through a ref keeps the trap from re-running (and pulling
  // focus back to the first control) on every parent render.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const focusables = () => Array.from(ref.current?.querySelectorAll<HTMLElement>("a[href],button:not([disabled]),input,textarea,select,[tabindex]:not([tabindex='-1'])") ?? []);
    // Overlays mount through a Portal, which renders a frame later: wait for the element before moving focus.
    let frame = 0;
    let tries = 0;
    const focusFirst = () => {
      if (ref.current) {
        if (!ref.current.contains(document.activeElement)) focusables()[0]?.focus();
      } else if (tries++ < 10) frame = requestAnimationFrame(focusFirst);
    };
    focusFirst();
    const onKey = (e: KeyboardEvent) => {
      // Keys typed in another dialog over this one (the ⌘J ask panel over a task) belong to that one: its Esc closes it.
      const t = e.target instanceof Element ? e.target : null;
      if (t && ref.current && !ref.current.contains(t) && t.closest("[role=dialog]")) return;
      if (e.key === "Escape") close.current();
      if (e.key === "Tab") {
        const f = focusables();
        if (f.length === 0) return;
        const first = f[0]!;
        const last = f[f.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKey);
      // The opener may be gone (a menu item that closed with its menu): fall back to the main region, so the next Tab
      // continues in the page instead of restarting at the top of the sidebar.
      if (previous && previous !== document.body && previous.isConnected) previous.focus();
      else document.getElementById("main")?.focus({ preventScroll: true });
    };
  }, []);
  return ref;
}
