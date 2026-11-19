"use client";

import { IconTile } from "@/components/ui/Bento";
import { ClockIcon } from "@/components/app/icons";
import { useT } from "@/lib/i18n/client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/client";
import { btn, btnSm, control, cx } from "@/lib/ui";
import { Checkbox } from "@/components/ui/Checkbox";
import type { EmployeeSettings } from "./people-settings";

/** Admin › Chấm công: the shift (start, end, grace) that decides what "late" means; off by default. */
export function AttendanceSettings({ settings }: { settings: EmployeeSettings }) {
  const tx = useT();
  const router = useRouter();
  const [on, setOn] = useState(!!settings.shift);
  const [start, setStart] = useState(settings.shift?.start ?? "09:00");
  const [end, setEnd] = useState(settings.shift?.end ?? "18:00");
  const [grace, setGrace] = useState(String(settings.shift?.lateAfterMin ?? 5));
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "err" } | null>(null);
  const save = async () => {
    try {
      await api("employee/settings", {
        method: "PUT",
        body: { workWeek: settings.workWeek, leavePolicy: settings.leavePolicy, shift: on ? { start, end: end || null, lateAfterMin: Number(grace) || 0 } : null },
      });
      setMsg({ tone: "ok", text: tx("admin.people.da_luu_ca") });
      router.refresh();
    } catch {
      setMsg({ tone: "err", text: tx("admin.leaveadmin.chua_luu_duoc") });
    }
  };
  return (
    <section className="bg-surface shadow-card mb-6 rounded-xl p-5 text-sm max-sm:p-4" aria-labelledby="shift-h">
      <h2 id="shift-h" className="mb-3 flex min-w-0 items-center gap-3 text-sm/6 font-semibold tracking-[-0.01em]">
        <IconTile tone="sky">
          <ClockIcon />
        </IconTile>
        {tx("admin.people.ca_lam")}
      </h2>
      <p className="text-ink-2 mb-3 text-xs">{tx("admin.people.ca_lam_mo_ta")}</p>
      {msg ? (
        <p className={cx("mb-3 rounded-lg px-3 py-2 text-sm", msg.tone === "ok" ? "bg-ok-wash text-ok" : "bg-block-wash text-block")} role="status">
          {msg.text}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2">
          <Checkbox checked={!on} onChange={(e) => setOn(!e.target.checked)} />
          {tx("admin.people.khong_theo_ca")}
        </label>
        <label className="flex items-center gap-2">
          {tx("admin.people.gio_bat_dau")}
          <input type="time" className={cx(control, "h-9 min-h-0 w-28")} value={start} disabled={!on} onChange={(e) => setStart(e.target.value)} />
        </label>
        <label className="flex items-center gap-2">
          {tx("admin.people.gio_ket_thuc")}
          <input type="time" className={cx(control, "h-9 min-h-0 w-28")} value={end} disabled={!on} onChange={(e) => setEnd(e.target.value)} />
        </label>
        <label className="flex items-center gap-2">
          {tx("admin.people.cham_chuoc")}
          <input className={cx(control, "h-9 min-h-0 w-16")} inputMode="numeric" value={grace} disabled={!on} onChange={(e) => setGrace(e.target.value)} />
        </label>
        <button type="button" className={cx(btn, btnSm)} onClick={() => void save()}>
          {tx("admin.leaveadmin.luu")}
        </button>
      </div>
    </section>
  );
}
