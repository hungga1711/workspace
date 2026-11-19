"use client";

import type { T } from "@/lib/i18n/core";
import { useT } from "@/lib/i18n/client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { deviceSubscribed, pushSupported, subscribeDevice, unsubscribeDevice } from "@/lib/push";
import { btn, btnSm, cx } from "@/lib/ui";
import { Picker } from "@/components/ui/Picker";
import { TimeZoneField } from "@/components/ui/TimeZoneField";
import { Checkbox } from "@/components/ui/Checkbox";
import { InfoTip } from "@/components/ui/InfoTip";

interface Prefs {
  pushEnabled: boolean;
  /** Buttons on pushes about an agent run that waits for me (Approve, an either/or answer). Off unless turned on. */
  quickActions?: boolean;
  /** null: follows the workspace's zone (`workspaceTimezone`). */
  timezone: string | null;
  workspaceTimezone: string;
  emailDigest: boolean;
  digestHour: number;
  muted: string[];
  quietStart: number | null;
  quietEnd: number | null;
  hasEmail?: boolean;
}
const GROUPS = (tx: T): [string, string][] => [
  ["mention", tx("me.notificationsettings.khi_co_nguoi_nhac")],
  ["task", tx("me.notificationsettings.viec_duoc_giao_binh")],
  ["meeting", tx("me.notificationsettings.loi_moi_va_thay")],
  ["leave", tx("me.notificationsettings.ket_qua_don_nghi")],
  ["doc", tx("me.notificationsettings.trang_theo_doi")],
];
const HOURS = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `${String(h).padStart(2, "0")}:00` }));

