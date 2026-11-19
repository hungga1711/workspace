"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Menu } from "@/components/ui/Menu";
import { useLocale, useSetLocale, useT } from "@/lib/i18n/client";
import { useStatus } from "@/lib/status";
import { Picker } from "@/components/ui/Picker";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { GlobeIcon, HelpIcon, LogoutIcon, MeIcon, SettingsIcon, SmileIcon, UsersIcon } from "@/components/app/icons";
import { LOCALES, LOCALE_NAME, type Locale } from "@/lib/i18n/config";
import type { ShellUser } from "./types";

const StatusDialog = dynamic(() => import("@/components/app/StatusDialog").then((m) => m.StatusDialog), { ssr: false });

/** The top bar listens for this and opens the shortcuts list (the "?" key does the same). */
export const SHORTCUTS_EVENT = "wx:shortcuts";

/**
 * The account menu (the avatar in the top bar's corner; the company's name has no menu): Hồ sơ của tôi, status,
 * Danh bạ, Quản trị công ty for admins, shortcuts, sign out; under them the language (a list, so more languages fit)
 * and a light/dark switch.
 */
export function AccountMenu({ user, trigger, align = "left" }: { user: ShellUser; trigger: React.ReactNode; align?: "left" | "right" }) {
  const router = useRouter();
  const t = useT();
  const status = useStatus();
  const mine = status.me ? status.get(status.me) : null;
  const [statusOpen, setStatusOpen] = useState(false);
  const logout = useRef<HTMLFormElement>(null);
  const items = [
    { label: t("shell.nav.me"), icon: <MeIcon />, onSelect: () => router.push("/app/me") },
    { label: mine ? `${mine.emoji} ${mine.text || t("status.dnd")}`.trim() : t("status.set"), icon: <SmileIcon />, onSelect: () => setStatusOpen(true) },
    { label: t("shell.nav.people"), icon: <UsersIcon />, onSelect: () => router.push("/app/me/people") },
    ...(user.isAdmin ? [{ label: t("shell.top.adminWorkspace"), icon: <SettingsIcon />, onSelect: () => router.push("/admin/workspace") }] : []),
    { label: t("shell.top.shortcuts"), icon: <HelpIcon />, onSelect: () => window.dispatchEvent(new Event(SHORTCUTS_EVENT)) },
    { label: t("shell.top.logout"), icon: <LogoutIcon />, onSelect: () => logout.current?.requestSubmit() },
  ];
  return (
    <>
      <Menu label={t("shell.top.account", { name: user.name })} items={items} align={align} trigger={trigger} footer={<Preferences />} />
      <form ref={logout} action="/auth/logout" method="post" hidden />
      {statusOpen ? <StatusDialog onClose={() => setStatusOpen(false)} /> : null}
    </>
  );
}

/** Language (each name in its own language) and the light/dark switch; both apply at once. */
function Preferences() {
  const t = useT();
  const locale = useLocale();
  const setLocale = useSetLocale();
  return (
    <div className="flex items-center gap-2">
      <GlobeIcon className="text-ink-2 ml-1 size-4 shrink-0" />
      <Picker
        className="min-w-0 flex-1"
        // The menu sits at the window's right edge: the list opens leftwards, inside it.
        align="right"
        label={t("shell.top.language")}
        value={locale}
        onChange={(v) => setLocale(v as Locale)}
        options={LOCALES.map((l) => ({ value: l, label: LOCALE_NAME[l] }))}
      />
      <ThemeToggle />
    </div>
  );
}
