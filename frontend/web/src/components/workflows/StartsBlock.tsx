"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client";
import { useFormat, useT } from "@/lib/i18n/client";
import { useDirectory } from "@/lib/people";
import { btn, btnSm, cx } from "@/lib/ui";
import { CalendarIcon, LinkIcon, SendIcon, WorkIcon } from "@/components/app/icons";
import { useConfirm } from "@/components/ui/Confirm";
import { CopyButton } from "@/components/ui/CopyButton";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { useProjects, useTriggerText } from "./starts";
import type { Trigger, TriggerActivity, TriggerKind, Workflow } from "./types";

const ICON: Record<TriggerKind, React.ReactNode> = { task: <WorkIcon />, schedule: <CalendarIcon />, hook: <SendIcon />, linked: <LinkIcon /> };
const TONE: Record<TriggerActivity["fires"][number]["status"], string> = {
  started: "bg-ok-wash text-ok",
  refused: "bg-warn-wash text-warn",
  pending: "bg-hover text-ink-soft",
};

/**
 * On a workflow's page: how it starts by itself. Each way in words, who its runs act as, the address of
 * a "another system sends something" start (made here, shown once), and the latest times it started or was not
 * started, with the reason. Nothing is drawn for a workflow that only starts when someone presses Run.
 */
