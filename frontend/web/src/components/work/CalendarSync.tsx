"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { useT } from "@/lib/i18n/client";
import { btn, btnGhost, btnPrimary, btnSm, cx, input } from "@/lib/ui";
import { HUE, iconTile } from "@/lib/hue";
import { Modal } from "@/components/ui/Modal";
import { CalendarIcon, CheckIcon, CopyIcon, LinkIcon, RefreshIcon } from "@/components/app/icons";

/**
 * Work › Lịch › "Đồng bộ lịch": a private subscription link for Google Calendar, Outlook or Apple
 * Calendar. The link is shown once (only its hash is stored); a new one revokes the old.
 */
export function CalendarSync({ open: controlled, onClose }: { open?: boolean; onClose?: () => void } = {}) {
  const t = useT();
  const [own, setOwn] = useState(false);
  // Controlled from a "⋯" menu (Lịch toolbar), or its own button.
  const open = controlled ?? own;
  const setOpen = (v: boolean) => (controlled === undefined ? setOwn(v) : !v && onClose?.());
  const [active, setActive] = useState<boolean | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!open) return;
    api<{ active: boolean }>("work/calendar/feed")
      .then((r) => setActive(r.active))
      .catch(() => setActive(false));
  }, [open]);
  const make = async () => {
    const r = await api<{ token: string }>("work/calendar/feed", { method: "POST" });
    setLink(`${location.origin}/cal/${r.token}.ics`);
    setActive(true);
  };
  const stop = async () => {
    await api("work/calendar/feed", { method: "DELETE" });
    setLink(null);
    setActive(false);
  };
  const copy = async () => {
    if (!link) return;
    await navigator.clipboard.writeText(link).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  const webcal = link?.replace(/^https?:/, "webcal:");
  return (
    <>
      {controlled === undefined ? (
        <button type="button" className={btn} onClick={() => setOpen(true)}>
          {t("work.calsync.button")}
        </button>
      ) : null}
      {open ? (
        <Modal title={t("work.calsync.title")} onClose={() => setOpen(false)} wide>
          <div className="grid gap-5 text-sm">
            <p className="text-ink-2 m-0">{t("work.calsync.intro")}</p>
            {/* Where sync stands, and the one action that moves it on. */}
            <div className="border-hairline flex flex-wrap items-center gap-3 rounded-lg border p-3">
              <span aria-hidden="true" className={cx(iconTile, "size-9", HUE[active ? "green" : "grey"])}>
                <LinkIcon />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-ink m-0 flex items-center gap-2 font-semibold">
                  {active ? <span aria-hidden="true" className="bg-ok-fill size-2 rounded-full" /> : null}
                  {active ? t("work.calsync.statusOn") : t("work.calsync.statusOff")}
                </p>
                <p className="text-ink-2 m-0 text-[13px]">{active ? (link ? t("work.calsync.secret") : t("work.calsync.activeHidden")) : t("work.calsync.offHint")}</p>
              </div>
              <div className="flex shrink-0 gap-2">
                {active ? (
                  <button type="button" className={cx(btnGhost, btnSm, "text-block! hover:bg-block-wash")} onClick={() => void stop()}>
                    {t("work.calsync.stop")}
                  </button>
                ) : null}
                <button type="button" className={cx(active ? btn : btnPrimary, btnSm)} disabled={active === null} onClick={() => void make()}>
                  {active ? <RefreshIcon /> : null}
                  {active ? t("work.calsync.renew") : t("work.calsync.create")}
                </button>
              </div>
            </div>
            {link ? (
              <div className="flex items-center gap-2">
                <input readOnly value={link} aria-label={t("work.calsync.link")} onFocus={(e) => e.currentTarget.select()} className={cx(input, "bg-ground font-mono text-xs")} />
                <button type="button" className={cx(btn, "shrink-0")} onClick={() => void copy()}>
                  {copied ? <CheckIcon /> : <CopyIcon />}
                  <span aria-live="polite">{copied ? t("work.calsync.copied") : t("work.calsync.copy")}</span>
                </button>
              </div>
            ) : null}
            <section aria-labelledby="calsync-apps" className="grid gap-2">
              <h3 id="calsync-apps" className="text-ink m-0 text-sm font-semibold">
                {t("work.calsync.apps")}
              </h3>
              {!link ? <p className="text-ink-2 m-0 text-[13px]">{t("work.calsync.needLink")}</p> : null}
              <ul className="m-0 grid list-none gap-2 p-0 sm:grid-cols-3">
                {[
                  {
                    name: "Google Calendar",
                    hint: t("work.calsync.googleHint"),
                    action: (
                      <a
                        href={link ? `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal ?? "")}` : undefined}
                        target="_blank"
                        rel="noreferrer"
                        aria-disabled={!link}
                        className={cx(btn, btnSm, "no-underline", !link && "pointer-events-none opacity-50")}
                      >
                        {t("work.calsync.google")}
                      </a>
                    ),
                  },
                  {
                    name: "Outlook",
                    hint: t("work.calsync.outlook"),
                    action: (
                      <button type="button" disabled={!link} className={cx(btn, btnSm)} onClick={() => void copy()}>
                        <CopyIcon />
                        {t("work.calsync.copyLink")}
                      </button>
                    ),
                  },
                  {
                    name: "Apple Calendar",
                    hint: t("work.calsync.appleHint"),
                    action: (
                      <a href={webcal} aria-disabled={!link} className={cx(btn, btnSm, "no-underline", !link && "pointer-events-none opacity-50")}>
                        {t("work.calsync.apple")}
                      </a>
                    ),
                  },
                ].map((a) => (
                  <li key={a.name} className="border-hairline grid content-between gap-3 rounded-lg border p-3">
                    <span className="grid gap-0.5">
                      <span className="text-ink flex items-center gap-2 font-semibold">
                        <CalendarIcon className="text-ink-2 size-4" />
                        {a.name}
                      </span>
                      <span className="text-ink-2 text-[13px]">{a.hint}</span>
                    </span>
                    <span>{a.action}</span>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
