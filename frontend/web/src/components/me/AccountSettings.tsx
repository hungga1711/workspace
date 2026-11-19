"use client";

import { ThemeToggle } from "@/components/ui/ThemeToggle";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n/client";
import { Avatar, useDirectory } from "@/lib/people";
import { btn, btnPrimary, btnSm, cx, input } from "@/lib/ui";
import { BellIcon, BotIcon, CameraIcon, MeIcon, PlaneIcon, ShieldIcon, SparkleIcon } from "@/components/app/icons";

/** Hồ sơ của tôi's sections: a menu on the left, one at a time. */
export type AccountSection = "profile" | "security" | "agents" | "notify" | "away" | "privacy";
export const ACCOUNT_SECTIONS: { key: AccountSection; icon: React.ReactNode }[] = [
  { key: "profile", icon: <MeIcon /> },
  { key: "security", icon: <ShieldIcon /> },
  { key: "agents", icon: <BotIcon /> },
  { key: "notify", icon: <BellIcon /> },
  { key: "away", icon: <PlaneIcon /> },
  { key: "privacy", icon: <SparkleIcon /> },
];

export function useSectionText() {
  const t = useT();
  return (k: AccountSection): { title: string; desc: string; nav?: string } =>
    ({
      profile: { title: t("me.meview.ho_so"), desc: t("me.settings.profileDesc") },
      security: { title: t("me.meview.dang_nhap_va_bao"), desc: t("me.profile.securityMeta") },
      agents: { title: t("mcpServer.me.title"), desc: t("mcpServer.me.desc") },
      notify: { title: t("me.meview.thong_bao"), desc: t("me.profile.notifyMeta") },
      away: { title: t("me.meview.vang_mat_va_uy"), desc: t("me.profile.awayMeta"), nav: t("me.settings.awayNav") },
      privacy: { title: t("me.settings.privacy"), desc: t("me.settings.privacyDesc") },
    })[k];
}

