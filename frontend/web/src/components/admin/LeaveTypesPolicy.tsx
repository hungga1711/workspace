"use client";

import { IconTile } from "@/components/ui/Bento";
import { FlagIcon, ListIcon } from "@/components/app/icons";
import { useLocale, useT } from "@/lib/i18n/client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/client";
import { btn, btnPrimary, btnSm, control, cx, input, table, tableScroll } from "@/lib/ui";
import { Checkbox } from "@/components/ui/Checkbox";
import { Modal } from "@/components/ui/Modal";
import { Field } from "@/components/ui/bits";
import { PickerField } from "./PickerField";
import { leaveTypeName, type EmployeeSettings, type LeaveType } from "./people-settings";

type Msg = { text: string; tone: "ok" | "err" } | null;

/** Admin › Nghỉ phép, below the balances: the workspace's leave types and the start-of-year grant policy. */
export function LeaveTypesPolicy({ types, settings }: { types: LeaveType[]; settings: EmployeeSettings }) {
  const tx = useT();
  const locale = useLocale();
  const router = useRouter();
  const [msg, setMsg] = useState<Msg>(null);
  const [edit, setEdit] = useState<LeaveType | "new" | null>(null);
  const [policy, setPolicy] = useState(settings.leavePolicy);
  const toggle = async (t: LeaveType) => {
    setMsg(null);
    try {
      if (t.active) await api(`employee/leave/types/${t.code}`, { method: "DELETE" });
      else await api(`employee/leave/types/${t.code}`, { method: "PUT", body: { ...t, active: true } });
      router.refresh();
    } catch (e) {
      setMsg({ tone: "err", text: (e as { body?: { error?: string } }).body?.error === "default_type" ? tx("admin.people.khong_tat_mac_dinh") : tx("admin.people.chua_luu_loai") });
    }
  };
  const savePolicy = async () => {
    setMsg(null);
    try {
      await api("employee/settings", { method: "PUT", body: { workWeek: settings.workWeek, shift: settings.shift, leavePolicy: policy } });
      setMsg({ tone: "ok", text: tx("admin.people.da_luu_chinh_sach") });
      router.refresh();
    } catch {
      setMsg({ tone: "err", text: tx("admin.people.chua_luu_chinh_sach") });
    }
  };
  const balanceTypes = types.filter((t) => t.active && t.requiresBalance);
  return (
    <>
      {msg ? (
        <p className={cx("mb-4 rounded-lg px-3 py-2 text-sm", msg.tone === "ok" ? "bg-ok-wash text-ok" : "bg-block-wash text-block")} role="status">
          {msg.text}
        </p>
      ) : null}
      <section className="bg-surface shadow-card mb-6 rounded-xl p-5 text-sm max-sm:p-4" aria-labelledby="policy-h">
        <h2 id="policy-h" className="mb-3 flex min-w-0 items-center gap-3 text-sm/6 font-semibold tracking-[-0.01em]">
          <IconTile tone="violet">
            <FlagIcon />
          </IconTile>
          {tx("admin.people.chinh_sach")}
        </h2>
        <p className="text-ink-2 mb-3 text-xs">{tx("admin.people.chinh_sach_mo_ta")}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex items-center gap-2 sm:col-span-2">
            <Checkbox checked={policy.autoGrant} onChange={(e) => setPolicy({ ...policy, autoGrant: e.target.checked })} />
            {tx("admin.people.tu_dong_cap")}
          </label>
          <PickerField
            label={tx("admin.people.loai_mac_dinh")}
            value={policy.typeCode}
            onChange={(v) => setPolicy({ ...policy, typeCode: v })}
            options={balanceTypes.map((t) => ({ value: t.code, label: leaveTypeName(t, locale) }))}
          />
          <Field label={tx("admin.people.so_ngay_mac_dinh")}>
            <input className={input} inputMode="decimal" value={policy.defaultDays} onChange={(e) => setPolicy({ ...policy, defaultDays: Number(e.target.value) || 0 })} />
          </Field>
          <label className="flex items-center gap-2">
            <Checkbox checked={policy.prorate} onChange={(e) => setPolicy({ ...policy, prorate: e.target.checked })} />
            {tx("admin.people.chia_ty_le")}
          </label>
          <label className="flex items-center gap-2">
            <Checkbox checked={policy.seniority} onChange={(e) => setPolicy({ ...policy, seniority: e.target.checked })} />
            {tx("admin.people.tham_nien")}
          </label>
          <label className="flex items-center gap-2">
            {tx("admin.people.chuyen_du")}
            <input
              className={cx(control, "h-9 min-h-0 w-16")}
              inputMode="decimal"
              value={policy.carryOverMax}
              onChange={(e) => setPolicy({ ...policy, carryOverMax: Number(e.target.value) || 0 })}
              aria-label={tx("admin.people.chuyen_du")}
            />
          </label>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <button type="button" className={btnPrimary} onClick={() => void savePolicy()}>
            {tx("admin.people.luu_chinh_sach")}
          </button>
          <span className="text-ink-2 text-xs">
            {settings.leavePolicy.lastGrantedYear ? tx("admin.people.da_cap_nam", { p0: settings.leavePolicy.lastGrantedYear }) : tx("admin.people.chua_cap_lan_nao")}
          </span>
        </div>
      </section>

      <section className="bg-surface shadow-card mb-6 rounded-xl p-5 text-sm max-sm:p-4" aria-labelledby="types-h">
        <div className="mb-1 flex items-center gap-3">
          <h2 id="types-h" className="flex min-w-0 flex-1 items-center gap-3 text-sm/6 font-semibold tracking-[-0.01em]">
            <IconTile tone="sky">
              <ListIcon />
            </IconTile>
            {tx("admin.people.loai_nghi")}
          </h2>
          <button type="button" className={cx(btn, btnSm)} onClick={() => setEdit("new")}>
            {tx("admin.people.them_loai")}
          </button>
        </div>
        <p className="text-ink-2 mb-3 text-xs">{tx("admin.people.loai_nghi_mo_ta")}</p>
        {/* Wider than a phone: the table scrolls inside the card, never the page. */}
        <div className="-mx-1 overflow-x-auto px-1">
          <table className={cx(table, tableScroll)}>
            <thead>
              <tr>
                <th className="max-lg:hidden">{tx("admin.people.ma")}</th>
                <th>{tx("admin.people.ten_vi")}</th>
                <th className="max-lg:hidden">{tx("admin.people.ten_en")}</th>
                <th className="max-lg:hidden">{tx("admin.people.co_luong")}</th>
                <th className="max-lg:hidden">{tx("admin.people.can_so_du")}</th>
                <th className="max-sm:hidden">{tx("admin.people.dang_dung")}</th>
                <th className="w-32 max-sm:w-20">
                  <span className="sr-only">{tx("admin.leaveadmin.thao_tac")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {types.map((t) => (
                <tr key={t.code} className={t.active ? "" : "text-ink-2"}>
                  <td className="font-mono text-xs max-lg:hidden">{t.code}</td>
                  {/* Below 1024px one cell holds the names, code and flags, so the actions stay on screen. */}
                  <td className="max-lg:!whitespace-normal">
                    {t.nameVi}
                    <span className="text-ink-2 block text-xs lg:hidden">
                      {[t.nameEn, t.code, t.paid ? tx("admin.people.co_luong") : null, t.requiresBalance ? tx("admin.people.can_so_du") : null].filter(Boolean).join(" · ")}
                      <span className="sm:hidden"> · {t.active ? tx("admin.people.dang_dung") : tx("admin.people.da_tat")}</span>
                    </span>
                  </td>
                  <td className="max-lg:hidden">{t.nameEn}</td>
                  <td className="max-lg:hidden">{t.paid ? "✓" : "—"}</td>
                  <td className="max-lg:hidden">{t.requiresBalance ? "✓" : "—"}</td>
                  <td className="max-sm:hidden">{t.active ? tx("admin.people.dang_dung") : tx("admin.people.da_tat")}</td>
                  <td className="text-right max-sm:!whitespace-normal">
                    <button type="button" className={cx(btn, btnSm, "mr-1 max-sm:mb-1 max-sm:mr-0")} onClick={() => setEdit(t)}>
                      {tx("admin.leaveadmin.sua")}
                    </button>
                    <button type="button" className={cx(btn, btnSm)} onClick={() => void toggle(t)}>
                      {t.active ? tx("admin.people.tat") : tx("admin.people.bat_lai")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {edit ? (
        <TypeModal
          type={edit === "new" ? null : edit}
          onClose={() => setEdit(null)}
          onSaved={() => {
            setEdit(null);
            setMsg({ tone: "ok", text: tx("admin.people.da_luu_loai") });
            router.refresh();
          }}
        />
      ) : null}
    </>
  );
}

function TypeModal({ type, onClose, onSaved }: { type: LeaveType | null; onClose: () => void; onSaved: () => void }) {
  const tx = useT();
  const [code, setCode] = useState(type?.code ?? "");
  const [nameVi, setNameVi] = useState(type?.nameVi ?? "");
  const [nameEn, setNameEn] = useState(type?.nameEn ?? "");
  const [paid, setPaid] = useState(type?.paid ?? true);
  const [requiresBalance, setRequiresBalance] = useState(type?.requiresBalance ?? true);
  const [error, setError] = useState<string | null>(null);
  const ok = /^[a-z][a-z0-9_]{0,29}$/.test(code) && nameVi.trim() && nameEn.trim();
  const save = async () => {
    setError(null);
    try {
      // A new type is created, never upserted: an existing code is refused instead of being rewritten.
      await api(`employee/leave/types/${code}${type ? "" : "?create=1"}`, {
        method: "PUT",
        body: { nameVi: nameVi.trim(), nameEn: nameEn.trim(), paid, requiresBalance, active: type?.active ?? true, sort: type?.sort ?? 100 },
      });
      onSaved();
    } catch (e) {
      setError((e as { status?: number }).status === 409 ? tx("admin.people.codeTaken", { p0: code }) : tx("admin.people.chua_luu_loai"));
    }
  };
  return (
    <Modal
      title={type ? tx("admin.people.sua_loai") : tx("admin.people.them_loai")}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btn} onClick={onClose}>
            {tx("admin.membersadmin.huy")}
          </button>
          <button type="button" className={btnPrimary} disabled={!ok} onClick={() => void save()}>
            {tx("admin.leaveadmin.luu")}
          </button>
        </>
      }
    >
      <div className="grid gap-3">
        <Field label={tx("admin.people.ma")} hint={tx("admin.people.ma_hint")} error={error}>
          <input className={input} value={code} disabled={!!type} onChange={(e) => setCode(e.target.value.toLowerCase())} maxLength={30} />
        </Field>
        <Field label={tx("admin.people.ten_vi")}>
          <input className={input} value={nameVi} onChange={(e) => setNameVi(e.target.value)} maxLength={60} />
        </Field>
        <Field label={tx("admin.people.ten_en")}>
          <input className={input} value={nameEn} onChange={(e) => setNameEn(e.target.value)} maxLength={60} />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={paid} onChange={(e) => setPaid(e.target.checked)} />
          {tx("admin.people.co_luong")}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={requiresBalance} onChange={(e) => setRequiresBalance(e.target.checked)} />
          {tx("admin.people.can_so_du")}
        </label>
      </div>
    </Modal>
  );
}
