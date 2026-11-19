"use client";

import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n/client";
import { setThemePref } from "@/lib/theme";
import { cx } from "@/lib/ui";
import { MoonIcon, SunIcon } from "@/components/app/icons";

/** Light or dark as two icons (a switch, not words); applies at once and is remembered. */
export function ThemeToggle({ className }: { className?: string }) {
  const t = useT();
  const [dark, setDark] = useState(false);
  useEffect(() => setDark(document.documentElement.dataset.theme === "dark"), []);
  return (
    <div role="group" aria-label={t("theme.title")} className={cx("bg-hover flex shrink-0 rounded-lg p-0.5", className)}>
      {([false, true] as const).map((d) => (
        <button
          key={String(d)}
          type="button"
          aria-pressed={dark === d}
          aria-label={t(d ? "theme.dark" : "theme.light")}
          title={t(d ? "theme.dark" : "theme.light")}
          onClick={() => {
            setDark(d);
            setThemePref(d ? "dark" : "light");
          }}
          className={cx(
            "grid size-7 place-items-center rounded-md transition-colors [&_svg]:size-4",
            dark === d ? "bg-surface text-ink shadow-raised" : "text-ink-2 hover:text-ink",
          )}
        >
          {d ? <MoonIcon /> : <SunIcon />}
        </button>
      ))}
    </div>
  );
}
