"use client";

import { useLocale, useT } from "@/lib/i18n/client";
import { INTL_TAG } from "@/lib/i18n/config";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/client";
import { btn, btnPrimary, btnSm, control, cx, input, table } from "@/lib/ui";
import { Modal } from "@/components/ui/Modal";
import { Field } from "@/components/ui/bits";
import { localDate } from "@/lib/format";
import { clockIso, clockTime } from "./attendance";

export interface Day {
  day: string;
  checkIn: string;
  checkOut: string | null;
  source: string;
  correctionNote: string | null;
  /** A forgotten check-out the server closed with no hours: shown as "quên chấm ra" until HR sets the real time. */
  missedCheckout?: boolean;
}

const hours = (d: Day, tag: string) => (d.checkOut ? ((Date.parse(d.checkOut) - Date.parse(d.checkIn)) / 3600_000).toLocaleString(tag, { maximumFractionDigits: 1 }) : "—");

/** One person's month: each day's check-in/out, HR corrections marked, fix or add a day with a reason. */
export function AttendanceDays({ userId, month, days: raw }: { userId: string; month: string; days: Day[] }) {
  const days = raw.map((d) => (d.missedCheckout ? { ...d, checkOut: null } : d));
  const intlTag = INTL_TAG[useLocale()];
  const tx = useT();
  const router = useRouter();
  const [edit, setEdit] = useState<{ day: string; inT: string; outT: string } | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Today in the workspace's zone: an open day before it is a missed clock-out, today it is not.
  const now = localDate();
  const open = (d: { day: string; checkIn?: string; checkOut?: string | null }) => {
    setError(null);
    setNote("");
    setEdit({ day: d.day, inT: d.checkIn ? clockTime(d.checkIn) : "08:30", outT: d.checkOut ? clockTime(d.checkOut) : "17:30" });
  };
  const save = async () => {
    if (!edit) return;
    try {
      await api(`employee/attendance/${userId}/${edit.day}`, {
        method: "PUT",
        body: { checkIn: clockIso(edit.day, edit.inT), checkOut: edit.outT ? clockIso(edit.day, edit.outT) : null, note },
      });
      setEdit(null);
      router.refresh();
    } catch (e) {
      setError((e as { status?: number }).status === 400 ? tx("admin.attendancedays.gio_ra_phai_sau") : tx("admin.attendancedays.chua_luu_duoc"));
    }
  };
  return (
    <>
      <div className="mb-3 flex justify-end">
        <button type="button" className={btn} onClick={() => open({ day: `${month}-01` })}>
          {tx("admin.attendancedays.them_ngay_cong")}
        </button>
      </div>
      {days.length === 0 ? (
        <p className="text-ink-2">{tx("admin.attendancedays.khong_co_ngay_cham")}</p>
      ) : (
        <div className="bg-surface shadow-card overflow-x-auto rounded-xl">
          {/* Five short columns wrap to fit a phone (tableScroll's no-wrap pushed "Sửa" off the edge). */}
          <table className={cx(table, "max-sm:[&_td]:px-2 max-sm:[&_th]:px-2")}>
            <thead>
              <tr>
                <th>{tx("admin.attendancedays.ngay")}</th>
                <th>{tx("admin.attendancedays.vao")}</th>
                <th>{tx("admin.attendancedays.ra")}</th>
                <th className="text-right!">{tx("admin.attendancedays.gio")}</th>
                <th className="max-md:hidden">{tx("admin.attendancedays.ghi_chu")}</th>
                <th className="w-20">
                  <span className="sr-only">{tx("admin.attendancedays.thao_tac")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {days.map((d) => (
                <tr key={d.day}>
                  <td className="tabular-nums">
                    {d.day.slice(8, 10)}/{d.day.slice(5, 7)}
                    {/* Phones: the HR note goes under the date instead of a fifth column off-screen. */}
                    {d.source === "admin" ? (
                      <span className="text-ink-2 block text-xs md:hidden">{tx("admin.attendancedays.hr_da_sua", { p0: d.correctionNote ?? "" })}</span>
                    ) : null}
                  </td>
                  <td className="tabular-nums">{clockTime(d.checkIn)}</td>
                  <td className={cx("tabular-nums", !d.checkOut && d.day < now && "text-warn")}>
                    {d.checkOut ? clockTime(d.checkOut) : d.day < now ? tx("admin.attendancedays.quen_cham_ra") : tx("admin.attendancedays.dang_lam")}
                  </td>
                  <td className="text-right tabular-nums">{hours(d, intlTag)}</td>
                  <td className="text-ink-2 max-md:hidden">{d.source === "admin" ? tx("admin.attendancedays.hr_da_sua", { p0: d.correctionNote ?? "" }) : ""}</td>
                  <td>
                    <button type="button" className={cx(btn, btnSm)} onClick={() => open(d)} aria-label={tx("admin.attendancedays.sua_ngay", { p0: d.day })}>
                      {tx("admin.attendancedays.sua")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {edit ? (
        <Modal
          title={tx("admin.attendancedays.sua_cham_cong")}
          onClose={() => setEdit(null)}
          footer={
            <>
              <button type="button" className={btn} onClick={() => setEdit(null)}>
                {tx("admin.attendancedays.huy")}
              </button>
              <button type="button" className={btnPrimary} disabled={!note.trim()} onClick={() => void save()}>
                {tx("admin.attendancedays.luu")}
              </button>
            </>
          }
        >
          <div className="grid grid-cols-1 gap-4">
            <div className="grid grid-cols-3 items-start gap-3">
              <Field label={tx("admin.attendancedays.ngay")}>
                <input className={cx(input, "min-w-0 px-3")} type="date" value={edit.day} min={`${month}-01`} onChange={(e) => setEdit({ ...edit, day: e.target.value })} />
              </Field>
              <Field label={tx("admin.attendancedays.gio_vao")}>
                <input className={cx(control, "min-w-0 px-3")} type="time" value={edit.inT} onChange={(e) => setEdit({ ...edit, inT: e.target.value })} />
              </Field>
              <Field label={tx("admin.attendancedays.gio_ra")}>
                <input className={cx(control, "min-w-0 px-3")} type="time" value={edit.outT} onChange={(e) => setEdit({ ...edit, outT: e.target.value })} />
              </Field>
            </div>
            <Field label={tx("admin.attendancedays.ly_do")} error={error} hint={tx("admin.attendancedays.bat_buoc_nhan_vien")}>
              <input className={input} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder={tx("admin.attendancedays.quen_cham_ra_da")} />
            </Field>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