export function StartsBlock({ w, className }: { w: Pick<Workflow, "id" | "config" | "canEdit">; className?: string }) {
  const t = useT();
  const f = useFormat();
  const dir = useDirectory();
  const text = useTriggerText();
  const triggers = w.config.triggers ?? [];
  const projects = useProjects(triggers.length > 0);
  const [data, setData] = useState<TriggerActivity | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(() => {
    setFailed(false);
    api<TriggerActivity>(`work/workflows/${w.id}/triggers`)
      .then(setData)
      .catch(() => setFailed(true));
  }, [w.id]);
  useEffect(() => {
    if (triggers.length) load();
  }, [triggers.length, load]);
  if (!triggers.length) return null;
  return (
    <section className={cx("bg-surface shadow-card grid min-w-0 gap-4 rounded-xl p-4", className)} aria-labelledby="wf-starts-h">
      <div>
        <h2 id="wf-starts-h" className="text-ink m-0 text-sm font-semibold">
          {t("workflows.start.title")}
        </h2>
        <p className="text-ink-2 m-0 text-[13px]">
          {data?.runAs ? t("workflows.start.runAs", { name: dir.name(data.runAs) }) : t("workflows.start.lead")}
          {data ? ` ${t("workflows.start.limit", { n: data.limits.perHour })}` : ""}
        </p>
      </div>
      <ul className="m-0 grid min-w-0 list-none gap-2 p-0">
        {triggers.map((x) => (
          <li key={x.id} className="ring-hairline grid min-w-0 gap-2.5 rounded-lg px-3 py-2.5 ring-1 ring-inset">
            <div className="flex min-w-0 items-start gap-2.5">
              <span aria-hidden="true" className="bg-accent-wash text-accent-text mt-px grid size-6 shrink-0 place-items-center rounded-md [&_svg]:size-3.5">
                {ICON[x.kind]}
              </span>
              <p className="text-ink m-0 min-w-0 flex-1 text-[13px]/6 [overflow-wrap:anywhere]">
                {text(x, projects.projects).map((part, i) => (
                  <span key={i} className={i ? "text-ink-2" : "font-medium"}>
                    {i ? " · " : ""}
                    {part}
                  </span>
                ))}
              </p>
            </div>
            {x.kind === "hook" ? <HookAddress w={w} trigger={x} hook={data?.hooks.find((h) => h.triggerId === x.id)} onChanged={load} /> : null}
          </li>
        ))}
      </ul>
      {failed ? (
        <LoadFailed what={t("workflows.start.recent")} onRetry={load} />
      ) : data ? (
        <div className="grid min-w-0 gap-1.5">
          <h3 className="text-ink-2 m-0 text-xs font-medium">{t("workflows.start.recent")}</h3>
          {data.fires.length ? (
            <ul className="divide-divider-soft m-0 grid min-w-0 list-none divide-y p-0">
              {data.fires.slice(0, 8).map((x) => (
                <li key={x.id} className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5 py-1.5 text-[13px]">
                  <span className={cx("inline-flex h-5 shrink-0 items-center rounded px-1.5 text-xs font-medium", TONE[x.status])}>{t(`workflows.start.fire.${x.status}`)}</span>
                  <span className="text-ink-soft shrink-0">{t(`workflows.start.kind.${x.kind}`)}</span>
                  {x.task ? (
                    <Link href={`/app/work/tasks/${x.task.code}`} className="text-ink min-w-0 truncate no-underline hover:underline">
                      {x.task.code} · {x.task.title}
                    </Link>
                  ) : null}
                  <span className="text-ink-2 ml-auto shrink-0 text-xs tabular-nums">{f.ago(x.at)}</span>
                  {/* Why it was not started, as the server says it. */}
                  {x.status === "refused" && x.reason ? <span className="text-ink-2 w-full text-xs [overflow-wrap:anywhere]">{x.reason}</span> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-ink-2 m-0 text-[13px]">{t("workflows.start.fire.none")}</p>
          )}
        </div>
      ) : null}
    </section>
  );
}

/**
 * The secret address another system sends to. Only its last characters are kept to show; the whole address appears
 * once, right after it is made, to be copied where it will be used. Making a new one stops the old one.
 */
function HookAddress({
  w,
  trigger,
  hook,
  onChanged,
}: {
  w: Pick<Workflow, "id" | "canEdit">;
  trigger: Trigger;
  hook: TriggerActivity["hooks"][number] | undefined;
  onChanged: () => void;
}) {
  const t = useT();
  const f = useFormat();
  const { confirm, dialog } = useConfirm();
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const make = async () => {
    if (
      hook &&
      !(await confirm({ title: t("workflows.start.address.replaceTitle"), body: t("workflows.start.address.replaceBody"), confirmLabel: t("workflows.start.address.replace") }))
    )
      return;
    setBusy(true);
    setError(false);
    try {
      const r = await api<{ path: string }>(`work/workflows/${w.id}/triggers/${trigger.id}/address`, { method: "POST" });
      setAddress(`${window.location.origin}${r.path}`);
      onChanged();
    } catch {
      setError(true);
    }
    setBusy(false);
  };
  return (
    <div className="grid min-w-0 gap-2 pl-[2.125rem]">
      {address ? (
        <div className="bg-ok-wash/60 grid min-w-0 gap-2 rounded-lg px-3 py-2.5">
          <p className="text-ink m-0 text-[13px] font-medium">{t("workflows.start.address.once")}</p>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <code className="bg-surface ring-hairline text-ink min-w-0 flex-1 basis-64 break-all rounded-md px-2 py-1.5 font-mono text-xs ring-1 ring-inset">{address}</code>
            <CopyButton text={address} />
          </div>
          <p className="text-ink-2 m-0 text-xs">{t("workflows.start.address.how")}</p>
        </div>
      ) : (
        <p className="text-ink-2 m-0 text-xs">
          {hook
            ? [
                t("workflows.start.address.has", { hint: hook.hint }),
                hook.lastUsedAt ? t("workflows.start.address.used", { when: f.ago(hook.lastUsedAt) }) : t("workflows.start.address.unused"),
              ].join(" · ")
            : t("workflows.start.address.none")}
        </p>
      )}
      {w.canEdit ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <button type="button" className={cx(btn, btnSm)} disabled={busy} onClick={() => void make()}>
            {t(hook || address ? "workflows.start.address.replace" : "workflows.start.address.create")}
          </button>
          {error ? (
            <span role="alert" className="text-block text-xs">
              {t("workflows.start.address.failed")}
            </span>
          ) : null}
        </div>
      ) : null}
      {dialog}
    </div>
  );
}
