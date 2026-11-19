"use client";

import { useT } from "@/lib/i18n/client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { Avatar, useDirectory } from "@/lib/people";
import { Picker } from "@/components/ui/Picker";
import { DateField } from "@/components/ui/DateField";
import { Checkbox } from "@/components/ui/Checkbox";
import { btn, btnPrimary, cx } from "@/lib/ui";
import { parts } from "@/components/work/calTime";

interface State {
  delegation: { delegateId: string; until: string; active: boolean } | null;
  forMe: { userId: string; until: string }[];
}
const todayKey = () => parts(new Date()).key;
const viDate = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

/**
 * Out-of-office: while I am away, approvals and leave requests addressed to me go to the
 * person I choose; optionally my pending ones move now. Shows who I am approving for, too.
 */
export function DelegationSettings() {
  const tx = useT();
  const dir = useDirectory();
  const [s, setS] = useState<State | null>(null);
  const [delegate, setDelegate] = useState("");
  const [until, setUntil] = useState(todayKey());
  const [move, setMove] = useState(true);
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "err" } | null>(null);
  const load = () =>
    void api<State>("work/me/delegation")
      .then(setS)
      .catch(() => setS({ delegation: null, forMe: [] }));
  useEffect(load, []);
  const save = async () => {
    setMsg(null);
    try {
      const r = await api<{ moved: number }>("work/me/delegation", { method: "PUT", body: { delegateId: delegate, until, movePending: move } });
      setMsg({
        tone: "ok",
        text: tx("me.delegationsettings.da_uy_quyen", { p0: dir.name(delegate), p1: viDate(until), p2: r.moved ? tx("me.delegationsettings.da_chuyen_n", { p0: r.moved }) : "" }),
      });
      load();
    } catch {
      setMsg({ tone: "err", text: tx("me.delegationsettings.chua_luu_duoc_kiem") });
    }
  };
  const clear = async () => {
    await api("work/me/delegation", { method: "DELETE" });
    setMsg({ tone: "ok", text: tx("me.delegationsettings.da_tat_uy_quyen") });
    load();
  };
  if (!s) return <p className="text-ink-2 text-sm">{tx("me.delegationsettings.dang_tai")}</p>;
  const d = s.delegation?.active ? s.delegation : null;
  return (
    <div className="grid gap-3 text-sm">
      {s.forMe.length ? (
        <p className="bg-hover text-ink m-0 rounded-md px-3 py-2">
          {tx("me.delegationsettings.ban_dang_duyet_thay", { p0: s.forMe.map((f) => tx("me.delegationsettings.den", { p0: dir.name(f.userId), p1: viDate(f.until) })).join(", ") })}
        </p>
      ) : null}
      {d ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex-1">
            {tx("me.delegationsettings.yeu_cau_phe_duyet")} <b>{dir.name(d.delegateId)}</b> {tx("me.delegationsettings.den_het_ngay", { p0: viDate(d.until) })}
          </span>
          <button type="button" className={btn} onClick={() => void clear()}>
            {tx("me.delegationsettings.tat_uy_quyen")}
          </button>
        </div>
      ) : (
        <>
          <p className="text-ink-2 m-0">{tx("me.delegationsettings.khi_di_cong_tac")}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Picker
              variant="button"
              className="max-sm:w-full"
              label={tx("me.delegationsettings.nguoi_duyet_thay")}
              placeholder={tx("me.delegationsettings.chon_nguoi_duyet_thay")}
              value={delegate}
              onChange={setDelegate}
              options={dir.people.filter((x) => x.userId !== dir.me).map((x) => ({ value: x.userId, label: x.displayName, icon: <Avatar id={x.userId} size="xs" /> }))}
            />
            <span className="text-ink-2" aria-hidden="true">
              {tx("me.delegationsettings.den_het")}
            </span>
            <DateField variant="button" label={tx("me.delegationsettings.uy_quyen_den_ngay")} value={until} clearable={false} onChange={setUntil} />
            <button type="button" className={btnPrimary} disabled={!delegate || !until} onClick={() => void save()}>
              {tx("me.delegationsettings.uy_quyen")}
            </button>
          </div>
          <Checkbox checked={move} onChange={(e) => setMove(e.target.checked)} label={tx("me.delegationsettings.chuyen_luon_cac_yeu")} />
        </>
      )}
      {/* Stays in the accessibility tree for announcements, but takes no space while empty. */}
      <p className={cx("m-0 text-xs", !msg && "sr-only")} role="status">
        <span className={msg?.tone === "err" ? "text-block" : "text-ok"}>{msg?.text ?? ""}</span>
      </p>
    </div>
  );
}
