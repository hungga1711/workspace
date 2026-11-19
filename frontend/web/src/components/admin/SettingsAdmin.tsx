"use client";

import { useFeature } from "@/lib/features-context";
import type { T } from "@/lib/i18n/core";
import { useLocale, useT } from "@/lib/i18n/client";
import { INTL_TAG } from "@/lib/i18n/config";
import { COUNTRIES, COUNTRY_RULES, countryFromZone, holidaysFor, isCountry, regionName } from "@/lib/country";
import { useConfirm } from "@/components/ui/Confirm";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { btnPrimary, cx, input } from "@/lib/ui";
import { Field } from "@/components/ui/bits";
import { PickerField } from "./PickerField";
import { refreshWorkspaceSetup } from "@/app/admin/workspace/settings/actions";
import { TimeZoneField } from "@/components/ui/TimeZoneField";
import { CURRENCIES } from "@/lib/money";
import { AdminHeader } from "./AdminNav";
import { adminCard } from "./AdminBits";
import { IconTile, type Tone } from "@/components/ui/Bento";
import { GlobeIcon, HashIcon, ScreenIcon, SendIcon, SettingsIcon, StarIcon } from "@/components/app/icons";
import dynamic from "next/dynamic";
import Link from "next/link";

// Below the fold or rarely used: their own chunks.
const EmailSettings = dynamic(() => import("./EmailSettings").then((m) => m.EmailSettings));
const LogoUpload = dynamic(() => import("./LogoUpload").then((m) => m.LogoUpload));

export interface WsConfig {
  features: { attendance: boolean; customWorkflow: boolean; ai?: { assistant: boolean; monitoring: boolean } };
  home: { sections: { announcements: boolean; attendance: boolean } };
  branding: { displayName: string; primaryColor: string; logoUrl: string | null };
  codeFormats: { task: string; project: string; document: string; employee: string; request: string; meeting: string; whiteboard: string };
  locale: "vi" | "en" | "zh" | "es";
  timezone: string;
  /** ISO 4217, for approval amounts and AI budgets shown in money. */
  currency: string;
  /** ISO 3166, where the company works: holidays, default leave and the currency suggested follow it. */
  country?: string | null;
  /** "insights": AI Insights only, tasks from the team's own tool through task sync (Admin › Integrations › Task sync). */
  mode?: "full" | "insights";
  /** Where staff download the desktop app the admin built for this server; Profile offers it when set. */
  desktopDownloadUrl?: string | null;
}
const FEATURES = (tx: T): [keyof WsConfig["features"], string, string][] => [["attendance", tx("admin.settingsadmin.cham_cong"), tx("admin.settingsadmin.nhan_vien_cham_cong")]];

/** Workspace configuration: features, Home widgets, branding, entity codes. Same code, different config. */
/** A code as the pattern makes it, for an example: the 12th one this year ("M-{seq3}" → "M-012"). */
const codeExample = (pattern: string) =>
  pattern
    .replace(/\{seq(\d)\}/g, (_, n: string) => "12".padStart(Number(n), "0"))
    .replace(/\{yyyy\}/g, String(new Date().getFullYear()))
    .replace(/\{id10\}/g, "01M6A2B3C4");

