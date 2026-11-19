"use client";

import Link from "next/link";
import { Checkbox } from "@/components/ui/Checkbox";
import { useState } from "react";
import { api } from "@/lib/client";
import { useT } from "@/lib/i18n/client";
import { useDirectory } from "@/lib/people";
import { btn, btnPrimary, cx } from "@/lib/ui";
import { Modal } from "@/components/ui/Modal";
import type { SlackPlan } from "./slackExport";

/**
 * Admin › Tích hợp › "Chuyển từ Slack": a Slack workspace export (.zip) becomes channels here with
 * their history. Read in the browser; each channel is imported in its own request.
 */
export function SlackImport() {
  const t = useT();
  const dir = useDirectory();
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState<SlackPlan | null>(null);
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ source: string; name: string; channelId: string; imported: number }[]>([]);

  const [fileName, setFileName] = useState("");
  const read = async (f: File | undefined) => {
    setFileName(f?.name ?? "");
    setError(null);
    setPlan(null);
    setDone([]);
    if (!f) return;
    if (f.size > 200 * 1024 * 1024) return setError(t("admin.slack.tooBig"));
    try {
      const { planSlack } = await import("./slackExport");
      const p = planSlack(
        await f.arrayBuffer(),
        [...dir.byId.values()].map((x) => ({ userId: x.userId, displayName: x.displayName, email: x.email ?? "" })),
      );
      if (!p.channels.length) return setError(t("admin.slack.notExport"));
      setPlan(p);
      setPick(new Set(p.channels.filter((c) => c.messages.length).map((c) => c.name)));
    } catch {
      setError(t("admin.slack.notExport"));
    }
  };
  const run = async () => {
    if (!plan) return;
    setBusy(true);
    setError(null);
    for (const ch of plan.channels.filter((c) => pick.has(c.name))) {
      try {
        const r = await api<{ channelId: string; name: string; imported: number }>("chat/imports/slack", {
          method: "POST",
          body: { name: ch.name, topic: ch.topic, messages: ch.messages },
        });
        setDone((d) => [...d, { ...r, source: ch.name }]);
      } catch {
        setError(t("admin.slack.failed", { name: ch.name }));
        break;
      }
    }
    setBusy(false);
  };
  const toggle = (name: string) => setPick((s) => (s.has(name) ? new Set([...s].filter((x) => x !== name)) : new Set([...s, name])));

  return (
    <>
      <button type="button" className={btn} onClick={() => setOpen(true)}>
        {t("admin.slack.button")}
      </button>
      {open ? (
        <Modal
          title={t("admin.slack.title")}
          onClose={() => setOpen(false)}
          wide
          footer={
            <>
              <button type="button" className={btn} onClick={() => setOpen(false)}>
                {t("common.close")}
              </button>
              <button type="button" className={btnPrimary} disabled={!plan || busy || pick.size === 0 || done.length > 0} onClick={() => void run()}>
                {busy ? t("admin.slack.importing", { done: done.length, total: pick.size }) : t("admin.slack.run", { count: pick.size })}
              </button>
            </>
          }
        >
          <div className="grid gap-4 text-sm">
            <p className="text-ink-2 m-0">{t("admin.slack.intro")}</p>
            {/* The browser's own file control reads "Choose File / No file chosen" in its language, not the app's. */}
            <div className="grid gap-1.5">
              <span className="font-semibold">{t("admin.slack.file")}</span>
              <span className="flex min-w-0 items-center gap-3">
                <label className={cx(btn, "cursor-pointer has-[:focus-visible]:ring-2")}>
                  {t("common.chooseFile")}
                  <input type="file" accept=".zip,application/zip" aria-label={t("admin.slack.file")} onChange={(e) => void read(e.target.files?.[0])} className="sr-only" />
                </label>
                <span className="text-ink-2 min-w-0 truncate">{fileName || t("common.noFile")}</span>
              </span>
            </div>
            {error ? (
              <p role="alert" className="bg-block-wash text-block m-0 rounded-lg px-3 py-2">
                {error}
              </p>
            ) : null}
            {plan ? (
              <>
                <p className="m-0">{t("admin.slack.people", { matched: plan.matched, total: plan.people })}</p>
                <ul className="bg-surface shadow-card divide-divider-soft m-0 max-h-64 list-none divide-y overflow-auto rounded-xl p-0">
                  {plan.channels.map((c) => {
                    const ok = done.find((d) => d.source === c.name);
                    return (
                      <li key={c.name} className="flex items-center gap-3 px-3 py-2">
                        <Checkbox aria-label={`#${c.name}`} checked={pick.has(c.name)} disabled={busy || done.length > 0 || !c.messages.length} onChange={() => toggle(c.name)} />
                        <span className="min-w-0 flex-1 truncate font-medium">#{c.name}</span>
                        <span className={cx("text-ink-2 text-xs tabular-nums", c.truncated && "text-warn")}>
                          {t("admin.slack.messages", { count: c.messages.length })}
                          {c.truncated ? ` · ${t("admin.slack.latest")}` : ""}
                        </span>
                        {ok ? (
                          <Link href={`/app/chat/${ok.channelId}`} className="text-xs">
                            {t("admin.slack.open")}
                          </Link>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
                {done.length ? (
                  <p role="status" className="bg-ok-wash text-ok m-0 rounded-lg px-3 py-2 font-medium">
                    {t("admin.slack.done", { count: done.length, messages: done.reduce((n, d) => n + d.imported, 0) })}
                  </p>
                ) : null}
              </>
            ) : null}
          </div>
        </Modal>
      ) : null}
    </>
  );
}
