"use client";

import { LoadFailed } from "@/components/ui/LoadFailed";
import type { T } from "@/lib/i18n/core";
import { useT, useFormat } from "@/lib/i18n/client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client";
import { ipLabel } from "@/lib/format";
import { btn, btnSm, cx, mono } from "@/lib/ui";

interface Data {
  sessions: { id: string; ip: string; startedAt: string; lastSeenAt: string }[];
  history: { at: string; type: string; ip: string | null; error: string | null }[];
}
const TYPE = (tx: T): Record<string, string> => ({
  LOGIN: tx("me.sessionspanel.dang_nhap"),
  LOGIN_ERROR: tx("me.sessionspanel.dang_nhap_that_bai"),
  LOGOUT: tx("me.sessionspanel.dang_xuat"),
  UPDATE_PASSWORD: tx("me.sessionspanel.doi_mat_khau"),
  RESET_PASSWORD: tx("me.sessionspanel.dat_lai_mat_khau"),
});

/** Me › Hồ sơ: where I am signed in, recent sign-in activity, sign out a device or everywhere. */
export function SessionsPanel() {
  const { ago, dayLabel, time } = useFormat();
  const tx = useT();
  const [d, setD] = useState<Data | null>(null);
  const [error, setError] = useState(false);
  const [all, setAll] = useState(false);
  const load = useCallback(
    () =>
      void api<Data>("identity/me/sessions")
        .then((r) => {
          setError(false);
          setD(r);
        })
        .catch(() => setError(true)),
    [],
  );
  useEffect(load, [load]);
  const end = async (id: string) => {
    await api(`identity/me/sessions/${id}`, { method: "DELETE" });
    load();
  };
  const everywhere = async () => {
    if (!window.confirm(tx("me.sessionspanel.dang_xuat_khoi_moi"))) return;
    await api("identity/me/sessions/logout-all", { method: "POST" });
    const f = document.createElement("form");
    f.method = "post";
    f.action = "/auth/logout";
    document.body.appendChild(f);
    f.submit();
  };
  if (error) return <LoadFailed onRetry={load} />;
  if (!d) return <p className="text-ink-2 text-sm">{tx("me.sessionspanel.dang_tai_phien_dang")}</p>;
  const failures = d.history.filter((h) => h.type === "LOGIN_ERROR" && Date.now() - Date.parse(h.at) < 7 * 86400_000).length;
  return (
    <div className="grid grid-cols-1 gap-4">
      <div>
        <div className="mb-2 flex items-center">
          <p className="flex-1 text-sm font-medium">{tx("me.sessionspanel.dang_dang_nhap_o", { p0: d.sessions.length })}</p>
          {d.sessions.length ? (
            <button type="button" className={cx(btn, btnSm)} onClick={() => void everywhere()}>
              {tx("me.sessionspanel.dang_xuat_moi_noi")}
            </button>
          ) : null}
        </div>
        <ul className="m-0 grid list-none gap-1.5 p-0">
          {(all ? d.sessions : d.sessions.slice(0, 2)).map((s) => (
            <li key={s.id} className="border-hairline flex items-center gap-3 rounded-md border px-3 py-2 text-sm">
              <span className="min-w-0 flex-1">
                {/* Loopback is a place, not an address: plain text; a real IP keeps the mono face. */}
                {ipLabel(s.ip, "") ? (
                  <span className={cx(mono, "block")}>{ipLabel(s.ip, "")}</span>
                ) : (
                  <span className="block font-medium">{tx("me.sessionspanel.localDevice")}</span>
                )}
                <span className="text-ink-2 text-xs">{tx("me.sessionspanel.tu_hoat_dong", { p0: dayLabel(s.startedAt), p1: time(s.startedAt), p2: ago(s.lastSeenAt) })}</span>
              </span>
              <button
                type="button"
                className={cx(btn, btnSm)}
                onClick={() => void end(s.id)}
                aria-label={tx("me.sessionspanel.dang_xuat_phien", { p0: ipLabel(s.ip, tx("common.localMachine")) })}
              >
                {tx("me.sessionspanel.dang_xuat")}
              </button>
            </li>
          ))}
        </ul>
        {!all && d.sessions.length > 2 ? (
          <button type="button" className="text-brand-text mt-1.5 text-sm font-medium hover:underline" onClick={() => setAll(true)}>
            {tx("me.sessionspanel.xem_them", { p0: d.sessions.length - 2 })}
          </button>
        ) : null}
      </div>
      {failures ? (
        <p className="bg-warn-wash text-warn rounded-lg px-3 py-2 text-sm" role="note">
          {tx("me.sessionspanel.lan_dang_nhap_sai", { p0: failures })}
        </p>
      ) : null}
      {d.history.length ? (
        <details className="text-sm">
          <summary className="cursor-pointer font-medium">{tx("me.sessionspanel.hoat_dong_dang_nhap")}</summary>
          <ul className="m-0 mt-2 grid list-none gap-1 p-0">
            {d.history.slice(0, 15).map((h, i) => (
              <li key={i} className="flex gap-3">
                <span className="text-ink-2 w-32 shrink-0">
                  {dayLabel(h.at)} {time(h.at)}
                </span>
                <span className={h.type === "LOGIN_ERROR" ? "text-block" : ""}>{TYPE(tx)[h.type] ?? h.type}</span>
                <span className={cx(h.ip && ipLabel(h.ip, "") ? mono : "", "text-ink-2 ml-auto text-xs")}>{h.ip ? ipLabel(h.ip, tx("common.localMachine")) : ""}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
