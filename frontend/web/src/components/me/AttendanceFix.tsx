"use client";

import { useT } from "@/lib/i18n/client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { btn, btnPrimary, cx, input, textarea } from "@/lib/ui";
import { Modal } from "@/components/ui/Modal";
import { Field } from "@/components/ui/bits";
import { DateField } from "@/components/ui/DateField";
import { clockIso, clockTime } from "@/components/admin/attendance";

interface MyCorrection {
  id: string;
  day: string;
  checkIn: string;
  checkOut: string | null;
  reason: string;
  status: "pending" | "approved" | "rejected" | "cancelled";
}

/**
 * Của tôi › Thời gian: ask the line manager to fix a day (missed badge, wrong time). The request carries the
 * times the person proposes and a reason; the manager approves it in Quản trị › Chấm công or their team view.
 */
export function AttendanceFix({
  days,
  request,
  onClose,
}: {
  days: { day: string; checkIn: string; checkOut: string | null }[];
  /** The day picked with "Đề nghị sửa" in the history (null: the form is closed). */
  request: string | null;
  onClose: () => void;
}) {
  const tx = useT();
  const [mine, setMine] = useState<MyCorrection[]>([]);
  const [open, setOpen] = useState<{ day: string; inT: string; outT: string } | null>(null);
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "err" } | null>(null);
  const load = () =>
    api<{ corrections: MyCorrection[] }>("employee/attendance/corrections")
      .then((r) => setMine(r.corrections))
      .catch(() => undefined);
  useEffect(() => {
    void load();
  }, []);
  // A day with times starts from them; a day without any (forgot to clock in) from a usual shift.
  useEffect(() => {
    if (!request) return setOpen(null);
    setMsg(null);
    const d = days.find((x) => x.day === request);
    setOpen(d ? { day: d.day, inT: clockTime(d.checkIn), outT: clockTime(d.checkOut) } : { day: request, inT: "08:30", outT: "17:30" });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- opens once per request; the days list is fixed while it is open
  }, [request]);
  const close = () => {
    setOpen(null);
    onClose();
  };
  const send = async () => {
    if (!open) return;
    try {
      await api("employee/attendance/corrections", {
        method: "POST",
        body: { day: open.day, checkIn: clockIso(open.day, open.inT), checkOut: open.outT ? clockIso(open.day, open.outT) : null, reason: reason.trim() },
      });
      close();
      setReason("");
      setMsg({ tone: "ok", text: tx("me.attendancefix.da_gui") });
      void load();
    } catch (e) {
      setMsg({
        tone: "err",
        text: (e as { body?: { error?: string } }).body?.error === "pending_correction" ? tx("me.attendancefix.dang_cho") : tx("me.attendancefix.chua_gui_duoc"),
      });
    }
  };
  return (
    <div className="text-sm">
      {msg ? (
        <p className={cx("mb-3 rounded-lg px-3 py-2", msg.tone === "ok" ? "bg-ok-wash text-ok" : "bg-block-wash text-block")} role="status">
          {msg.text}
        </p>
      ) : null}
      {mine.length ? (
        <ul className="divide-divider-soft bg-surface shadow-card m-0 list-none divide-y overflow-hidden rounded-xl p-0">
          {mine.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-3 px-4 py-2">
              <span className="tabular-nums">{c.day}</span>
              <span className="text-ink-2 tabular-nums">
                {clockTime(c.checkIn)} → {clockTime(c.checkOut) || "—"}
              </span>
              <span className="text-ink-2 min-w-0 flex-1 truncate">{c.reason}</span>
              <span
                className={cx(
                  "rounded-sm px-2 py-0.5 text-xs font-medium",
                  c.status === "approved" ? "bg-ok-wash text-ok" : c.status === "pending" ? "bg-warn-wash text-warn" : "bg-hover text-ink-2",
                )}
              >
                {tx(`admin.people.trang_thai.${c.status}`)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {open ? (
        <Modal
          title={tx("me.attendancefix.tieu_de")}
          onClose={close}
          footer={
            <>
              <button type="button" className={btn} onClick={close}>
                {tx("me.meview.huy")}
              </button>
              <button type="button" className={btnPrimary} disabled={!reason.trim() || !open.inT} onClick={() => void send()}>
                {tx("me.attendancefix.gui")}
              </button>
            </>
          }
        >
          <div className="grid gap-3">
            <Field label={tx("me.attendancefix.ngay")}>
              <DateField label={tx("me.attendancefix.ngay")} value={open.day} clearable={false} onChange={(v) => setOpen({ ...open, day: v })} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={tx("me.attendancefix.gio_vao")}>
                <input type="time" className={input} value={open.inT} onChange={(e) => setOpen({ ...open, inT: e.target.value })} />
              </Field>
              <Field label={tx("me.attendancefix.gio_ra")}>
                <input type="time" className={input} value={open.outT} onChange={(e) => setOpen({ ...open, outT: e.target.value })} />
              </Field>
            </div>
            <Field label={tx("me.attendancefix.ly_do")}>
              <textarea className={textarea} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
            </Field>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
