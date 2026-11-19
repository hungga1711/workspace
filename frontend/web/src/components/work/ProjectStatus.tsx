"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client";
import { useAiEnabled } from "@/lib/ai-context";
import { useFormat, useT } from "@/lib/i18n/client";
import { LOCALE_NAME } from "@/lib/i18n/config";
import { Avatar, useDirectory } from "@/lib/people";
import { btn, btnPrimary, btnSm, card, cx, textarea } from "@/lib/ui";
import { useToast } from "@/components/ui/Toast";
import type { VelocityData } from "./Velocity";

/*
 * A project's weekly status (backend work/project-updates.ts): whoever leads it writes two lines and a health call,
 * the boss reads the latest on the projects page and the history here. It replaces per-task progress check-ins. The AI
 * can draft it from the week's numbers when the company has an AI connection; without one it is a plain form.
 */

export type UpdateHealthValue = "on_track" | "at_risk" | "off_track";

export interface ProjectUpdate {
  id: string;
  projectId: string;
  authorId: string;
  health: UpdateHealthValue;
  body: string;
  suggested: boolean;
  at: string;
}

const HEALTH_TONE: Record<UpdateHealthValue, string> = {
  on_track: "bg-ok-wash text-ok",
  at_risk: "bg-warn-wash text-warn",
  off_track: "bg-block-wash text-block",
};

export function UpdateHealth({ health, className }: { health: UpdateHealthValue; className?: string }) {
  const t = useT();
  return (
    <span className={cx("inline-flex h-5 items-center whitespace-nowrap rounded-md px-1.5 text-xs font-medium", HEALTH_TONE[health], className)}>
      {t(`projectOverview.health.${health}`)}
    </span>
  );
}

