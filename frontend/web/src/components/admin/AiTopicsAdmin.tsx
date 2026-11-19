"use client";

import { IconTile } from "@/components/ui/Bento";
import { ChartIcon } from "@/components/app/icons";
import { useState } from "react";
import { api } from "@/lib/client";
import { topicLabel } from "@/lib/ai-labels";
import { useT } from "@/lib/i18n/client";
import { btn, btnGhost, btnPrimary, btnSm, cx, input, tag } from "@/lib/ui";

export interface AiTopic {
  key: string;
  labelVi: string;
  labelEn: string;
  keywords: string[];
  builtin: boolean;
  archived: boolean;
}

const splitKeywords = (s: string) =>
  s
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 2);

/**
 * Admin › AI › Chủ đề: built-in topics can be relabelled and given extra keywords; the company adds its own
 * business topics (tried first by the keyword classifier, and offered to the company's model by the hourly batch).
 */
export function AiTopicsAdmin({ topics: initial }: { topics: AiTopic[] }) {
  const t = useT();
  const [topics, setTopics] = useState(initial);
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState({ labelVi: "", labelEn: "", keywords: "" });
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<{ topics: AiTopic[] }>) => {
    setBusy(true);
    try {
      setTopics((await fn()).topics);
      setEditing(null);
      setMsg({ text: t("aiInsights.topics.saved"), ok: true });
    } catch (e) {
      const exists = (e as { body?: { error?: string } }).body?.error === "topic_exists";
      setMsg({ text: t(exists ? "aiInsights.topics.exists" : "aiInsights.topics.failed"), ok: false });
    } finally {
      setBusy(false);
    }
  };
  const open = (x: AiTopic | null) => {
    setEditing(x ? x.key : "new");
    setForm({ labelVi: x?.labelVi ?? "", labelEn: x?.labelEn ?? "", keywords: x?.keywords.join(", ") ?? "" });
  };
  const body = (archived = false) => ({ labelVi: form.labelVi, labelEn: form.labelEn, keywords: splitKeywords(form.keywords), archived });
  const save = (x: AiTopic | null) =>
    run(() =>
      x ? api(`ai/insights/topics/${x.key}`, { method: "PUT", body: body(x.archived) }) : api<{ topics: AiTopic[] }>("ai/insights/topics", { method: "POST", body: body() }),
    );
  const archive = (x: AiTopic) =>
    run(() => api(`ai/insights/topics/${x.key}`, { method: "PUT", body: { labelVi: x.labelVi, labelEn: x.labelEn, keywords: x.keywords, archived: !x.archived } }));
  const reset = (x: AiTopic) => run(() => api(`ai/insights/topics/${x.key}`, { method: "DELETE" }));
  const editor = (x: AiTopic | null) => (
    <div className="grid gap-2 py-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="grid gap-1 text-xs font-medium">
          {t("aiInsights.topics.labelVi")}
          <input
            className={input}
            value={form.labelVi}
            maxLength={60}
            onChange={(e) => setForm({ ...form, labelVi: e.target.value })}
            placeholder={x?.builtin ? topicLabel(t, x.key) : ""}
          />
        </label>
        <label className="grid gap-1 text-xs font-medium">
          {t("aiInsights.topics.labelEn")}
          <input className={input} value={form.labelEn} maxLength={60} onChange={(e) => setForm({ ...form, labelEn: e.target.value })} />
        </label>
      </div>
      <label className="grid gap-1 text-xs font-medium">
        {t("aiInsights.topics.keywords")}
        <input className={input} value={form.keywords} onChange={(e) => setForm({ ...form, keywords: e.target.value })} data-testid="topic-keywords" />
        <span className="text-ink-2 font-normal">{t("aiInsights.topics.keywordsHint")}</span>
      </label>
      <div className="flex gap-2">
        <button type="button" className={cx(btnPrimary, btnSm)} disabled={busy || (!x && !form.labelVi.trim())} onClick={() => void save(x)}>
          {t("aiInsights.topics.save")}
        </button>
        <button type="button" className={cx(btnGhost, btnSm)} onClick={() => setEditing(null)}>
          {t("aiInsights.topics.cancel")}
        </button>
      </div>
    </div>
  );
  const row = (x: AiTopic) =>
    editing === x.key ? (
      <li key={x.key}>{editor(x)}</li>
    ) : (
      // The name and keywords keep one column and the buttons another, so on a phone the buttons never wrap onto a
      // line of their own and the keywords get a full line under the name instead of a few letters beside it.
      <li key={x.key} className={cx("flex items-center gap-2 py-2.5 text-sm", x.archived && "text-ink-2")}>
        <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="min-w-0 font-medium">{[x.labelVi, x.labelEn].filter(Boolean).join(" / ") || topicLabel(t, x.key)}</span>
          {x.archived ? <span className={tag}>{t("aiInsights.topics.archived")}</span> : null}
          <span className="text-ink-2 min-w-0 flex-1 truncate text-xs max-sm:basis-full">{x.keywords.length ? x.keywords.join(", ") : t("aiInsights.topics.noKeywords")}</span>
        </span>
        <span className="flex shrink-0 items-center">
          <button type="button" className={cx(btnGhost, btnSm)} onClick={() => open(x)}>
            {t("aiInsights.topics.edit")}
          </button>
          {x.builtin ? (
            x.labelVi || x.labelEn || x.keywords.length ? (
              <button type="button" className={cx(btnGhost, btnSm)} disabled={busy} onClick={() => void reset(x)}>
                {t("aiInsights.topics.reset")}
              </button>
            ) : null
          ) : (
            <button type="button" className={cx(btnGhost, btnSm)} disabled={busy} onClick={() => void archive(x)}>
              {t(x.archived ? "aiInsights.topics.unarchive" : "aiInsights.topics.archive")}
            </button>
          )}
        </span>
      </li>
    );
  const custom = topics.filter((x) => !x.builtin);
  return (
    <section className="grid grid-cols-1 gap-4" aria-labelledby="ai-topics-h" data-testid="ai-topics-admin">
      <div className="flex items-start justify-between gap-3">
        <div className="grid gap-1">
          <h2 id="ai-topics-h" className="m-0 flex min-w-0 items-center gap-3 text-sm/6 font-semibold tracking-[-0.01em]">
            <IconTile tone="sky">
              <ChartIcon />
            </IconTile>
            {t("aiInsights.topics.title")}
          </h2>
          <p className="text-ink-2 m-0 text-sm">{t("aiInsights.topics.sub")}</p>
        </div>
        <button type="button" className={cx(btn, btnSm, "shrink-0")} onClick={() => open(null)}>
          {t("aiInsights.topics.add")}
        </button>
      </div>
      <div className="bg-surface shadow-card rounded-xl px-4">
        {editing === "new" ? editor(null) : null}
        {custom.length ? (
          <>
            <p className="text-ink-2 m-0 pt-3 text-xs font-medium">{t("aiInsights.topics.custom")}</p>
            <ul className="divide-hairline m-0 grid list-none grid-cols-1 divide-y p-0">{custom.map(row)}</ul>
          </>
        ) : null}
        <p className="text-ink-2 m-0 pt-3 text-xs font-medium">{t("aiInsights.topics.builtin")}</p>
        <ul className="divide-hairline m-0 grid list-none grid-cols-1 divide-y p-0">{topics.filter((x) => x.builtin).map(row)}</ul>
      </div>
      {msg ? (
        <p className={cx("m-0 text-sm", msg.ok ? "text-ok" : "text-block")} role="status">
          {msg.text}
        </p>
      ) : null}
    </section>
  );
}
