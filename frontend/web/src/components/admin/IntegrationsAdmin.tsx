"use client";

import { IconTile } from "@/components/ui/Bento";
import { CalmEmpty } from "./AdminBits";
import { useToast } from "@/components/ui/Toast";
import { SlackImport } from "./SlackImport";
import { IntegrationsHub } from "./IntegrationsHub";
import { Checkbox } from "@/components/ui/Checkbox";
import { INTL_TAG } from "@/lib/i18n/config";
import { useLocale } from "@/lib/i18n/client";
import { useT, useFormat } from "@/lib/i18n/client";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client";
import { useDirectory } from "@/lib/people";
import { btn, btnPrimary, btnSm, cx, input, mono } from "@/lib/ui";
import { Modal } from "@/components/ui/Modal";
import { Drawer } from "@/components/ui/Drawer";
import { Field } from "@/components/ui/bits";
import { AdminHeader } from "./AdminNav";
import { PickerField } from "./PickerField";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { Menu } from "@/components/ui/Menu";
import Link from "next/link";
import { CalendarIcon, DownloadIcon, LinkIcon, MoreIcon, PlusIcon, SendIcon } from "@/components/app/icons";
import { PERM_LABEL } from "./perm-labels";
import { webhookDisabledText } from "./api-errors";
import { useConfirm } from "@/components/ui/Confirm";

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  permissions: string[];
  createdBy: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  /** Acts as its creator (personal key, Me › Profile) rather than as a workspace integration. */
  personal?: boolean;
}
export interface Webhook {
  id: string;
  url: string;
  description: string;
  events: string[];
  active: boolean;
  failureCount: number;
  disabledReason: string | null;
  createdAt: string;
  lastDelivery: { status: string; responseStatus: number | null; at: string } | null;
}
interface Delivery {
  id: string;
  eventType: string;
  status: string;
  attempts: number;
  responseStatus: number | null;
  error: string | null;
  createdAt: string;
  nextAttemptAt: string;
}

const section = "rounded-xl shadow-card bg-surface";

/**
 * Integrations: API keys for programmatic access and signed outbound webhooks.
 */
