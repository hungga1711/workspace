"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { topicLabel, topicLabels } from "@/lib/ai-labels";
import { useFormat, useT } from "@/lib/i18n/client";
import { btn, btnPrimary, btnSm, cx, input, textarea } from "@/lib/ui";
import { Modal } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";

export interface TopicRow {
  key: string;
  labelVi: string;
  labelEn: string;
  builtin: boolean;
  archived: boolean;
}

interface Draft {
  title: string;
  topic: string;
  prompts: string[];
}

/**
 * The share dialog: the conversation's prompts as the server redacted them (built-in kinds and the company's
 * keywords), one picked and editable, a title and a topic. The server redacts again on save.
 */
export function SharePromptDialog({ conversationId, onClose }: { conversationId: string; onClose: () => void }) {
  const t = useT();
  const { locale } = useFormat();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [topics, setTopics] = useState<TopicRow[]>([]);
  const [pick, setPick] = useState(0);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [topic, setTopic] = useState("other");
  const [visibility, setVisibility] = useState<"private" | "department" | "everyone">("everyone");
  const [state, setState] = useState<"loading" | "ready" | "saving" | "done" | "error">("loading");
  useEffect(() => {
    let live = true;
    Promise.all([api<Draft>(`ai/insights/library/draft/${conversationId}`), api<{ topics: TopicRow[] }>("ai/insights/topics").catch(() => ({ topics: [] as TopicRow[] }))])
      .then(([d, tp]) => {
        if (!live) return;
        setDraft(d);
        setTopics(tp.topics.filter((x) => !x.archived));
        setTitle(d.title);
        setBody(d.prompts[0] ?? "");
        setTopic(d.topic);
        setState("ready");
      })
      .catch(() => live && setState("error"));
    return () => {
      live = false;
    };
  }, [conversationId]);
  const labels = topicLabels(topics, locale);
  const submit = async () => {
    setState("saving");
    try {
      await api("ai/insights/library", { method: "POST", body: { conversationId, title, body, topic, visibility } });
      setState("done");
    } catch {
      setState("error");
    }
  };
  const footer =
    state === "done" ? (
      <>
        <button type="button" className={cx(btn, btnSm)} onClick={onClose}>
          {t("common.close")}
        </button>
        <Link href="/app/ai/adoption/library" className={cx(btnPrimary, btnSm, "no-underline")}>
          {t("aiInsights.share.open")}
        </Link>
      </>
    ) : (
      <>
        <button type="button" className={cx(btn, btnSm)} onClick={onClose}>
          {t("aiInsights.share.cancel")}
        </button>
        <button
          type="button"
          className={cx(btnPrimary, btnSm)}
          disabled={!draft || state === "loading" || state === "saving" || !title.trim() || !body.trim()}
          onClick={() => void submit()}
          data-testid="share-prompt-submit"
        >
          {t("aiInsights.share.submit")}
        </button>
      </>
    );
  return (
    <Modal title={t("aiInsights.share.title")} onClose={onClose} footer={footer} wide>
      {state === "loading" ? (
        <p className="text-ink-2 m-0 text-sm">{t("aiInsights.share.loading")}</p>
      ) : state === "done" ? (
        <p className="text-ok m-0 text-sm" role="status">
          {t("aiInsights.share.done")}
        </p>
      ) : !draft || !draft.prompts.length ? (
        <p className={cx("m-0 text-sm", state === "error" ? "text-block" : "text-ink-2")}>{t(state === "error" ? "aiInsights.share.failed" : "aiInsights.share.empty")}</p>
      ) : (
        <div className="grid gap-3">
          <p className="text-ink-2 m-0 text-sm">{t("aiInsights.share.lead")}</p>
          {draft.prompts.length > 1 ? (
            <label className="grid gap-1 text-sm font-medium">
              {t("aiInsights.share.pick")}
              <select
                className={cx(input, "h-9 py-0")}
                value={pick}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  setPick(n);
                  setBody(draft.prompts[n] ?? "");
                }}
              >
                {draft.prompts.map((p, i) => (
                  <option key={i} value={i}>
                    {`${t("aiInsights.share.pickItem", { n: i + 1 })}: ${p.slice(0, 60)}`}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="grid gap-1 text-sm font-medium">
            {t("aiInsights.share.titleLabel")}
            <input className={input} value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="grid gap-1 text-sm font-medium">
            {t("aiInsights.share.body")}
            <textarea className={cx(textarea, "min-h-40 font-normal")} value={body} maxLength={8000} onChange={(e) => setBody(e.target.value)} data-testid="share-prompt-body" />
          </label>
          <label className="grid gap-1 text-sm font-medium">
            {t("aiInsights.share.topic")}
            <select className={cx(input, "h-9 py-0")} value={topic} onChange={(e) => setTopic(e.target.value)}>
              {(topics.length ? topics : [{ key: topic, labelVi: "", labelEn: "", builtin: true, archived: false }]).map((x) => (
                <option key={x.key} value={x.key}>
                  {topicLabel(t, x.key, labels)}
                </option>
              ))}
            </select>
          </label>
          <div className="grid gap-1 text-sm font-medium">
            {t("aiInsights.library.visLabel")}
            <Segmented
              label={t("aiInsights.library.visLabel")}
              value={visibility}
              onChange={setVisibility}
              options={(["everyone", "department", "private"] as const).map((v) => ({ value: v, label: t(`aiInsights.library.vis.${v}`) }))}
            />
            <span className="text-ink-2 text-xs font-normal">{t(`aiInsights.library.visHint.${visibility}`)}</span>
          </div>
          {state === "error" ? <p className="text-block m-0 text-sm">{t("aiInsights.share.failed")}</p> : null}
        </div>
      )}
    </Modal>
  );
}
