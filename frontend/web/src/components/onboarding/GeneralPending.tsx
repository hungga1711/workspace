"use client";

import { useT } from "@/lib/i18n/client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { cx, muted, skeleton } from "@/lib/ui";

const MAX_TRIES = 10;

export function GeneralPending() {
  const t = useT();
  const router = useRouter();
  const [tries, setTries] = useState(0);
  useEffect(() => {
    if (tries >= MAX_TRIES) return;
    const t = setTimeout(() => {
      setTries((n) => n + 1);
      router.refresh();
    }, 1500);
    return () => clearTimeout(t);
  }, [tries, router]);
  return (
    <div className="p-6" aria-live="polite">
      {tries < MAX_TRIES ? (
        <p className="flex items-center gap-2">
          {t("onboarding.preparingGeneral")} <span className={cx(skeleton, "w-20")} />
        </p>
      ) : (
        <p className={muted}>
          {t("onboarding.generalNotReady")} <Link href="/app/chat?new=channel">{t("onboarding.createChannel")}</Link> {t("onboarding.orGo")} <Link href="/app/home">Home</Link>
          {t("onboarding.appearsWhenReady")}
        </p>
      )}
    </div>
  );
}
