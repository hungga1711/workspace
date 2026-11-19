"use client";

import Link from "next/link";
import { useT } from "@/lib/i18n/client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { useAiFlags } from "@/lib/ai-context";
import { useDirectory } from "@/lib/people";
import { btn, btnPrimary, btnSm, cx } from "@/lib/ui";
import { CheckIcon } from "@/components/app/icons";
import { BrandMark } from "@/components/ui/BrandMark";

/**
 * First run (a fresh install, nothing needs anyone yet): the brand, one sentence and three steps to the first moment
 * of value, each with one button; only the next step's button is solid. Admins: invite, first project, connect AI
 * (optional: everything works without it). Everyone else: a phone number and a first message.
 */
export function StartChecklist() {
  const dir = useDirectory();
  const t = useT();
  // The "connect AI" step only for companies that switched the assistant on (Admin › AI); done once a model answers.
  const { assistant: aiOn, assistantWanted } = useAiFlags();
  const me = dir.byId.get(dir.me);
  const admin = !!me?.roles?.some((r) => r === "Owner" || r === "Admin");
  const [done, setDone] = useState({ invite: false, second: false });
  useEffect(() => {
    void Promise.all([
      admin
        ? api<{ total: number | null }>("identity/members/summary?limit=1")
            .then((m) => (m.total ?? 0) > 1)
            .catch(() => false)
        : api<{ profile: { phone?: string } | null }>("employee/me")
            .then((m) => !!m.profile?.phone)
            .catch(() => false),
      admin
        ? api<{ projects: unknown[] }>("work/projects?limit=1")
            .then((p) => p.projects.length > 0)
            .catch(() => false)
        : // Done once this person has written in #general themselves (others' messages, welcome posts included, do not count).
          api<{ channels: { id: string; name: string | null }[] }>("chat/channels")
            .then((c) => c.channels.find((x) => x.name === "general"))
            .then((g) => (g ? api<{ messages: { authorId: string }[] }>(`chat/channels/${g.id}/messages?limit=100`) : { messages: [] }))
            .then((m) => m.messages.some((x) => x.authorId === dir.me))
            .catch(() => false),
    ]).then(([invite, second]) => setDone({ invite, second }));
  }, [admin, dir.me]);
  const steps: { key: string; label: string; hint: string; href: string; done: boolean; optional?: boolean }[] = admin
    ? [
        { key: "invite", label: t("home.start.invite"), hint: t("home.start.inviteHint"), href: "/admin/workspace/members", done: done.invite },
        { key: "project", label: t("home.start.project"), hint: t("home.start.projectHint"), href: "/app/work/tasks?view=projects&new=project", done: done.second },
        ...(assistantWanted ? [{ key: "ai", label: t("home.start.connectAi"), hint: t("home.start.connectAiHint"), href: "/admin/workspace/ai", done: aiOn, optional: true }] : []),
      ]
    : [
        { key: "invite", label: t("home.start.phone"), hint: t("home.start.phoneHint"), href: "/app/me?tab=profile", done: done.invite },
        { key: "message", label: t("home.start.message"), hint: t("home.start.messageHint"), href: "/app/chat/general", done: done.second },
      ];
  const next = steps.find((s) => !s.done && !s.optional) ?? steps.find((s) => !s.done);
  const n = steps.filter((s) => s.done).length;
  return (
    <section className="bg-surface shadow-card rounded-xl" aria-labelledby="start-h">
      <header className="flex items-start gap-4 px-5 pb-4 pt-5">
        <BrandMark className="size-10 shrink-0" />
        <div className="min-w-0 flex-1">
          <h2 id="start-h" className="m-0 text-base font-semibold tracking-tight">
            {t("home.start.title")}
          </h2>
          <p className="text-ink-2 m-0 mt-0.5 text-sm">{t("home.start.sub", { done: n, total: steps.length })}</p>
        </div>
      </header>
      <ol className="divide-hairline border-hairline m-0 list-none divide-y border-t p-0">
        {steps.map((s, i) => (
          <li key={s.key} className="flex min-h-16 items-center gap-3 px-5 py-3">
            <span
              className={cx(
                "grid size-6 shrink-0 place-items-center rounded-full text-xs font-medium tabular-nums",
                s.done ? "bg-brand text-on-brand" : "border-hairline text-ink-2 border",
              )}
              aria-hidden="true"
            >
              {s.done ? <CheckIcon className="size-3.5" /> : i + 1}
            </span>
            <span className="min-w-0 flex-1">
              <span className={cx("flex items-center gap-2 text-sm font-medium", s.done && "text-ink-2 line-through")}>
                {s.label}
                {s.optional && !s.done ? <span className="bg-hover text-ink-2 rounded-md px-1.5 text-xs font-normal no-underline">{t("home.start.optional")}</span> : null}
              </span>
              {s.done ? <span className="sr-only">{t("home.start.doneSr")}</span> : <span className="text-ink-2 block text-xs/[1.45]">{s.hint}</span>}
            </span>
            {s.done ? null : (
              <Link className={cx(s === next ? btnPrimary : btn, btnSm)} href={s.href}>
                {t("home.start.go")}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
