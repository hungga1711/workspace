"use client";

import { useEffect, useRef, useState } from "react";

/** Counts a number up from 0 over ≤ 600 ms on first paint; instant under reduced motion. */
export function useCountUp(target: number) {
  const [n, setN] = useState(target);
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return setN(target);
    done.current = true;
    if (typeof window === "undefined" || window.matchMedia("(prefers-reduced-motion: reduce)").matches || target === 0) return setN(target);
    const t0 = performance.now();
    const dur = Math.min(600, 250 + Math.abs(target) * 8);
    let raf = 0;
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      setN(Number.isInteger(target) ? Math.round(target * eased) : target * eased);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    setN(0);
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return n;
}
