"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { NAV } from "@/lib/nav";

// The landing header's navigation. Two small behaviours a static header cannot do: the header grows a border and a
// darker backdrop once the page has scrolled, and the link of the section currently in view is highlighted.

export function HeaderNav() {
  const ref = useRef<HTMLElement>(null);
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    const header = ref.current?.closest("header");
    const onScroll = () => header?.toggleAttribute("data-scrolled", window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });

    // The section whose top edge was last crossed, measured against a line a third of the way down the viewport.
    const ids = NAV.flatMap((n) => ("id" in n ? [n.id] : []));
    const sections = ids.map((id) => document.getElementById(id)).filter((s): s is HTMLElement => !!s);
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) setActive(e.target.id);
        }
      },
      { rootMargin: "-30% 0px -60% 0px", threshold: 0 },
    );
    sections.forEach((s) => io.observe(s));
    const onTop = () => {
      if (window.scrollY < 200) setActive(null);
    };
    window.addEventListener("scroll", onTop, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("scroll", onTop);
      io.disconnect();
    };
  }, []);

  return (
    <nav ref={ref} className="hidden items-center gap-1 lg:flex" aria-label="Main">
      {NAV.map((n) => {
        const on = "id" in n && n.id === active;
        return (
          <Link
            key={n.href}
            href={n.href}
            aria-current={on ? "true" : undefined}
            className={`relative rounded-md px-2.5 py-1.5 text-sm transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal ${
              on ? "text-ink" : "text-ink-2"
            }`}
          >
            {n.label}
            <span
              aria-hidden
              className={`absolute inset-x-2.5 -bottom-[13px] h-px bg-ink transition-opacity duration-300 ${on ? "opacity-100" : "opacity-0"}`}
            />
          </Link>
        );
      })}
    </nav>
  );
}
