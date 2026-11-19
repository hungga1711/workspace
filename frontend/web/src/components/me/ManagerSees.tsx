"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { useT } from "@/lib/i18n/client";
import { useAiMonitoring } from "@/lib/ai-context";
import type { TeamPerson } from "@/components/work/team-types";
import { EyeOffIcon } from "@/components/app/icons";
import { taskHref } from "@/lib/links";

/**
 * Me › Tổ chức: exactly what my manager's Follow-up shows about me, and what it never shows.
 * People who can see it are much less likely to feel watched.
 */
export function ManagerSees({ manager }: { manager: string }) {
  const t = useT();
  const monitoring = useAiMonitoring();
  const [me, setMe] = useState<TeamPerson | null | undefined>(undefined);
  useEffect(() => {
    api<{ me: TeamPerson | null }>("work/followup/me")
      .then((r) => setMe(r.me))
      .catch(() => setMe(null));
  }, []);
  if (me === undefined) return null;
  const n = (label: string, v: number) => (
    <span>
      {label} <b className="text-ink tabular-nums">{v}</b>
    </span>
  );
  return (
    <section aria-labelledby="sees-h" className="bg-surface shadow-card grid gap-3 rounded-2xl p-6 max-sm:p-4">
      <h2 id="sees-h" className="m-0 text-[14px]/6 font-semibold">
        {t("me.sees.title", { name: manager })}
      </h2>
      {me ? (
        <>
          <p className="text-ink-2 m-0 flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {n(t("me.sees.inProgress"), me.inProgress)}
            {n(t("me.sees.overdue"), me.overdue)}
            {n(t("me.sees.stale"), me.stale)}
            {n(t("me.sees.done"), me.done7)}
          </p>
          {[...me.now, ...me.late.filter((x) => !me.now.some((y) => y.id === x.id))].length ? (
            <ul className="m-0 grid list-none gap-1 p-0 text-sm">
              {[...me.now, ...me.late.filter((x) => !me.now.some((y) => y.id === x.id))].slice(0, 5).map((x) => (
                <li key={x.id} className="flex gap-2">
                  <Link href={taskHref(x)} className="text-ink truncate no-underline hover:underline" title={x.code}>
                    {x.title}
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : (
        <p className="text-ink-2 m-0 text-sm">{t("me.sees.nothing")}</p>
      )}
      <p className="text-ink-2 m-0 flex items-start gap-2 text-xs">
        <EyeOffIcon className="mt-0.5 size-4 shrink-0" />
        {t("me.sees.never")}
      </p>
      {monitoring ? (
        <p className="text-ink-2 m-0 text-xs">
          {t("me.sees.ai")}{" "}
          <Link href="/app/me?tab=ai#ai-sees" className="text-ink underline-offset-2 hover:underline">
            {t("me.sees.aiLink")}
          </Link>
        </p>
      ) : null}
    </section>
  );
}