export function ProjectStatus({ projectId, projectName, flow }: { projectId: string; projectName: string; flow: VelocityData | null }) {
  const t = useT();
  const { ago, locale } = useFormat();
  const dir = useDirectory();
  const toast = useToast();
  const ai = useAiEnabled();
  const [data, setData] = useState<{ updates: ProjectUpdate[]; canPost: boolean } | null>(null);
  const [failed, setFailed] = useState(false);
  const [health, setHealth] = useState<UpdateHealthValue>("on_track");
  const [body, setBody] = useState("");
  const [suggested, setSuggested] = useState(false);
  const [busy, setBusy] = useState<"post" | "suggest" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setFailed(false);
    api<{ updates: ProjectUpdate[]; canPost: boolean }>(`work/projects/${projectId}/updates`).then(setData, () => setFailed(true));
  }, [projectId]);
  useEffect(load, [load]);

  const post = async () => {
    if (!body.trim()) return;
    setBusy("post");
    setError(null);
    try {
      const u = await api<ProjectUpdate>(`work/projects/${projectId}/updates`, { method: "POST", body: { health, body: body.trim(), suggested } });
      setData((d) => (d ? { ...d, updates: [u, ...d.updates] } : d));
      setBody("");
      setSuggested(false);
      toast({ message: t("projectOverview.posted") });
    } catch {
      setError(t("projectOverview.postFailed"));
    } finally {
      setBusy(null);
    }
  };

  const suggest = async () => {
    if (!flow) return;
    setBusy("suggest");
    setError(null);
    const list = (xs: { code: string; title: string }[]) => (xs.length ? xs.map((x) => `${x.code} ${x.title}`).join("; ") : "–");
    try {
      const r = await api<{ answer: string }>("ai/ask", {
        method: "POST",
        body: {
          question: t("projectOverview.suggestPrompt", {
            name: projectName,
            done: flow.thisWeek.done,
            added: flow.thisWeek.added,
            inProgress: flow.now.inProgress + flow.now.review,
            stuck: flow.now.stuck,
            stuckDays: flow.stuckDays,
            overdue: flow.now.overdue,
            finished: list(flow.finished),
            risks: list(flow.attention),
            language: LOCALE_NAME[locale],
          }).slice(0, 3900),
        },
      });
      const text = r.answer.trim();
      if (!text) throw new Error("empty");
      setBody(text.slice(0, 2000));
      setSuggested(true);
      // A first guess at the health call from the numbers; the person changes it if they know better.
      setHealth(flow.now.overdue > 2 || flow.now.stuck > 2 ? "at_risk" : "on_track");
    } catch {
      setError(t("projectOverview.suggestFailed"));
    } finally {
      setBusy(null);
    }
  };

  const latest = data?.updates[0] ?? null;
  const earlier = data?.updates.slice(1) ?? [];

  return (
    <section className={cx(card, "grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4 p-5 max-sm:p-4")} aria-busy={!data && !failed}>
      <h2 className="text-ink m-0 text-[15px] font-semibold">{t("projectOverview.statusTitle")}</h2>
      {failed ? (
        <div className="text-ink-2 flex flex-wrap items-center gap-3 text-sm">
          {t("common.loadFailed")}
          <button type="button" className={cx(btn, btnSm)} onClick={load}>
            {t("common.retry")}
          </button>
        </div>
      ) : !data ? (
        <span className="bg-hover h-16 animate-pulse rounded-lg" aria-hidden="true" />
      ) : (
        <>
          {latest ? (
            <UpdateItem u={latest} name={dir.name(latest.authorId)} when={ago(latest.at)} large />
          ) : (
            <p className="text-ink-2 m-0 text-sm">{t("projectOverview.statusEmpty")}</p>
          )}
          {data.canPost ? (
            <form
              className="border-hairline grid gap-3 border-t pt-4"
              onSubmit={(e) => {
                e.preventDefault();
                void post();
              }}
            >
              <label htmlFor={`status-${projectId}`} className="text-ink-2 text-[13px]">
                {t("projectOverview.statusPrompt")}
              </label>
              <textarea
                id={`status-${projectId}`}
                className={cx(textarea, "min-h-20")}
                value={body}
                maxLength={2000}
                placeholder={t("projectOverview.statusPlaceholder")}
                onChange={(e) => {
                  setBody(e.target.value);
                  if (!e.target.value) setSuggested(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void post();
                  }
                }}
              />
              <div className="flex flex-wrap items-center gap-2">
                <fieldset className="m-0 flex flex-wrap items-center gap-1 border-0 p-0">
                  <legend className="sr-only">{t("projectOverview.healthLabel")}</legend>
                  {(["on_track", "at_risk", "off_track"] as const).map((h) => (
                    <label
                      key={h}
                      className={cx(
                        "has-[:focus-visible]:outline-accent inline-flex h-7 cursor-pointer items-center rounded-md px-2 text-[13px] font-medium has-[:focus-visible]:outline-2",
                        health === h ? HEALTH_TONE[h] : "text-ink-2 hover:bg-hover",
                      )}
                    >
                      <input type="radio" name={`health-${projectId}`} value={h} checked={health === h} onChange={() => setHealth(h)} className="sr-only" />
                      {t(`projectOverview.health.${h}`)}
                    </label>
                  ))}
                </fieldset>
                <span className="flex-1" />
                {ai && flow ? (
                  <button type="button" className={cx(btn, btnSm)} onClick={() => void suggest()} disabled={busy !== null}>
                    {busy === "suggest" ? t("projectOverview.suggesting") : t("projectOverview.suggest")}
                  </button>
                ) : null}
                <button type="submit" className={cx(btnPrimary, btnSm)} disabled={busy !== null || !body.trim()}>
                  {busy === "post" ? t("projectOverview.posting") : t("projectOverview.post")}
                </button>
              </div>
              {suggested ? <p className="text-ink-soft m-0 text-xs">{t("projectOverview.aiDrafted")}</p> : null}
              {error ? (
                <p className="text-block m-0 text-sm" role="alert">
                  {error}
                </p>
              ) : null}
            </form>
          ) : null}
          {earlier.length ? (
            <details className="border-hairline group border-t pt-3">
              <summary className="text-ink-2 hover:text-ink cursor-pointer text-[13px] font-medium">{t("projectOverview.history")}</summary>
              <ul className="m-0 mt-3 grid list-none gap-4 p-0">
                {earlier.map((u) => (
                  <li key={u.id}>
                    <UpdateItem u={u} name={dir.name(u.authorId)} when={ago(u.at)} />
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      )}
    </section>
  );
}

function UpdateItem({ u, name, when, large = false }: { u: ProjectUpdate; name: string; when: string; large?: boolean }) {
  const t = useT();
  return (
    <div className="flex min-w-0 gap-3">
      <Avatar id={u.authorId} size="sm" />
      <div className="grid min-w-0 gap-1">
        <span className="text-ink-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <span>{t("projectOverview.by", { name, when })}</span>
          <UpdateHealth health={u.health} />
          {u.suggested ? <span className="text-ink-soft">{t("projectOverview.aiDrafted")}</span> : null}
        </span>
        <p className={cx("text-ink m-0 whitespace-pre-line", large ? "text-[15px]" : "text-sm")}>{u.body}</p>
      </div>
    </div>
  );
}