export function SettingsAdmin({ version, config }: { version: number; config: WsConfig }) {
  const tx = useT();
  const hasTime = useFeature("time");
  const hasAi = useFeature("ai");
  const locale = useLocale();
  const router = useRouter();
  // One source for the company's country: when Settings has none yet, the time zone suggests one (a London company is in
  // the UK), shown as a suggestion until saved, so Settings, Holidays and Leave never disagree.
  const guess = isCountry(config.country) ? null : countryFromZone(config.timezone, config.locale);
  const [c, setC] = useState<WsConfig>(guess ? { ...config, country: guess } : config);
  const { confirm, dialog } = useConfirm();
  // The build command names this server's address (as staff open it), known only in the browser.
  const [origin, setOrigin] = useState("https://work.company.com");
  useEffect(() => setOrigin(location.origin), []);
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "err" } | null>(null);
  // The logo saves on its own (LogoUpload): a new upload is not an unsaved change of this form.
  const withoutLogo = (x: WsConfig) => JSON.stringify({ ...x, branding: { ...x.branding, logoUrl: null } });
  const dirty = withoutLogo(c) !== withoutLogo(config);
  const save = async () => {
    try {
      // The Home attendance block follows the attendance feature (its own switch was a duplicate).
      const next = { ...c, home: { sections: { ...c.home.sections, attendance: c.features.attendance } } };
      await api("platform/workspace/config", { method: "PUT", body: { version, config: next } });
      const country = c.country;
      if (isCountry(country) && country !== config.country) {
        const y = new Date().getFullYear();
        const name = regionName(country, INTL_TAG[locale]);
        if (
          await confirm({
            title: tx("admin.settingsadmin.applyHolidaysTitle", { country: name }),
            body: tx("admin.settingsadmin.applyHolidaysBody", { country: name, y1: y, y2: y + 1 }),
            confirmLabel: tx("admin.settingsadmin.applyHolidays"),
          })
        )
          await api("employee/holidays/bulk", { method: "POST", body: { holidays: [...holidaysFor(country, y), ...holidaysFor(country, y + 1)] } }).catch(() => undefined);
      }
      // Language and time zone are read through a server cache: drop it first, so this refresh already shows them.
      await refreshWorkspaceSetup();
      setMsg({ text: tx("admin.settingsadmin.da_luu_nhan_vien"), tone: "ok" });
      router.refresh();
    } catch (e) {
      const s = e as { status?: number; body?: { message?: string } };
      setMsg({
        tone: "err",
        text:
          s.status === 409
            ? tx("admin.settingsadmin.cau_hinh_vua_duoc")
            : s.status === 400
              ? tx("admin.settingsadmin.gia_tri_chua_hop", { p0: s.body?.message ?? "" })
              : tx("admin.settingsadmin.chua_luu_duoc"),
      });
    }
  };
  const toggle = (on: boolean, onChange: (v: boolean) => void, label: string) => (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={cx("relative h-6 w-11 shrink-0 rounded-full transition-colors", on ? "bg-brand" : "bg-hairline")}
    >
      <span className={cx("bg-surface absolute top-0.5 size-5 rounded-full shadow transition-all", on ? "left-[22px]" : "left-0.5")} />
    </button>
  );
  return (
    <>
      {dialog}
      <AdminHeader
        title={tx("admin.settingsadmin.cai_dat_workspace")}
        actions={
          <button type="button" className={btnPrimary} disabled={!dirty} onClick={() => void save()}>
            {tx("admin.settingsadmin.luu_thay_doi")}
          </button>
        }
      />
      {msg ? (
        <p className={cx("mb-4 rounded-lg px-3 py-2 text-sm", msg.tone === "ok" ? "bg-ok-wash text-ok" : "bg-block-wash text-block")} role="status">
          {msg.text}
        </p>
      ) : null}
      <div className="divide-divider grid divide-y">
        {hasTime || hasAi ? (
          <Setting id="f-h" title={tx("admin.settingsadmin.tinh_nang")} icon={<SettingsIcon />} tone="sky" bare>
            <ul className="divide-divider-soft shadow-card bg-surface m-0 list-none divide-y overflow-hidden rounded-xl p-0">
              {/* The attendance switch only where the deployment has Chấm công; AI Insights only where it has AI. */}
              {(hasTime ? FEATURES(tx) : []).map(([k, l, d]) => (
                <li key={k} className="flex items-center gap-4 px-4 py-3">
                  <span className="flex-1">
                    <span className="block text-sm font-medium">{l}</span>
                    <span className="text-ink-2 text-sm">{d}</span>
                  </span>
                  {toggle(Boolean(c.features[k]), (v) => setC({ ...c, features: { ...c.features, [k]: v } }), l)}
                </li>
              ))}
              {/* AI Insights only: the short navigation; it needs the extension's records, so it turns them on. */}
              {hasAi ? (
                <li className="flex items-center gap-4 px-4 py-3">
                  <span className="flex-1">
                    <span className="block text-sm font-medium">{tx("admin.settingsadmin.modeInsights")}</span>
                    <span className="text-ink-2 text-sm">
                      {tx("admin.settingsadmin.modeInsightsHint")} <Link href="/admin/workspace/integrations/task-sync">{tx("admin.settingsadmin.modeInsightsLink")}</Link>
                    </span>
                  </span>
                  {toggle(
                    c.mode === "insights",
                    (v) =>
                      setC({
                        ...c,
                        mode: v ? "insights" : "full",
                        features: v ? { ...c.features, ai: { assistant: c.features.ai?.assistant ?? false, monitoring: true } } : c.features,
                      }),
                    tx("admin.settingsadmin.modeInsights"),
                  )}
                </li>
              ) : null}
            </ul>
          </Setting>
        ) : null}
        <Setting id="b-h" title={tx("admin.settingsadmin.thuong_hieu")} desc={tx("admin.settingsadmin.chi_to_o_logo")} icon={<StarIcon />} tone="rose">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label={tx("admin.settingsadmin.ten_hien_thi")}>
              <input className={input} value={c.branding.displayName} maxLength={80} onChange={(e) => setC({ ...c, branding: { ...c.branding, displayName: e.target.value } })} />
            </Field>
            <Field label={tx("admin.settingsadmin.mau_logo")}>
              <span className="flex items-center gap-2">
                <input
                  type="color"
                  className="border-hairline h-9 w-11 shrink-0 rounded-md border"
                  value={c.branding.primaryColor}
                  onChange={(e) => setC({ ...c, branding: { ...c.branding, primaryColor: e.target.value.toUpperCase() } })}
                  aria-label={tx("admin.settingsadmin.chon_mau")}
                />
                <input
                  className={cx(input, "font-mono")}
                  value={c.branding.primaryColor}
                  onChange={(e) => setC({ ...c, branding: { ...c.branding, primaryColor: e.target.value } })}
                />
              </span>
            </Field>
            <LogoUpload logoUrl={config.branding.logoUrl} />
          </div>
        </Setting>
        <Setting id="d-h" title={tx("desktopApp.adminTitle")} desc={tx("desktopApp.adminDesc")} icon={<ScreenIcon />} tone="sky">
          <div className="grid gap-3">
            <code className="bg-ground border-hairline block overflow-x-auto whitespace-nowrap rounded-lg border px-3 py-2 font-mono text-[13px]">pnpm desktop:build {origin}</code>
            <Field label={tx("desktopApp.adminLink")} hint={tx("desktopApp.adminHint")}>
              <input
                className={input}
                type="url"
                inputMode="url"
                placeholder="https://drive.company.com/workspace-desktop"
                value={c.desktopDownloadUrl ?? ""}
                onChange={(e) => setC({ ...c, desktopDownloadUrl: e.target.value.trim() || null })}
              />
            </Field>
          </div>
        </Setting>
        <Setting
          id="c-h"
          icon={<HashIcon />}
          tone="violet"
          title={tx("admin.settingsadmin.ma_dinh_danh")}
          desc={tx("admin.settingsadmin.code_format_help", { id: "{id10}", year: "{yyyy}", seq: "{seq6}" })}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            {(Object.keys(c.codeFormats) as (keyof WsConfig["codeFormats"])[]).map((k) => (
              <Field
                key={k}
                // The example follows the pattern typed above (it said "H-012-1" beside an "M-{seq3}" pattern).
                hint={
                  k === "meeting"
                    ? tx("admin.settingsadmin.meeting_code_hint", { first: `${codeExample(c.codeFormats.meeting)}-1`, second: `${codeExample(c.codeFormats.meeting)}-2` })
                    : undefined
                }
                label={
                  {
                    task: tx("admin.settingsadmin.viec"),
                    project: tx("admin.settingsadmin.du_an"),
                    document: tx("admin.settingsadmin.tai_lieu"),
                    employee: tx("admin.settingsadmin.nhan_vien"),
                    request: tx("admin.settingsadmin.yeu_cau"),
                    meeting: tx("admin.settingsadmin.cuoc_hop"),
                    whiteboard: tx("admin.settingsadmin.bang_trang"),
                  }[k]
                }
              >
                <input
                  className={cx(input, "font-mono")}
                  value={c.codeFormats[k]}
                  onChange={(e) => setC({ ...c, codeFormats: { ...c.codeFormats, [k]: e.target.value.toUpperCase().replace(/[^A-Z0-9{}\-a-z]/g, "") } })}
                />
              </Field>
            ))}
          </div>
        </Setting>
        <Setting id="m-h" title={tx("admin.email.title")} desc={tx("admin.email.desc")} icon={<SendIcon />} tone="green">
          <EmailSettings />
        </Setting>
        <Setting id="l-h" title={tx("admin.settingsadmin.ngon_ngu_mui_gio")} icon={<GlobeIcon />} tone="tangerine">
          <div className="grid gap-4 sm:grid-cols-2">
            <PickerField
              label={tx("admin.settingsadmin.ngon_ngu")}
              value={c.locale}
              onChange={(v) => setC({ ...c, locale: v as WsConfig["locale"] })}
              options={[
                { value: "en", label: "English" },
                { value: "vi", label: "Tiếng Việt" },
                { value: "zh", label: "中文 (简体)" },
                { value: "es", label: "Español" },
              ]}
            />
            <div className="grid min-w-0 content-start gap-1.5">
              <span className="text-sm font-medium" aria-hidden="true">
                {tx("admin.settingsadmin.mui_gio")}
              </span>
              <TimeZoneField label={tx("admin.settingsadmin.mui_gio")} value={c.timezone} onChange={(v) => setC({ ...c, timezone: v })} />
            </div>
            <PickerField
              label={tx("admin.settingsadmin.country")}
              hint={guess && c.country === guess ? tx("admin.settingsadmin.countrySuggested") : tx("admin.settingsadmin.countryHint")}
              value={c.country ?? ""}
              // A new country suggests its currency; the admin can still pick another below.
              onChange={(v) => setC({ ...c, country: v || null, ...(isCountry(v) ? { currency: COUNTRY_RULES[v].currency } : {}) })}
              options={[
                ...COUNTRIES.map((k) => ({ value: k, label: regionName(k, INTL_TAG[locale]) })).sort((a, b) => a.label.localeCompare(b.label)),
                { value: "", label: tx("admin.settingsadmin.countryOther") },
              ]}
            />
            <PickerField
              label={tx("admin.settingsadmin.tien_te")}
              hint={tx("admin.settingsadmin.tien_te_hint")}
              value={c.currency ?? "VND"}
              onChange={(v) => setC({ ...c, currency: v })}
              options={CURRENCIES.map((code) => ({ value: code, label: code }))}
            />
          </div>
        </Setting>
      </div>
    </>
  );
}

/**
 * One settings block: a tinted icon tile, the title and a short description on the left, the controls on the right
 * (lg+) in a white card (`bare` when the controls already are one, such as a list of switches).
 */
function Setting({
  id,
  title,
  desc,
  icon,
  tone,
  bare,
  children,
}: {
  id: string;
  title: string;
  desc?: string;
  icon: React.ReactNode;
  tone: Tone;
  bare?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="grid gap-4 py-7 first:pt-1 lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)] lg:gap-10">
      <div className="flex min-w-0 items-start gap-3">
        <IconTile tone={tone}>{icon}</IconTile>
        <div className="min-w-0">
          <h2 id={id} className="m-0 text-sm/6 font-semibold leading-8 tracking-[-0.01em]">
            {title}
          </h2>
          {desc ? <p className="text-ink-2 m-0 mt-1 text-[13px]/[1.5]">{desc}</p> : null}
        </div>
      </div>
      <div className={cx("min-w-0", !bare && cx(adminCard, "p-5 max-sm:p-4"))}>{children}</div>
    </section>
  );
}
