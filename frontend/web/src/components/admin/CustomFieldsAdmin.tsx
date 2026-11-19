"use client";

import { CalmEmpty } from "./AdminBits";
import { IconTile } from "@/components/ui/Bento";
import { useT } from "@/lib/i18n/client";
import { Checkbox } from "@/components/ui/Checkbox";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/client";
import { btn, btnPrimary, cx, input } from "@/lib/ui";
import { Modal } from "@/components/ui/Modal";
import { Field } from "@/components/ui/bits";
import { AdminHeader } from "./AdminNav";
import { PickerField } from "./PickerField";
import { ListIcon, MoreIcon, PencilIcon, PlusIcon, TrashIcon } from "@/components/app/icons";
import { Menu } from "@/components/ui/Menu";
import type { FieldDef } from "@/components/work/types";
import { useConfirm } from "@/components/ui/Confirm";

/** Admin › Trường tuỳ chỉnh: extra fields on tasks and projects. */
export function CustomFieldsAdmin({ fields }: { fields: FieldDef[] }) {
  const tx = useT();
  const { confirm, dialog } = useConfirm();
  const router = useRouter();
  const [fieldModal, setFieldModal] = useState<{ field?: FieldDef } | null>(null);
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "err" } | null>(null);
  const remove = async (f: FieldDef) => {
    if (!(await confirm({ title: tx("admin.customfieldsadmin.xoa_hoi", { p0: f.label }), danger: true }))) return;
    setMsg(null);
    try {
      await api(`work/custom-fields/${f.entity}/${f.key}`, { method: "DELETE" });
      setMsg({ text: tx("admin.customfieldsadmin.da_xoa", { p0: f.label }), tone: "ok" });
      router.refresh();
    } catch {
      setMsg({ text: tx("admin.customfieldsadmin.chua_xoa_duoc"), tone: "err" });
    }
  };
  return (
    <>
      {dialog}
      <>
        <AdminHeader title={tx("admin.customfieldsadmin.truong_tuy_chinh")} />
        {msg ? (
          <p className={cx("mb-4 rounded-lg px-3 py-2 text-sm", msg.tone === "ok" ? "bg-ok-wash text-ok" : "bg-block-wash text-block")} role="status">
            {msg.text}
          </p>
        ) : null}
        <section aria-labelledby="cf-h">
          <div className="mb-2 flex items-center">
            <h2 id="cf-h" className="flex min-w-0 flex-1 items-center gap-3 text-sm/6 font-semibold tracking-[-0.01em]">
              <IconTile tone="green">
                <ListIcon />
              </IconTile>
              {tx("admin.customfieldsadmin.truong_tuy_chinh")}
            </h2>
            <button type="button" className={btn} onClick={() => setFieldModal({})}>
              <PlusIcon className="size-4" />
              {tx("admin.customfieldsadmin.them_truong")}
            </button>
          </div>
          {fields.length === 0 ? (
            <CalmEmpty title={tx("admin.customfieldsadmin.chua_co_truong_nao")} />
          ) : (
            <ul className="divide-divider-soft shadow-card bg-surface m-0 list-none divide-y overflow-hidden rounded-xl p-0">
              {fields.map((f) => (
                <li key={`${f.entity}.${f.key}`} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                  <span className="flex-1 font-medium">{f.label}</span>
                  <span className="text-ink-2">
                    {f.entity === "task" ? tx("admin.customfieldsadmin.viec") : tx("admin.customfieldsadmin.du_an")} · {f.type}
                    {f.options.length ? ` (${f.options.join(", ")})` : ""}
                    {f.required ? tx("admin.customfieldsadmin.bat_buoc_2") : ""}
                  </span>
                  <span className="text-ink-2 font-mono text-xs">{f.key}</span>
                  <Menu
                    label={tx("admin.customfieldsadmin.thao_tac", { p0: f.label })}
                    trigger={
                      <span className={cx(btn, "size-8 min-h-0 px-0")}>
                        <MoreIcon className="size-4" />
                      </span>
                    }
                    items={[
                      { label: tx("admin.customfieldsadmin.sua"), icon: <PencilIcon />, onSelect: () => setFieldModal({ field: f }) },
                      { label: tx("admin.customfieldsadmin.xoa"), icon: <TrashIcon />, danger: true, onSelect: () => void remove(f) },
                    ]}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
        {fieldModal ? <FieldModal field={fieldModal.field} onClose={() => setFieldModal(null)} /> : null}
      </>
    </>
  );
}

/** Key from a label with no Latin letters or digits (e.g. "日本"): a short random one rather than none at all. */
const fallbackKey = () => `f_${Math.random().toString(36).slice(2, 8)}`;

/** Create a field, or edit one: label, options and "required" change; entity, key and type stay (values depend on them). */
function FieldModal({ field, onClose }: { field?: FieldDef; onClose: () => void }) {
  const tx = useT();
  const router = useRouter();
  const [f, setF] = useState(
    field
      ? { entity: field.entity, label: field.label, type: field.type, options: field.options.join(", "), required: field.required }
      : { entity: "task", label: "", type: "text", options: "", required: false },
  );
  const [error, setError] = useState<string | null>(null);
  const [fallback] = useState(fallbackKey);
  const derived = f.label
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^(\d)/, "f_$1")
    .slice(0, 40);
  const key = field ? field.key : derived || (f.label.trim() ? fallback : "");
  const save = async () => {
    try {
      // A new field is created, never upserted: a key in use is refused instead of rewriting that field.
      await api(`work/custom-fields/${f.entity}/${key}${field ? "" : "?create=1"}`, {
        method: "PUT",
        body: {
          label: f.label,
          type: f.type,
          options:
            f.type === "select"
              ? f.options
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean)
              : [],
          required: f.required,
        },
      });
      onClose();
      router.refresh();
    } catch (e) {
      // The server's message says what is wrong ("select fields need options"); `error` is only the HTTP status name.
      const err = e as { status?: number; body?: { message?: string } };
      setError(err.status === 409 ? tx("admin.customfieldsadmin.khoa_da_co", { p0: key }) : (err.body?.message ?? tx("admin.customfieldsadmin.chua_luu_duoc")));
    }
  };
  return (
    <Modal
      title={field ? tx("admin.customfieldsadmin.sua_truong", { p0: field.label }) : tx("admin.customfieldsadmin.them_truong_tuy_chinh")}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btn} onClick={onClose}>
            {tx("admin.customfieldsadmin.huy")}
          </button>
          <button type="button" className={btnPrimary} disabled={!key} onClick={() => void save()}>
            {tx("admin.customfieldsadmin.luu")}
          </button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4">
        <Field label={tx("admin.customfieldsadmin.ten_truong")} hint={key ? tx("admin.customfieldsadmin.khoa", { p0: key }) : undefined} error={error}>
          <input className={input} value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} autoFocus placeholder={tx("admin.customfieldsadmin.khach_hang")} />
        </Field>
        {field ? (
          <p className="text-ink-2 m-0 text-sm">{tx("admin.customfieldsadmin.khoa_co_dinh")}</p>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <PickerField
              label={tx("admin.customfieldsadmin.ap_dung_cho")}
              value={f.entity}
              onChange={(v) => setF({ ...f, entity: v })}
              options={[
                { value: "task", label: tx("admin.customfieldsadmin.viec") },
                { value: "project", label: tx("admin.customfieldsadmin.du_an") },
              ]}
            />
            <PickerField
              label={tx("admin.customfieldsadmin.kieu")}
              value={f.type}
              onChange={(v) => setF({ ...f, type: v })}
              options={[
                { value: "text", label: tx("admin.customfieldsadmin.chu") },
                { value: "number", label: tx("admin.customfieldsadmin.so") },
                { value: "date", label: tx("admin.customfieldsadmin.ngay") },
                { value: "select", label: tx("admin.customfieldsadmin.danh_sach_chon") },
                { value: "boolean", label: tx("admin.customfieldsadmin.co_khong") },
              ]}
            />
          </div>
        )}
        {f.type === "select" ? (
          <Field label={tx("admin.customfieldsadmin.cac_lua_chon")} hint={tx("admin.customfieldsadmin.cach_nhau_bang_dau")}>
            <input className={input} value={f.options} onChange={(e) => setF({ ...f, options: e.target.value })} placeholder={tx("admin.customfieldsadmin.nho_vua_lon")} />
          </Field>
        ) : null}
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={f.required} onChange={(e) => setF({ ...f, required: e.target.checked })} />
          {tx("admin.customfieldsadmin.bat_buoc")}
        </label>
      </div>
    </Modal>
  );
}