/** Notification settings: what reaches my inbox, and a daily email. */
export function NotificationSettings() {
  const tx = useT();
  const [p, setP] = useState<Prefs | null>(null);
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState<"load" | "save" | null>(null);
  const [device, setDevice] = useState<"unsupported" | "off" | "on" | "denied">("unsupported");
  useEffect(() => {
    void api<Prefs>("home/prefs")
      .then(setP)
      .catch(() => setFailed("load"));
  }, []);
  useEffect(() => {
    if (!pushSupported()) return;
    if (Notification.permission === "denied") {
      setDevice("denied");
      return;
    }
    void deviceSubscribed()
      .then((on) => setDevice(on ? "on" : "off"))
      .catch(() => setDevice("off"));
  }, []);
  const enableDevice = async () => {
    const r = await subscribeDevice().catch(() => "unsupported" as const);
    setDevice(r === "ok" ? "on" : r === "denied" ? "denied" : "off");
  };
  const disableDevice = async () => {
    await unsubscribeDevice().catch(() => undefined);
    setDevice("off");
  };
  const update = async (patch: Partial<Prefs>) => {
    if (!p) return;
    const before = p;
    setP({ ...p, ...patch });
    setSaved(false);
    setFailed(null);
    try {
      const next = await api<Prefs>("home/prefs", { method: "PUT", body: patch });
      setP((cur) => (cur ? { ...cur, ...next } : next));
      setSaved(true);
    } catch {
      // The switch goes back to what is really stored.
      setP(before);
      setFailed("save");
    }
  };
  if (!p)
    return (
      <p className="text-ink-2 text-sm" role={failed ? "alert" : undefined}>
        {tx(failed === "load" ? "me.notificationsettings.loadFailed" : "me.notificationsettings.dang_tai_cai_dat")}
      </p>
    );
  const toggle = (checked: boolean, label: string, onChange: (v: boolean) => void) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cx("relative h-6 w-10 shrink-0 rounded-full transition-colors", checked ? "bg-brand" : "bg-hairline")}
    >
      <span className={cx("bg-surface shadow-raised absolute top-0.5 size-5 rounded-full transition-all", checked ? "left-[18px]" : "left-0.5")} />
    </button>
  );
  return (
    <div className="grid gap-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1 font-medium">
          {tx("me.notificationsettings.mui_gio_cua_toi")}
          <InfoTip text={tx("me.notificationsettings.dung_cho_gio_gui")} label={tx("me.notificationsettings.mui_gio_cua_toi")} />
        </span>
        <TimeZoneField
          variant="button"
          label={tx("me.notificationsettings.mui_gio")}
          value={p.timezone ?? ""}
          onChange={(v) => void update({ timezone: v || null })}
          extra={[{ value: "", label: tx("me.notificationsettings.followWorkspace", { zone: p.workspaceTimezone }) }]}
        />
      </div>
      <div className="flex items-start gap-3">
        <span className="flex-1">
          <span className="block font-medium">{tx("me.notificationsettings.email_tom_tat_moi")}</span>
          <span className="text-ink-2 text-xs">{tx("me.notificationsettings.nhung_viec_can_ban")}</span>
        </span>
        {toggle(p.emailDigest, tx("me.notificationsettings.email_tom_tat_moi"), (v) => void update({ emailDigest: v }))}
      </div>
      {p.emailDigest ? (
        <div className="flex flex-wrap items-center gap-2">
          <span aria-hidden="true">{tx("me.notificationsettings.gui_luc")}</span>
          <Picker
            variant="button"
            label={tx("me.notificationsettings.gio_gui_email")}
            value={String(p.digestHour)}
            onChange={(v) => void update({ digestHour: Number(v) })}
            options={HOURS}
          />
        </div>
      ) : null}
      <div className="border-hairline grid gap-2 border-t pt-4">
        <div className="flex items-start gap-3">
          <span className="flex-1">
            <span className="block font-medium">{tx("me.notificationsettings.thong_bao_tren_thiet")}</span>
            <span className="text-ink-2 text-xs">{tx("me.notificationsettings.bao_ngay_khi_co")}</span>
          </span>
          {toggle(p.pushEnabled, tx("me.notificationsettings.thong_bao_tren_thiet"), (v) => void update({ pushEnabled: v }))}
        </div>
        {p.pushEnabled ? (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              {device === "on" ? (
                <>
                  <span className="text-ok">{tx("me.notificationsettings.da_bat_tren_trinh")}</span>
                  <button type="button" className={cx(btn, btnSm)} onClick={() => void disableDevice()}>
                    {tx("me.notificationsettings.tat_tren_thiet_bi")}
                  </button>
                </>
              ) : device === "off" ? (
                <>
                  <span className="text-ink-2">{tx("me.notificationsettings.trinh_duyet_nay_chua")}</span>
                  <button type="button" className={cx(btn, btnSm)} onClick={() => void enableDevice()}>
                    {tx("me.notificationsettings.bat_tren_thiet_bi")}
                  </button>
                </>
              ) : device === "denied" ? (
                <span className="text-ink-2">{tx("me.notificationsettings.trinh_duyet_dang_chan")}</span>
              ) : (
                <span className="text-ink-2">{tx("me.notificationsettings.trinh_duyet_hoac_may")}</span>
              )}
            </div>
            {/* Acting from the notification itself: a choice, because its buttons also work on a locked phone. */}
            <div className="flex items-start gap-3">
              <span className="flex-1">
                <span className="block">{tx("me.notificationsettings.quick")}</span>
                <span className="text-ink-2 text-xs">{tx("me.notificationsettings.quickHint")}</span>
              </span>
              {toggle(!!p.quickActions, tx("me.notificationsettings.quick"), (v) => void update({ quickActions: v }))}
            </div>
            <Checkbox
              checked={!p.muted.includes("dm")}
              onChange={(e) => void update({ muted: e.target.checked ? p.muted.filter((x) => x !== "dm") : [...p.muted, "dm"] })}
              label={tx("me.notificationsettings.dm")}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Checkbox
                checked={p.quietStart !== null && p.quietEnd !== null}
                onChange={(e) => void update(e.target.checked ? { quietStart: 22, quietEnd: 7 } : { quietStart: null, quietEnd: null })}
                label={tx("me.notificationsettings.gio_yen_lang")}
              />
              {p.quietStart !== null && p.quietEnd !== null ? (
                <>
                  <span className="text-ink-2" aria-hidden="true">
                    {tx("me.notificationsettings.tu")}
                  </span>
                  <Picker
                    variant="button"
                    label={tx("me.notificationsettings.gio_yen_lang_bat")}
                    value={String(p.quietStart)}
                    onChange={(v) => void update({ quietStart: Number(v) })}
                    options={HOURS}
                  />
                  <span className="text-ink-2" aria-hidden="true">
                    {tx("me.notificationsettings.den")}
                  </span>
                  <Picker
                    variant="button"
                    label={tx("me.notificationsettings.gio_yen_lang_ket")}
                    value={String(p.quietEnd)}
                    onChange={(v) => void update({ quietEnd: Number(v) })}
                    options={HOURS}
                  />
                </>
              ) : null}
            </div>
            {p.quietStart !== null && p.quietEnd !== null ? (
              <p className="text-ink-2 text-xs">{tx("me.notificationsettings.quiet_note", { p0: p.timezone ?? p.workspaceTimezone })}</p>
            ) : null}
          </>
        ) : null}
      </div>
      <fieldset className="border-hairline grid gap-1.5 border-t pt-4">
        <legend className="mb-1 font-medium">{tx("me.notificationsettings.bao_vao_hop_thong")}</legend>
        <div className="grid gap-2 sm:grid-cols-2 sm:gap-x-6">
          {GROUPS(tx).map(([k, l]) => (
            <Checkbox
              key={k}
              checked={!p.muted.includes(k)}
              onChange={(e) => void update({ muted: e.target.checked ? p.muted.filter((x) => x !== k) : [...p.muted, k] })}
              label={l}
            />
          ))}
        </div>
        <p className="text-ink-2 text-xs">{tx("me.notificationsettings.phe_duyet_va_yeu")}</p>
      </fieldset>
      <p className={cx("text-ok text-xs", !saved && "sr-only")} role="status">
        {saved ? tx("me.notificationsettings.da_luu") : ""}
      </p>
      {failed === "save" ? (
        <p className="text-block text-xs" role="alert">
          {tx("me.notificationsettings.saveFailed")}
        </p>
      ) : null}
    </div>
  );
}
