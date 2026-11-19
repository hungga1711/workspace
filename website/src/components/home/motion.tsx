"use client";

import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";

// Small motion helpers for the landing page. No animation library: an IntersectionObserver flips a data attribute
// and CSS in global.css does the rest, gated on :root[data-js] so the page is fully visible without JavaScript and
// for crawlers. prefers-reduced-motion is honoured in the CSS.

type RevealProps = {
  children: ReactNode;
  className?: string;
  /** Stagger direct children instead of the wrapper; each child needs `style={{ "--i": n }}`. */
  stagger?: boolean;
  /** Delay before the wrapper (or first child) starts, in ms. */
  delay?: number;
  /** Gap between staggered children, in ms. */
  step?: number;
  as?: "div" | "section" | "ul" | "ol" | "dl";
  id?: string;
};

export function Reveal({ children, className, stagger, delay = 0, step = 80, as: Tag = "div", id }: RevealProps) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      el.dataset.shown = "1";
      return;
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          el.dataset.shown = "1";
          io.disconnect();
        }
      },
      { rootMargin: "0px 0px -12% 0px", threshold: 0.08 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <Tag
      // @ts-expect-error -- one ref for a handful of element types
      ref={ref}
      id={id}
      data-reveal={stagger ? "stagger" : "1"}
      className={className}
      style={{ "--delay": `${delay}ms`, "--step": `${step}ms` } as CSSProperties}
    >
      {children}
    </Tag>
  );
}
