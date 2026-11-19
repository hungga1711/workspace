"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { progress } from "@/lib/progress";

/**
 * A thin bar at the top of the window while a page loads or a change is being saved, so a click on a
 * slow connection never looks ignored. It waits 120 ms before showing (fast actions stay calm), creeps
 * towards 90% while waiting, then fills and fades. Navigations start on any same-site link click.
 */
export function TopProgress() {
  const busy = useSyncExternalStore(progress.subscribe, progress.get, () => 0) > 0;
  const path = usePathname();
  const search = useSearchParams().toString();
  const [phase, setPhase] = useState<"idle" | "run" | "finish">("idle");
  const [width, setWidth] = useState(0);
  const timers = useRef<number[]>([]);
  const clear = () => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  };

  // A link to another page starts the bar; the URL changing ends it.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a");
      if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
      const url = new URL(a.href, location.href);
      if (url.origin !== location.origin || (url.pathname === location.pathname && url.search === location.search)) return;
      progress.start();
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);
  useEffect(() => {
    progress.reset();
  }, [path, search]);

  useEffect(() => {
    clear();
    if (busy) {
      timers.current.push(
        window.setTimeout(() => {
          setPhase("run");
          setWidth(30);
          timers.current.push(window.setTimeout(() => setWidth(70), 250));
          timers.current.push(window.setTimeout(() => setWidth(90), 1500));
        }, 120),
      );
    } else if (phase === "run") {
      setPhase("finish");
      setWidth(100);
      timers.current.push(
        window.setTimeout(() => {
          setPhase("idle");
          setWidth(0);
        }, 320),
      );
    }
    return clear;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);

  if (phase === "idle") return null;
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-x-0 top-0 z-[100] h-0.5">
      <div
        className={`bg-brand h-full rounded-r-full transition-[width,opacity] ease-out ${phase === "finish" ? "opacity-0 duration-300" : "opacity-100 duration-[1200ms]"}`}
        style={{ width: `${width}%` }}
      />
    </div>
  );
}
