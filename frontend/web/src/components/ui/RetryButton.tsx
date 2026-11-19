"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { btnPrimary } from "@/lib/ui";

/** Re-runs the page's server reads without a full reload. */
export function RetryButton({ label }: { label: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button type="button" disabled={pending} onClick={() => start(() => router.refresh())} className={btnPrimary}>
      {label}
    </button>
  );
}
