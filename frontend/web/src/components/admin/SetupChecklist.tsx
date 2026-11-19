"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n/client";
import type { MessageKey } from "@/lib/i18n/core";
import { btn, btnGhost, btnSm, cx, progressFill, progressTrack } from "@/lib/ui";
import { CheckIcon } from "@/components/app/icons";
import { Checkbox } from "@/components/ui/Checkbox";
import { adminCard } from "./AdminBits";

export type SetupKey = "email" | "twoStep" | "holidays" | "workWeek" | "backups" | "ai" | "invite";
export interface SetupItem {
  key: SetupKey;
  /** null: unknown (its read failed); the row still shows, with its link. */
  done: boolean | null;
  href?: string;
  optional?: boolean;
}

const HIDE = "wos.admin.setupHidden";
const BACKUPS = "wos.admin.backupsConfirmed";
const read = (k: string) => {
  try {
    return localStorage.getItem(k) === "1";
  } catch {
    return false;
  }
};
const write = (k: string, on: boolean) => {
  try {
    if (on) localStorage.setItem(k, "1");
    else localStorage.removeItem(k);
  } catch {
    /* private window: the card just shows again next time */
  }
};

/**
 * Admin › Overview: what a new installation still needs to work for real (email, two-step sign-in, holidays, the
 * work week, backups, AI, the team), each with its status and a button to the page that fixes it. Backups cannot be
 * checked from here, so the admin ticks that row. Once everything required is done the card can be hidden.
 */
export function SetupChecklist({ items }: { items: SetupItem[] }) {
  const t = useT();
  const [hidden, setHidden] = useState(true);
  const [backups, setBackups] = useState(false);
  useEffect(() => {
    setHidden(read(HIDE));
    setBackups(read(BACKUPS));
  }, []);
  const rows = items.map((i) => (i.key === "backups" ? { ...i, done: backups } : i));
  const required = rows.filter((r) => !r.optional);
  const done = required.filter((r) => r.done).length;
  const complete = done === required.length;
  if (hidden && complete) return null;
  return (
    <section aria-labelledby="setup-h" className={cx(adminCard, "grid gap-4 p-5 max-sm:p-4")}>
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h2 id="setup-h" className="m-0 min-w-0 flex-1 text-sm/6 font-semibold tracking-[-0.01em]">
          {complete ? t("admin.setup.allDone") : t("admin.setup.title")}
        </h2>
        <span className="text-ink-2 text-xs tabular-nums">{t("admin.setup.progress", { done, total: required.length })}</span>
        {complete ? (
          <button
            type="button"
            className={cx(btnGhost, btnSm)}
            onClick={() => {
              write(HIDE, true);
              setHidden(true);
            }}
          >
            {t("admin.setup.hide")}
          </button>
        ) : null}
      </header>
      <span className={progressTrack} aria-hidden="true">
        <span className={progressFill} style={{ width: `${(done / Math.max(1, required.length)) * 100}%` }} />
      </span>
      <ul className="divide-divider-soft m-0 grid list-none divide-y p-0">
        {rows.map((r) => (
          <li key={r.key} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
            <span aria-hidden="true" className={cx("grid size-6 shrink-0 place-items-center rounded-md", r.done ? "bg-ok-wash text-ok" : "bg-hover text-ink-2")}>
              {r.done ? <CheckIcon className="size-3.5" /> : null}
            </span>
            <span className="grid min-w-0 flex-[1_1_16rem] gap-0.5">
              <span className={cx("text-sm font-medium", r.done && "text-ink-2 line-through decoration-1")}>
                {t(`admin.setup.${r.key}` as MessageKey)}
                {r.optional ? <span className="text-ink-2 ml-2 text-xs font-normal no-underline">{t("admin.setup.optional")}</span> : null}
              </span>
              <span className="text-ink-2 text-xs">
                {r.key === "email" && r.done ? t("admin.setup.emailTest") : t(`admin.setup.${r.key}Hint` as MessageKey)}
                {r.key === "backups" ? (
                  <>
                    {" "}
                    <code className="bg-hover rounded px-1 font-mono text-xs">infra/production/backup.sh</code>
                  </>
                ) : null}
              </span>
            </span>
            {/* Below 640px the action wraps under the text: it starts at the text's edge, not under the status square. */}
            {r.key === "backups" ? (
              <Checkbox
                className="max-sm:ml-10"
                checked={backups}
                onChange={(e) => {
                  write(BACKUPS, e.target.checked);
                  setBackups(e.target.checked);
                }}
                label={t("admin.setup.backupsDone")}
              />
            ) : !r.done && r.href ? (
              <Link href={r.href} className={cx(btn, btnSm, "no-underline max-sm:ml-10")}>
                {t("admin.setup.fix")}
              </Link>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