export function IntegrationsAdmin({
  keys,
  grantable,
  webhooks,
  events,
  apiBase,
}: {
  keys: ApiKey[];
  grantable: string[];
  /** Null when the webhook list did not load: that section offers a retry, the API keys stay usable. */
  webhooks: Webhook[] | null;
  events: Record<string, string>;
  apiBase: string;
}) {
  const intlTag = INTL_TAG[useLocale()];
  const { ago } = useFormat();
  const tx = useT();
  const { confirm, dialog } = useConfirm();
  const router = useRouter();
  const dir = useDirectory();
  const [modal, setModal] = useState<"key" | "hook" | null>(null);
  const [secret, setSecret] = useState<{ title: string; value: string; hint: string } | null>(null);
  const [open, setOpen] = useState<Webhook | null>(null);
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "err" } | null>(null);
  const live = keys.filter((k) => !k.revokedAt);
  const revoke = async (k: ApiKey) => {
    if (!(await confirm({ title: tx("admin.integrationsadmin.thu_hoi_khoa_moi", { p0: k.name }), danger: true }))) return;
    try {
      await api(`identity/api-keys/${k.id}`, { method: "DELETE" });
      setMsg({ text: tx("admin.integrationsadmin.da_thu_hoi_khoa"), tone: "ok" });
      router.refresh();
    } catch {
      setMsg({ text: tx("admin.integrationsadmin.chua_thu_hoi_duoc"), tone: "err" });
    }
  };
  const hookAction = async (h: Webhook, action: "test" | "toggle" | "rotate" | "delete") => {
    setMsg(null);
    try {
      if (action === "test") {
        const r = await api<{ status: string; responseStatus: number | null; error: string | null }>(`platform/workspace/webhooks/${h.id}/test`, { method: "POST" });
        setMsg(
          r.status === "succeeded"
            ? { tone: "ok", text: tx("admin.integrationsadmin.gui_thu_thanh_cong", { p0: r.responseStatus }) }
            : { tone: "err", text: tx("admin.integrationsadmin.gui_thu_that_bai", { p0: r.error ?? tx("admin.integrationsadmin.khong_ro_loi") }) },
        );
      } else if (action === "toggle") {
        await api(`platform/workspace/webhooks/${h.id}`, { method: "PATCH", body: { active: !h.active } });
        setMsg({ tone: "ok", text: h.active ? tx("admin.integrationsadmin.da_tam_dung_webhook") : tx("admin.integrationsadmin.da_bat_lai_webhook") });
      } else if (action === "rotate") {
        const r = await api<{ secret: string }>(`platform/workspace/webhooks/${h.id}/rotate-secret`, { method: "POST" });
        setSecret({ title: tx("admin.integrationsadmin.khoa_ky_moi"), value: r.secret, hint: tx("admin.integrationsadmin.cap_nhat_khoa_nay") });
      } else {
        if (!(await confirm({ title: tx("admin.integrationsadmin.xoa_webhook_toi", { p0: h.url }), danger: true }))) return;
        await api(`platform/workspace/webhooks/${h.id}`, { method: "DELETE" });
        setMsg({ tone: "ok", text: tx("admin.integrationsadmin.da_xoa_webhook") });
      }
      router.refresh();
    } catch {
      setMsg({ tone: "err", text: tx("admin.integrationsadmin.chua_thuc_hien_duoc") });
    }
  };

  return (
    <>
      {dialog}
      <>
        <AdminHeader title={tx("admin.integrationsadmin.tich_hop")} sub={tx("admin.integrationsadmin.ket_noi_workspace")} />
        {msg ? (
          <p className={cx("mb-4 rounded-lg px-3 py-2 text-sm", msg.tone === "ok" ? "bg-ok-wash text-ok" : "bg-block-wash text-block")} role="status">
            {msg.text}
          </p>
        ) : null}
        <div className="grid grid-cols-[minmax(0,1fr)] gap-8">
          {/* The hub: the tools a company connects, then the ways in that were already here. */}
          <IntegrationsHub />
          <section aria-labelledby="keys-h" className="scroll-mt-20">
            <div className="mb-2 flex items-center gap-3">
              <h2 id="keys-h" className="flex min-w-0 flex-1 items-center gap-3 text-sm/6 font-semibold tracking-[-0.01em]">
                <IconTile tone="violet">
                  <LinkIcon />
                </IconTile>
                {tx("admin.integrationsadmin.khoa_api")} <span className="text-ink-2 font-normal">{live.length}</span>
              </h2>
              <button type="button" className={cx(btn, btnSm)} onClick={() => setModal("key")}>
                <PlusIcon className="size-4" />
                {tx("admin.integrationsadmin.tao_khoa")}
              </button>
            </div>
            <p className="text-ink-2 mb-3 text-sm">
              {tx("admin.integrationsadmin.goi")} <code className={cx(mono, "bg-hover break-all rounded-sm px-1 text-xs")}>{apiBase}/work/tasks</code>{" "}
              {tx("admin.integrationsadmin.voi_header")} <code className={cx(mono, "bg-hover rounded-sm px-1 text-xs")}>Authorization: Bearer wos_…</code>
              {tx("admin.integrationsadmin.khoa_chi_co_nhung")}
            </p>
            <p className="text-ink-2 mb-3 text-sm">
              {tx("apiKeys.mcpHint", { url: `${apiBase}/mcp` })} {tx("apiKeys.mcpDocs")}:{" "}
              <code className={cx(mono, "bg-hover rounded-sm px-1 text-xs")}>docs/integrations/mcp.md</code> · {tx("apiKeys.apiDocs")}:{" "}
              <code className={cx(mono, "bg-hover break-all rounded-sm px-1 text-xs")}>{apiBase}/docs</code> (API_DOCS=1)
            </p>
            {keys.length === 0 ? (
              <CalmEmpty title={tx("admin.integrationsadmin.chua_co_khoa_api")} hint={tx("admin.integrationsadmin.dung_khoa_api_de")} />
            ) : (
              <ul className={cx(section, "divide-hairline m-0 list-none divide-y p-0")}>
                {keys.map((k) => (
                  <li key={k.id} className={cx("flex flex-wrap items-center gap-3 px-4 py-3", k.revokedAt && "text-ink-2")}>
                    <span className="min-w-0 flex-1">
                      {/* Revoked keys read as muted text, not faded opacity (which fell below 4.5:1). */}
                      <span className={cx("block font-medium", k.revokedAt && "line-through decoration-1")}>
                        {k.name} <span className={cx(mono, "text-ink-2 text-xs")}>wos_{k.prefix}_…</span>
                        {k.personal ? <span className="bg-hover text-ink-2 ml-1 rounded-sm px-1.5 py-0.5 text-xs font-normal">{tx("apiKeys.personalBadge")}</span> : null}
                      </span>
                      <span className="text-ink-2 text-xs">{k.permissions.map((p) => PERM_LABEL(tx)[p] ?? p).join(", ")}</span>
                    </span>
                    <span className="text-ink-2 text-xs">
                      {tx("admin.integrationsadmin.tao_boi", {
                        p0: k.revokedAt
                          ? tx("admin.integrationsadmin.da_thu_hoi")
                          : k.lastUsedAt
                            ? tx("admin.integrationsadmin.dung", { p0: ago(k.lastUsedAt) })
                            : tx("admin.integrationsadmin.chua_dung"),
                        p1: dir.name(k.createdBy),
                        p2:
                          k.expiresAt && !k.revokedAt
                            ? tx("admin.integrationsadmin.het_han", { p0: new Date(k.expiresAt).toLocaleDateString(intlTag, { dateStyle: "medium" }) })
                            : "",
                      })}
                    </span>
                    {!k.revokedAt ? (
                      <button type="button" className={cx(btn, btnSm)} onClick={() => void revoke(k)}>
                        {tx("admin.integrationsadmin.thu_hoi")}
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="hooks-h">
            <div className="mb-2 flex items-center gap-3">
              <h2 id="hooks-h" className="flex min-w-0 flex-1 items-center gap-3 text-sm/6 font-semibold tracking-[-0.01em]">
                <IconTile tone="sky">
                  <SendIcon />
                </IconTile>
                Webhook {webhooks ? <span className="text-ink-2 font-normal">{webhooks.length}</span> : null}
              </h2>
              {webhooks ? (
                <button type="button" className={cx(btn, btnSm)} onClick={() => setModal("hook")}>
                  <PlusIcon className="size-4" />
                  {tx("admin.integrationsadmin.them_webhook")}
                </button>
              ) : null}
            </div>
            <p className="text-ink-2 mb-3 text-sm">
              {tx("admin.integrationsadmin.workspace_gui_post")} <code className={cx(mono, "bg-hover rounded-sm px-1 text-xs")}>X-workspace-Signature</code>.{" "}
              {tx("admin.integrationsadmin.thu_lai_5_lan")}
            </p>
            {webhooks === null ? (
              <LoadFailed />
            ) : webhooks.length === 0 ? (
              <CalmEmpty title={tx("admin.integrationsadmin.chua_co_webhook_nao")} hint={tx("admin.integrationsadmin.vi_du_bao_cho")} />
            ) : (
              <ul className={cx(section, "divide-hairline m-0 list-none divide-y p-0")}>
                {webhooks.map((h) => (
                  <li key={h.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <LinkIcon className="text-ink-2 size-4" />
                    <button type="button" onClick={() => setOpen(h)} className="min-w-0 flex-1 text-left">
                      <span className={cx(mono, "block truncate text-sm hover:underline")}>{h.url}</span>
                      <span className="text-ink-2 text-xs">
                        {tx("admin.integrationsadmin.loai_su_kien", { p0: h.description ? `${h.description} · ` : "", p1: h.events.length })}
                      </span>
                    </button>
                    <span className={cx("text-xs", !h.active ? "text-block" : h.lastDelivery?.status === "succeeded" ? "text-ok" : h.lastDelivery ? "text-warn" : "text-ink-2")}>
                      {!h.active
                        ? h.disabledReason
                          ? webhookDisabledText(tx, h.disabledReason)
                          : tx("admin.integrationsadmin.da_tam_dung")
                        : h.lastDelivery
                          ? `${h.lastDelivery.status === "succeeded" ? tx("admin.integrationsadmin.gui_tot") : tx("admin.integrationsadmin.dang_loi")} · ${ago(h.lastDelivery.at)}`
                          : tx("admin.integrationsadmin.chua_gui_lan_nao")}
                    </span>
                    <Menu
                      label={tx("admin.integrationsadmin.thao_tac_cho_webhook", { p0: h.url })}
                      trigger={
                        <span className="text-ink-2 hover:bg-hover grid size-8 place-items-center rounded-md">
                          <MoreIcon />
                        </span>
                      }
                      items={[
                        { label: tx("admin.integrationsadmin.gui_thu"), onSelect: () => void hookAction(h, "test") },
                        { label: tx("admin.integrationsadmin.xem_lich_su_gui"), onSelect: () => setOpen(h) },
                        { label: h.active ? tx("admin.integrationsadmin.tam_dung") : tx("admin.integrationsadmin.bat_lai"), onSelect: () => void hookAction(h, "toggle") },
                        { label: tx("admin.integrationsadmin.doi_khoa_ky"), onSelect: () => void hookAction(h, "rotate") },
                        { label: tx("admin.integrationsadmin.xoa"), danger: true, onSelect: () => void hookAction(h, "delete") },
                      ]}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Calendars: what exists is per person (a private subscription link) plus the holiday calendar import; there
            are no company-wide calendar settings to configure, so this section explains and links. */}
          <section aria-labelledby="cal-h" className={cx(section, "p-4")}>
            <h2 id="cal-h" className="mb-3 flex min-w-0 items-center gap-3 text-sm/6 font-semibold tracking-[-0.01em]">
              <IconTile tone="tangerine">
                <CalendarIcon />
              </IconTile>
              {tx("admin.integrationsadmin.lich_title")}
            </h2>
            <p className="text-ink-2 m-0 text-sm">{tx("admin.integrationsadmin.lich_mo_ta")}</p>
            <ul className="m-0 mt-2 grid list-disc gap-1 pl-5 text-sm">
              <li>
                {tx("admin.integrationsadmin.lich_dong_bo")}{" "}
                <Link href="/app/work/calendar" className="font-medium">
                  {tx("admin.integrationsadmin.lich_mo")}
                </Link>
              </li>
              <li>
                {tx("admin.integrationsadmin.lich_ngay_le")}{" "}
                <Link href="/admin/workspace/holidays" className="font-medium">
                  {tx("admin.integrationsadmin.lich_mo_ngay_le")}
                </Link>
              </li>
            </ul>
          </section>

          {/* Moving in from other tools: everything that imports data, in one place. */}
          <section aria-labelledby="imp-h" className={cx(section, "scroll-mt-20 p-4")}>
            <h2 id="imp-h" className="mb-3 flex min-w-0 items-center gap-3 text-sm/6 font-semibold tracking-[-0.01em]">
              <IconTile tone="rose">
                <DownloadIcon />
              </IconTile>
              {tx("admin.integrationsadmin.nhap_title")}
            </h2>
            <p className="text-ink-2 m-0 text-sm">{tx("admin.integrationsadmin.nhap_mo_ta")}</p>
            <ul className="m-0 mt-2 grid list-disc gap-1 pl-5 text-sm">
              <li>
                {tx("admin.integrationsadmin.nhap_viec")}{" "}
                <Link href="/app/work/tasks?view=projects" className="font-medium">
                  {tx("admin.integrationsadmin.nhap_mo_du_an")}
                </Link>
              </li>
              <li>{tx("admin.integrationsadmin.nhap_slack")}</li>
              <li>
                {tx("admin.integrationsadmin.nhap_ai")}{" "}
                <Link href="/admin/workspace/ai" className="font-medium">
                  {tx("admin.integrationsadmin.nhap_mo_ai")}
                </Link>
              </li>
            </ul>
            <div className="mt-3">
              <SlackImport />
            </div>
          </section>
        </div>

        {modal === "key" ? (
          <KeyModal
            grantable={grantable}
            onClose={() => setModal(null)}
            onCreated={(k) => {
              setModal(null);
              setSecret({ title: tx("admin.integrationsadmin.khoa_api_moi"), value: k, hint: tx("admin.integrationsadmin.sao_chep_va_luu") });
              router.refresh();
            }}
          />
        ) : null}
        {modal === "hook" ? (
          <HookModal
            events={events}
            onClose={() => setModal(null)}
            onCreated={(s) => {
              setModal(null);
              setSecret({ title: tx("admin.integrationsadmin.khoa_ky_webhook"), value: s, hint: tx("admin.integrationsadmin.dung_khoa_nay_de") });
              router.refresh();
            }}
          />
        ) : null}
        {secret ? (
          <Modal
            title={secret.title}
            onClose={() => setSecret(null)}
            footer={
              <button type="button" className={btnPrimary} onClick={() => setSecret(null)}>
                {tx("admin.integrationsadmin.toi_da_luu")}
              </button>
            }
          >
            <p className="text-ink-2 mb-3 text-sm">{secret.hint}</p>
            <input readOnly aria-label={secret.title} className={cx(input, mono, "text-xs")} value={secret.value} onFocus={(e) => e.currentTarget.select()} />
            <button type="button" className={cx(btn, btnSm, "mt-2")} onClick={() => void navigator.clipboard?.writeText(secret.value)}>
              {tx("admin.integrationsadmin.sao_chep")}
            </button>
          </Modal>
        ) : null}
        {open ? <DeliveriesDrawer hook={open} onClose={() => setOpen(null)} /> : null}
      </>
    </>
  );
}

function KeyModal({ grantable, onClose, onCreated }: { grantable: string[]; onClose: () => void; onCreated: (key: string) => void }) {
  const tx = useT();
  const [name, setName] = useState("");
  const [perms, setPerms] = useState<string[]>([]);
  const [days, setDays] = useState("365");
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    try {
      const r = await api<{ key: string }>("identity/api-keys", { method: "POST", body: { name, permissions: perms, expiresInDays: days ? Number(days) : null } });
      onCreated(r.key);
    } catch (e) {
      setError((e as Error).message || tx("admin.integrationsadmin.chua_tao_duoc_khoa"));
    }
  };
  return (
    <Modal
      title={tx("admin.integrationsadmin.tao_khoa_api")}
      wide
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btn} onClick={onClose}>
            {tx("admin.integrationsadmin.huy")}
          </button>
          <button type="button" className={btnPrimary} disabled={!name.trim() || !perms.length} onClick={() => void submit()}>
            {tx("admin.integrationsadmin.tao_khoa")}
          </button>
        </>
      }
    >
      <div className="grid gap-4 md:grid-cols-[1fr_1.4fr]">
        <div className="grid content-start gap-4">
          {error ? (
            <p className="text-block text-sm" role="alert">
              {error}
            </p>
          ) : null}
          <Field label={tx("admin.integrationsadmin.ten_khoa")} hint={tx("admin.integrationsadmin.he_thong_nao_se")}>
            <input className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder={tx("admin.integrationsadmin.dong_bo_erp")} />
          </Field>
          <PickerField
            label={tx("admin.integrationsadmin.het_han_sau")}
            value={days}
            onChange={setDays}
            options={[
              { value: "30", label: tx("admin.integrationsadmin.n30_ngay") },
              { value: "90", label: tx("admin.integrationsadmin.n90_ngay") },
              { value: "365", label: tx("admin.integrationsadmin.n1_nam") },
              { value: "", label: tx("admin.integrationsadmin.khong_het_han") },
            ]}
          />
        </div>
        <fieldset className="grid content-start gap-1.5">
          <legend className="mb-1 text-sm font-medium">{tx("admin.integrationsadmin.quyen_cua_khoa")}</legend>
          <div className="border-hairline grid max-h-72 gap-1 overflow-auto rounded-sm border p-2 text-sm">
            {grantable.map((p) => (
              <label key={p} className="flex items-center gap-2">
                <Checkbox checked={perms.includes(p)} onChange={(e) => setPerms((x) => (e.target.checked ? [...x, p] : x.filter((y) => y !== p)))} />
                {PERM_LABEL(tx)[p] ?? p}
                <span className={cx(mono, "text-ink-2 text-xs")}>{p}</span>
              </label>
            ))}
          </div>
        </fieldset>
      </div>
    </Modal>
  );
}

function HookModal({ events, onClose, onCreated }: { events: Record<string, string>; onClose: () => void; onCreated: (secret: string) => void }) {
  const tx = useT();
  const [url, setUrl] = useState("https://");
  const [description, setDescription] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    try {
      const r = await api<{ secret: string }>("platform/workspace/webhooks", { method: "POST", body: { url, description, events: picked } });
      onCreated(r.secret);
    } catch (e) {
      const m = (e as Error).message;
      setError(
        m.includes("https")
          ? tx("admin.integrationsadmin.dia_chi_phai_dung")
          : m.includes("private")
            ? tx("admin.integrationsadmin.dia_chi_tro_vao")
            : m.includes("resolve")
              ? tx("admin.integrationsadmin.khong_tim_thay_may")
              : tx("admin.integrationsadmin.chua_them_duoc_webhook"),
      );
    }
  };
  return (
    <Modal
      title={tx("admin.integrationsadmin.them_webhook")}
      wide
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btn} onClick={onClose}>
            {tx("admin.integrationsadmin.huy")}
          </button>
          <button type="button" className={btnPrimary} disabled={url.length < 10 || !picked.length} onClick={() => void submit()}>
            {tx("admin.integrationsadmin.them")}
          </button>
        </>
      }
    >
      <div className="grid gap-4 md:grid-cols-2">
        <div className="grid content-start gap-4">
          {error ? (
            <p className="text-block text-sm" role="alert">
              {error}
            </p>
          ) : null}
          <Field label={tx("admin.integrationsadmin.dia_chi_nhan_url")}>
            <input className={input} value={url} onChange={(e) => setUrl(e.target.value)} inputMode="url" />
          </Field>
          <Field label={tx("admin.integrationsadmin.mo_ta_tuy_chon")}>
            <input className={input} value={description} onChange={(e) => setDescription(e.target.value)} placeholder={tx("admin.integrationsadmin.he_thong_ke_toan")} />
          </Field>
        </div>
        <fieldset className="grid content-start gap-1.5">
          <legend className="mb-1 text-sm font-medium">{tx("admin.integrationsadmin.gui_khi")}</legend>
          {Object.entries(events).map(([k, v]) => (
            <label key={k} className="flex items-center gap-2 text-sm">
              <Checkbox checked={picked.includes(k)} onChange={(e) => setPicked((x) => (e.target.checked ? [...x, k] : x.filter((y) => y !== k)))} />
              {v}
            </label>
          ))}
        </fieldset>
      </div>
    </Modal>
  );
}

function DeliveriesDrawer({ hook, onClose }: { hook: Webhook; onClose: () => void }) {
  const { ago } = useFormat();
  const tx = useT();
  const toast = useToast();
  const failed = () => toast({ message: tx("common.actionFailed") });
  const [rows, setRows] = useState<Delivery[] | null>(null);
  const load = useCallback(() => void api<{ deliveries: Delivery[] }>(`platform/workspace/webhooks/${hook.id}/deliveries`).then((r) => setRows(r.deliveries)), [hook.id]);
  useEffect(load, [load]);
  return (
    <Drawer title={tx("admin.integrationsadmin.lich_su_gui_webhook")} onClose={onClose} padded>
      <p className={cx(mono, "text-ink-2 mb-3 truncate text-xs")}>{hook.url}</p>
      {!rows ? (
        <p className="text-ink-2">{tx("admin.integrationsadmin.dang_tai")}</p>
      ) : rows.length === 0 ? (
        <p className="text-ink-2">{tx("admin.integrationsadmin.chua_co_lan_gui")}</p>
      ) : (
        <ul className="m-0 grid list-none gap-2 p-0">
          {rows.map((d) => (
            <li key={d.id} className="border-hairline rounded-md border p-3 text-sm">
              <p className="flex items-center gap-2">
                <span className={cx("font-medium", d.status === "succeeded" ? "text-ok" : d.status === "failed" ? "text-block" : "text-warn")}>
                  {d.status === "succeeded"
                    ? tx("admin.integrationsadmin.thanh_cong")
                    : d.status === "failed"
                      ? tx("admin.integrationsadmin.that_bai")
                      : tx("admin.integrationsadmin.dang_thu_lai")}
                </span>
                <span className={cx(mono, "text-xs")}>{d.eventType}</span>
                <span className="text-ink-2 ml-auto text-xs">{ago(d.createdAt)}</span>
              </p>
              <p className="text-ink-2 mt-1 text-xs">
                {tx("admin.integrationsadmin.lan_thu", { p0: d.attempts, p1: d.responseStatus ? ` · HTTP ${d.responseStatus}` : "", p2: d.error ? ` · ${d.error}` : "" })}
              </p>
              {d.status !== "succeeded" ? (
                <button
                  type="button"
                  className={cx(btn, btnSm, "mt-2")}
                  onClick={() => void api(`platform/workspace/webhooks/${hook.id}/deliveries/${d.id}/redeliver`, { method: "POST" }).then(load).catch(failed)}
                >
                  {tx("admin.integrationsadmin.gui_lai")}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Drawer>
  );
}