/** The section menu: a column on wide screens, wrapping chips on tablets, a two-column grid on phones (no section cut off). */
export function SectionNav({ active, sections }: { active: AccountSection; sections: AccountSection[] }) {
  const t = useT();
  const text = useSectionText();
  return (
    <nav aria-label={t("me.settings.nav")} className="lg:sticky lg:top-20">
      <ul className="m-0 flex list-none flex-wrap gap-1 p-0 max-sm:grid max-sm:grid-cols-2 lg:grid">
        {ACCOUNT_SECTIONS.filter((s) => sections.includes(s.key)).map((s) => (
          <li key={s.key} className="min-w-0">
            <Link
              href={`/app/me?tab=${s.key}`}
              aria-current={active === s.key ? "page" : undefined}
              className={cx(
                // A long name (Vietnamese runs longer) wraps inside its chip instead of spilling into the page.
                "flex min-h-9 items-center gap-2.5 rounded-lg px-3 py-1.5 text-sm leading-snug no-underline transition-colors max-sm:gap-2 max-sm:px-2.5 lg:py-2 [&_svg]:size-4 [&_svg]:shrink-0",
                active === s.key ? "bg-selected text-ink font-medium" : "text-ink-2 hover:bg-hover hover:text-ink",
              )}
            >
              {s.icon}
              {text(s.key).nav ?? text(s.key).title}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** A section's title in Home's voice: the section's name, one line on what it holds. */
export function SectionHead({ section }: { section: AccountSection }) {
  const text = useSectionText()(section);
  return (
    <header className="min-w-0">
      <h1 className="font-display m-0 text-[28px]/[1.15] font-semibold tracking-[-0.035em] max-sm:text-2xl/[1.2]">{text.title}</h1>
      <p className="text-ink-2 m-0 mt-1.5 text-sm">{text.desc}</p>
    </header>
  );
}

/** A settings card: a title over rows split by hairlines, an optional footer for its save button or a link. */
export function SettingsCard({ title, desc, children, footer }: { title?: string; desc?: string; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <section className="bg-surface shadow-card min-w-0 overflow-hidden rounded-xl">
      {title ? (
        <div className="border-hairline border-b px-5 py-4">
          <h2 className="m-0 text-[15px] font-semibold">{title}</h2>
          {desc ? <p className="text-ink-2 m-0 mt-0.5 text-[13px]">{desc}</p> : null}
        </div>
      ) : null}
      <div className="divide-divider-soft grid grid-cols-1 divide-y">{children}</div>
      {footer ? <div className="border-hairline bg-ground/60 flex items-center justify-end gap-2 border-t px-5 py-3">{footer}</div> : null}
    </section>
  );
}

/** One setting: its name and a hint on the left, the value or control on the right (stacked on phones). */
export function SettingRow({ label, hint, children, htmlFor }: { label: string; hint?: string; children: React.ReactNode; htmlFor?: string }) {
  return (
    <div className="grid min-w-0 items-center gap-x-6 gap-y-2 px-5 py-4 sm:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
      <div className="min-w-0">
        <label htmlFor={htmlFor} className="text-ink block text-sm font-medium">
          {label}
        </label>
        {hint ? <p className="text-ink-2 m-0 mt-0.5 text-xs">{hint}</p> : null}
      </div>
      <div className="min-w-0 text-sm">{children}</div>
    </div>
  );
}

/** A card that holds a self-contained panel (two-step, sessions, keys, notification switches). */
export function PanelCard({ children }: { children: React.ReactNode }) {
  return <section className="bg-surface shadow-card min-w-0 rounded-xl p-5">{children}</section>;
}

export interface ProfileValues {
  displayName: string;
  givenName: string;
  phone: string;
  location: string;
}

/** Hồ sơ: the photo and the four facts people keep themselves, edited in place and saved together. */
export function ProfileForm({ initial, onPhoto, onSave }: { initial: ProfileValues; onPhoto: () => void; onSave: (v: ProfileValues) => Promise<void> }) {
  const t = useT();
  const dir = useDirectory();
  const [v, setV] = useState(initial);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof ProfileValues) => (e: React.ChangeEvent<HTMLInputElement>) => setV((x) => ({ ...x, [k]: e.target.value }));
  // Same rule as the server (identity profile.controller.ts): letters, spaces and ' . -
  const fullOk = /^[\p{L}\p{M}' .-]+$/u.test(v.displayName.trim());
  const dirty = (Object.keys(v) as (keyof ProfileValues)[]).some((k) => v[k] !== initial[k]);
  const valid = fullOk && v.displayName.trim() && v.givenName.trim();
  const hasPhoto = (dir.byId.get(dir.me)?.avatarVersion ?? 0) > 0;
  return (
    <SettingsCard
      title={t("me.settings.publicCard")}
      desc={t("me.profile.fullNameHint")}
      footer={
        <>
          {dirty ? (
            <button type="button" className={btn} onClick={() => setV(initial)}>
              {t("me.meview.huy")}
            </button>
          ) : null}
          <button
            type="button"
            className={btnPrimary}
            disabled={!dirty || !valid || busy}
            onClick={async () => {
              setBusy(true);
              await onSave({ ...v, displayName: v.displayName.trim().replace(/\s+/g, " "), givenName: v.givenName.trim() });
              setBusy(false);
            }}
          >
            {t("me.settings.save")}
          </button>
        </>
      }
    >
      <SettingRow label={t("me.profile.photo")} hint={t("me.settings.photoHint")}>
        <span className="flex items-center gap-4">
          <button type="button" onClick={onPhoto} className="group relative shrink-0 rounded-full" aria-label={hasPhoto ? t("me.profile.changePhoto") : t("me.profile.addPhoto")}>
            <Avatar id={dir.me} name={v.displayName} size="xl" className="size-16 text-xl" />
            <span className="bg-surface border-hairline shadow-raised text-ink-2 group-hover:text-ink absolute -bottom-0.5 -right-0.5 grid size-6 place-items-center rounded-full border">
              <CameraIcon className="size-3" />
            </span>
          </button>
          <button type="button" className={btn} onClick={onPhoto}>
            {hasPhoto ? t("me.profile.changePhoto") : t("me.profile.addPhoto")}
          </button>
        </span>
      </SettingRow>
      <SettingRow label={t("me.profile.fullName")} htmlFor="me-full">
        <input id="me-full" className={input} value={v.displayName} onChange={set("displayName")} maxLength={100} autoComplete="name" />
        {v.displayName.trim() && !fullOk ? <p className="text-block m-0 mt-1 text-xs">{t("me.profile.nameInvalid")}</p> : null}
      </SettingRow>
      <SettingRow label={t("me.meview.ten_goi")} hint={t("me.meview.ten_workspace_dung")} htmlFor="me-given">
        <input id="me-given" className={input} value={v.givenName} onChange={set("givenName")} maxLength={40} />
      </SettingRow>
      <SettingRow label={t("me.meview.so_dien_thoai")} hint={t("me.meview.chi_ban_quan_ly")} htmlFor="me-phone">
        <input id="me-phone" className={input} value={v.phone} onChange={set("phone")} inputMode="tel" autoComplete="tel" />
      </SettingRow>
      <SettingRow label={t("me.meview.noi_lam_viec")} htmlFor="me-loc">
        <input id="me-loc" className={input} value={v.location} onChange={set("location")} placeholder={t("me.meview.ha_noi")} />
      </SettingRow>
    </SettingsCard>
  );
}

/**
 * Giao diện: light or dark, applied at once; and the desktop app, when the admin built one for this server and gave
 * its download link (Admin › Settings). "Open in app" carries this server's address too, so even a copy built without
 * it connects without anyone typing it (frontend/desktop). Hidden inside the app itself and on phones.
 */
export function ThemeCard({ desktopDownload }: { desktopDownload: string | null }) {
  const t = useT();
  const [openInApp, setOpenInApp] = useState<string | null>(null);
  useEffect(() => {
    if (desktopDownload && !("__TAURI_INTERNALS__" in window)) setOpenInApp(`workspace://open?server=${encodeURIComponent(location.origin)}&path=%2Fapp`);
  }, [desktopDownload]);
  return (
    <SettingsCard>
      <SettingRow label={t("theme.title")}>
        <span className="flex sm:justify-end">
          <ThemeToggle />
        </span>
      </SettingRow>
      {openInApp ? (
        <div className="max-md:hidden">
          <SettingRow label={t("desktopApp.title")} hint={t("desktopApp.hint")}>
            <span className="flex gap-2 sm:justify-end">
              <a href={desktopDownload ?? undefined} target="_blank" rel="noreferrer" className={cx(btn, btnSm, "no-underline")}>
                {t("desktopApp.download")}
              </a>
              <a href={openInApp} className={cx(btn, btnSm, "no-underline")}>
                {t("desktopApp.open")}
              </a>
            </span>
          </SettingRow>
        </div>
      ) : null}
    </SettingsCard>
  );
}
