"use client";

import { useT } from "@/lib/i18n/client";
import { useEffect, useState } from "react";
import { pushSupported, subscribeDevice } from "@/lib/push";
import { btn, btnPrimary, grow, note } from "@/lib/ui";

/**
 * Design Issue 11: ask in our own words after the first value moment (2nd Home
 * visit); only "Bật" triggers the browser prompt. "Để sau" re-asks after 7 days, max 2 times.
 */
export function PushPrompt() {
  const t = useT();
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!pushSupported()) return;
    if (Notification.permission !== "default") return;
    try {
      const visits = Number(localStorage.getItem("wos_home_visits") ?? "0") + 1;
      localStorage.setItem("wos_home_visits", String(visits));
      const later = JSON.parse(localStorage.getItem("wos_push_later") ?? '{"n":0,"at":0}') as { n: number; at: number };
      const due = later.n === 0 || (later.n < 2 && Date.now() - later.at > 7 * 24 * 3600_000);
      if ((visits >= 2 || localStorage.getItem("wos_tried_ai") === "1") && due) setShow(true);
    } catch {
      /* storage unavailable: don't prompt */
    }
  }, []);
  if (!show) return null;

  const enable = async () => {
    setShow(false);
    await subscribeDevice();
  };
  const later = () => {
    setShow(false);
    try {
      const prev = JSON.parse(localStorage.getItem("wos_push_later") ?? '{"n":0,"at":0}') as { n: number };
      localStorage.setItem("wos_push_later", JSON.stringify({ n: prev.n + 1, at: Date.now() }));
    } catch {
      /* ignore */
    }
  };
  return (
    <div className={note} role="region" aria-label={t("home.push.region")}>
      <span className={grow}>
        <span className="block font-medium">{t("home.push.title")}</span>
        <span className="text-ink-2 text-sm">{t("home.push.body")}</span>
      </span>
      <button type="button" className={btnPrimary} onClick={() => void enable()}>
        {t("home.push.enable")}
      </button>
      <button type="button" className={btn} onClick={later}>
        {t("home.push.later")}
      </button>
    </div>
  );
}
