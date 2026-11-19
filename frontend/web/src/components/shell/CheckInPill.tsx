"use client";

import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/client";
import { useFormat } from "@/lib/i18n/client";
import { btn, btnSm, cx } from "@/lib/ui";
import { ClockIcon } from "@/components/app/icons";
import { useToast } from "@/components/ui/Toast";
import { fixHref, missedDay, type ClockResult } from "./clock";
import type { ShellAttendance } from "./types";

/**
 * The top bar's attendance pill, shown only when the workspace uses attendance: "Chấm công vào", then
 * "Chấm công ra" (the time in on hover), then the day's span, quiet. One tap, no page change. Hidden on Chấm công,
 * whose header has its own check-in button (one button per screen).
 */

export function CheckInPill({ attendance }: { attendance: ShellAttendance }) {
  const router = useRouter();
  const { t, time, dayInline } = useFormat();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const onMe = usePathname() === "/app/time";
  const today = attendance.today;
  if (onMe) return null;
  if (today?.checkOut)
    return (
      <span className={cx(btn, btnSm, "text-ink-2 pointer-events-none shrink-0 border-transparent bg-transparent max-lg:hidden")}>
        <ClockIcon />
        {t("shell.top.checkedDone", { from: time(today.checkIn), to: time(today.checkOut) })}
      </span>
    );
  const out = Boolean(today);
  const go = async () => {
    setBusy(true);
    setError(false);
    try {
      const r = await api<ClockResult>(`employee/attendance/${out ? "check-out" : "check-in"}`, { method: "POST" });
      // A forgotten check-out from an earlier day was closed with no hours: say so and offer the correction form.
      const missed = missedDay(r);
      if (missed) toast({ message: t("shell.top.missedClosed", { day: dayInline(`${missed}T12:00:00Z`) }), action: { label: t("shell.top.missedFix"), href: fixHref(missed) } });
      router.refresh();
    } catch (e) {
      const b = (e as { body?: { error?: string } }).body;
      // Already on the clock (another tab, the phone): the page was stale, so refresh to show the check-out button.
      if (b?.error === "already_checked_in") return router.refresh();
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  // Not clocked in yet: the one coloured pill in the top bar, with a soft pulse, so it is the first thing seen in the
  // morning. Clocked in: a green pill that just says "Chấm công ra"; the time in stays in the tooltip, as
  // the time beside the label read as a clock-out time. Done: quiet text (above).
  return (
    <button
      type="button"
      className={cx(
        "inline-flex min-h-[34px] shrink-0 items-center gap-2 rounded-full px-3.5 text-sm font-semibold transition-colors disabled:opacity-60 md:max-lg:px-3",
        error ? "bg-block-wash text-block" : out ? "bg-ok-wash text-ok hover:bg-ok/15 ring-ok/25 ring-1 ring-inset" : "bg-accent text-on-brand shadow-card hover:bg-accent/90",
      )}
      disabled={busy}
      onClick={() => void go()}
      title={today ? t("shell.top.checkedInAt", { time: time(today.checkIn) }) : error ? t("shell.top.checkError") : out ? t("shell.top.checkOut") : t("shell.top.checkIn")}
    >
      <span aria-hidden="true" className="relative grid size-2 place-items-center">
        {!out && !error ? <span className="bg-on-brand/70 absolute inline-flex size-full rounded-full motion-safe:animate-ping" /> : null}
        <span className={cx("relative inline-flex size-2 rounded-full", out ? "bg-ok" : error ? "bg-block" : "bg-on-brand")} />
      </span>
      {/* Tablets (768–1023): the dot alone, so the search and the page title keep their room; the label stays for readers. */}
      <span className="md:max-lg:sr-only">{error ? t("shell.top.checkError") : out ? t("shell.top.checkOut") : t("shell.top.checkIn")}</span>
    </button>
  );
}
