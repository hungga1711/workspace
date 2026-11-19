"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { useT } from "@/lib/i18n/client";
import { api } from "@/lib/client";
import { btn, btnSm, cx } from "@/lib/ui";
import { BrandMark } from "@/components/ui/BrandMark";
import { refreshWorkspaceSetup } from "@/app/admin/workspace/settings/actions";
import { useConfirm } from "@/components/ui/Confirm";

/** Same limits as the platform module (logo.ts): small marks, not photos. */
const MAX_BYTES = 256 * 1024;
const TYPES = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"];

const base64 = (f: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });

/**
 * Admin › Cài đặt › Thương hiệu: the company logo, saved at once (not with the rest of the form), shown in the app's
 * sidebar and on the sign-in page instead of the standard mark.
 */
export function LogoUpload({ logoUrl }: { logoUrl: string | null }) {
  const tx = useT();
  const { confirm, dialog } = useConfirm();
  const router = useRouter();
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "err" } | null>(null);
  const done = async (text: string) => {
    await refreshWorkspaceSetup();
    setMsg({ text, tone: "ok" });
    router.refresh();
  };
  const upload = async (f: File) => {
    setMsg(null);
    if (!TYPES.includes(f.type)) return setMsg({ text: tx("admin.settingsadmin.logo_sai_kieu"), tone: "err" });
    if (f.size > MAX_BYTES) return setMsg({ text: tx("admin.settingsadmin.logo_qua_lon", { p0: MAX_BYTES / 1024 }), tone: "err" });
    setBusy(true);
    try {
      await api("platform/workspace/logo", { method: "PUT", body: { contentType: f.type, data: await base64(f) } });
      await done(tx("admin.settingsadmin.logo_da_luu"));
    } catch (e) {
      const err = (e as { body?: { error?: string } }).body?.error;
      setMsg({
        text:
          err === "image_too_large"
            ? tx("admin.settingsadmin.logo_qua_lon", { p0: MAX_BYTES / 1024 })
            : err === "invalid_image"
              ? tx("admin.settingsadmin.logo_sai_kieu")
              : tx("admin.settingsadmin.logo_chua_luu"),
        tone: "err",
      });
    } finally {
      setBusy(false);
      if (file.current) file.current.value = "";
    }
  };
  const remove = async () => {
    if (!(await confirm({ title: tx("admin.settingsadmin.logo_go_hoi"), danger: true }))) return;
    setBusy(true);
    try {
      await api("platform/workspace/logo", { method: "DELETE" });
      await done(tx("admin.settingsadmin.logo_da_go"));
    } catch {
      setMsg({ text: tx("admin.settingsadmin.logo_chua_luu"), tone: "err" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {dialog}
      <div className="grid gap-2 md:col-span-2">
        <span className="text-sm font-medium">{tx("admin.settingsadmin.logo")}</span>
        <div className="flex flex-wrap items-center gap-3">
          <span className="bg-surface shadow-card grid size-14 shrink-0 place-items-center overflow-hidden rounded-xl">
            {logoUrl ? <img src={logoUrl} alt={tx("admin.settingsadmin.logo_hien_tai")} className="size-12 object-contain" /> : <BrandMark className="size-9 rounded-md" />}
          </span>
          <label className={cx(btn, btnSm, "cursor-pointer", busy && "pointer-events-none opacity-50")}>
            {logoUrl ? tx("admin.settingsadmin.logo_doi") : tx("admin.settingsadmin.logo_tai_len")}
            <input ref={file} type="file" accept={TYPES.join(",")} className="sr-only" disabled={busy} onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
          </label>
          {logoUrl ? (
            <button type="button" className={cx(btn, btnSm)} disabled={busy} onClick={() => void remove()}>
              {tx("admin.settingsadmin.logo_go")}
            </button>
          ) : null}
        </div>
        <span className="text-ink-2 text-xs">{tx("admin.settingsadmin.logo_goi_y", { p0: MAX_BYTES / 1024 })}</span>
        {msg ? (
          <span className={cx("text-sm", msg.tone === "ok" ? "text-ok" : "text-block")} role="status">
            {msg.text}
          </span>
        ) : null}
      </div>
    </>
  );
}
