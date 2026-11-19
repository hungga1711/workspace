"use client";

import { dateFormat } from "@/lib/intl";
import { IconTile } from "@/components/ui/Bento";
import { PencilIcon } from "@/components/app/icons";
import { useLocale, useT } from "@/lib/i18n/client";
import { INTL_TAG } from "@/lib/i18n/config";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/client";
import { btn, btnPrimary, btnSm, cx, table } from "@/lib/ui";
import { workspaceTimeZone } from "@/lib/timezone";
import { clockTime } from "./attendance";
import { dayMonthOptions } from "@/lib/format";

export interface Correction {
  id: string;
  userId: string;
  displayName: string;
  day: string;
  checkIn: string;
  checkOut: string | null;
  reason: string;
  status: "pending" | "approved" | "rejected" | "cancelled";
  approverId: string | null;
  createdAt: string;
}

/** Correction requests routed to the viewer (a manager) or every pending one (HR), with approve / reject. */
export function AttendanceCorrections({ corrections }: { corrections: Correction[] }) {
  const tx = useT();
  const tag = INTL_TAG[useLocale()];
  const router = useRouter();
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "err" } | null>(null);
  const decide = async (id: string, decision: "approved" | "rejected") => {
    try {
      await api(`employee/attendance/corrections/${id}/decision`, { method: "POST", body: { decision } });
      setMsg({ tone: "ok", text: tx("admin.people.da_quyet") });
      router.refresh();
    } catch {
      setMsg({ tone: "err", text: tx("admin.people.chua_quyet_duoc") });
    }
  };
  const pending = corrections.filter((c) => c.status === "pending");
  return (
    <section className="bg-surface shadow-card mb-6 rounded-xl p-5 text-sm max-sm:p-4" aria-labelledby="corr-h">
      <h2 id="corr-h" className="mb-3 flex min-w-0 items-center gap-3 text-sm/6 font-semibold tracking-[-0.01em]">
        <IconTile tone="rose">
          <PencilIcon />
        </IconTile>
        {tx("admin.people.yeu_cau_sua")} {pending.length ? <span className="text-ink-2 font-normal">{pending.length}</span> : null}
      </h2>
      <p className="text-ink-2 mb-3 text-xs">{tx("admin.people.yeu_cau_sua_mo_ta")}</p>
      {msg ? (
        <p className={cx("mb-3 rounded-lg px-3 py-2 text-sm", msg.tone === "ok" ? "bg-ok-wash text-ok" : "bg-block-wash text-block")} role="status">
          {msg.text}
        </p>
      ) : null}
      {pending.length === 0 ? (
        <p className="text-ink-2 m-0">{tx("admin.people.khong_co_yeu_cau")}</p>
      ) : (
        <table className={table}>
          <thead>
            <tr>
              <th>{tx("admin.attendancePage.nhan_vien")}</th>
              <th>{tx("me.attendancefix.ngay")}</th>
              <th>{tx("me.attendancefix.gio_vao")}</th>
              <th>{tx("me.attendancefix.gio_ra")}</th>
              <th>{tx("me.attendancefix.ly_do")}</th>
              <th className="w-40">
                <span className="sr-only">{tx("admin.leaveadmin.thao_tac")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {pending.map((c) => (
              <tr key={c.id}>
                <td className="font-medium">{c.displayName}</td>
                <td className="tabular-nums">{dateFormat(tag, { timeZone: workspaceTimeZone(), ...dayMonthOptions(tag) }).format(new Date(`${c.day}T12:00:00Z`))}</td>
                <td className="tabular-nums">{clockTime(c.checkIn)}</td>
                <td className="tabular-nums">{clockTime(c.checkOut) || "—"}</td>
                <td>{c.reason}</td>
                <td className="text-right">
                  <button type="button" className={cx(btnPrimary, btnSm, "mr-1")} onClick={() => void decide(c.id, "approved")}>
                    {tx("admin.people.duyet")}
                  </button>
                  <button type="button" className={cx(btn, btnSm)} onClick={() => void decide(c.id, "rejected")}>
                    {tx("admin.people.tu_choi")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
