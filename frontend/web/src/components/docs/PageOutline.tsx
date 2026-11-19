"use client";

import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n/client";
import { cx } from "@/lib/ui";

interface Heading {
  id: string;
  text: string;
  level: number;
}

/**
 * "Trên trang này": the page's headings in a sticky rail beside the text, the one in view marked. Reads the rendered page, so it follows edits live.
 */
export function PageOutline({ root }: { root: string }) {
  const t = useT();
  const [items, setItems] = useState<Heading[]>([]);
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    const el = document.querySelector(root);
    if (!el) return;
    const scan = () => {
      const hs = Array.from(el.querySelectorAll<HTMLElement>("h1, h2, h3")).filter((h) => h.textContent?.trim() && !h.closest("[data-toc-view]"));
      hs.forEach((h, i) => {
        if (!h.id) h.id = `h-${i}-${slug(h.textContent ?? "")}`;
      });
      setItems((cur) => {
        const next = hs.map((h) => ({ id: h.id, text: h.textContent!.trim(), level: Number(h.tagName[1]) }));
        return JSON.stringify(cur) === JSON.stringify(next) ? cur : next;
      });
      return hs;
    };
    let hs = scan();
    const seen = new IntersectionObserver(
      (entries) => {
        const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (top) setActive(top.target.id);
      },
      { rootMargin: "-80px 0px -70% 0px" },
    );
    hs.forEach((h) => seen.observe(h));
    const mo = new MutationObserver(() => {
      seen.disconnect();
      hs = scan();
      hs.forEach((h) => seen.observe(h));
    });
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      mo.disconnect();
      seen.disconnect();
    };
  }, [root]);

  if (items.length < 2) return null;
  const base = Math.min(...items.map((i) => i.level));
  return (
    <nav aria-label={t("docs.outline.title")} className="text-sm">
      <p className="text-ink-2 m-0 mb-2 text-xs font-semibold">{t("docs.outline.title")}</p>
      <ul className="border-hairline m-0 grid list-none gap-0.5 border-l p-0">
        {items.map((h) => (
          <li key={h.id}>
            <a
              href={`#${h.id}`}
              onClick={(e) => {
                e.preventDefault();
                document.getElementById(h.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
                history.replaceState(null, "", `#${h.id}`);
                setActive(h.id);
              }}
              aria-current={active === h.id ? "location" : undefined}
              className={cx(
                "-ml-px block border-l-2 py-1 pr-2 leading-snug no-underline",
                h.level - base === 0 ? "pl-3" : h.level - base === 1 ? "pl-6" : "pl-9",
                active === h.id ? "border-brand text-ink font-medium" : "text-ink-2 hover:text-ink border-transparent",
              )}
            >
              <span className="line-clamp-2">{h.text}</span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function slug(s: string) {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}
