"use client";

import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n/client";
import { btn, btnPrimary, btnSm, cx } from "@/lib/ui";
import { CheckIcon, CopyIcon } from "@/components/app/icons";

/** A small "Sao chép" button: copies `text`, then says so for a moment. */
export function CopyButton({ text, label, copiedLabel, primary, className }: { text: string; label?: string; copiedLabel?: string; primary?: boolean; className?: string }) {
  const t = useT();
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const id = setTimeout(() => setDone(false), 1600);
    return () => clearTimeout(id);
  }, [done]);
  return (
    <button
      type="button"
      className={cx(primary ? btnPrimary : btn, btnSm, className)}
      onClick={() =>
        void navigator.clipboard
          ?.writeText(text)
          .then(() => setDone(true))
          .catch(() => undefined)
      }
    >
      {done ? <CheckIcon /> : <CopyIcon />}
      <span aria-live="polite">{done ? (copiedLabel ?? t("common.copied")) : (label ?? t("common.copy"))}</span>
    </button>
  );
}
