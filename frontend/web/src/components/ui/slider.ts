"use client";

import { useLayoutEffect, useRef, useState } from "react";

/**
 * Where the current item of a tab bar or segmented track is, so one indicator can slide between items with a CSS
 * transition. `moved` turns the transition on only after the first measurement (no slide in from 0 on load).
 * Re-measures when the key changes and when the track resizes (fonts loading, wrapping).
 */
export function useSlider(track: React.RefObject<HTMLElement | null>, selector: string, key: string) {
  const [pos, setPos] = useState<{ x: number; w: number; h: number; moved: boolean } | null>(null);
  const measured = useRef(false);
  useLayoutEffect(() => {
    const el = track.current;
    if (!el) return;
    const measure = () => {
      const cur = el.querySelector<HTMLElement>(selector);
      if (!cur) return setPos(null);
      setPos({ x: cur.offsetLeft, w: cur.offsetWidth, h: cur.offsetHeight, moved: measured.current });
      measured.current = true;
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [track, selector, key]);
  return pos;
}
