"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client";
import { useT } from "@/lib/i18n/client";
import { btn, btnSm, cx, input } from "@/lib/ui";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { WorkCard } from "./WorkCard";
import type { WorkLink } from "./types";

/**
 * A task's linked work (the integrations hub): the pull and merge requests, issues and designs that belong
 * to it, as live cards. Links come from three places: someone pastes one here, its address is written in the
 * description or a comment, or (GitHub, GitLab) it names the task's code. The section takes no room in a workspace
 * that connected nothing and has no link on this task.
 */
export function LinkedWork({ taskId, className, headClass, titleClass }: { taskId: string; className?: string; headClass?: string; titleClass?: string }) {
  const t = useT();
  const [data, setData] = useState<{ links: WorkLink[]; connected: { id: string; name: string }[] } | null>(null);
  const [failed, setFailed] = useState(false);
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const load = useCallback(() => {
    setFailed(false);
    api<{ links: WorkLink[]; connected: { id: string; name: string }[] }>(`work/tasks/${taskId}/links`)
      .then(setData)
      .catch(() => setFailed(true));
  }, [taskId]);
  useEffect(load, [load]);

  if (failed)
    return (
      <section className={className}>
        <LoadFailed what={t("hub.linked.title")} onRetry={load} />
      </section>
    );
  // Nothing connected and nothing linked: the task page stays as it was.
  if (!data || (!data.links.length && !data.connected.length)) return null;
  const add = async () => {
    const value = url.trim();
    if (!value) return;
    setBusy("add");
    setError("");
    try {
      const link = await api<WorkLink>(`work/tasks/${taskId}/links`, { method: "POST", body: { url: value } });
      setData((d) => (d ? { ...d, links: [...d.links.filter((l) => l.id !== link.id), link] } : d));
      setUrl("");
    } catch (e) {
      setError(
        e instanceof Error && /no integration knows/.test(e.message) ? t("hub.linked.unknown", { list: data.connected.map((c) => c.name).join(", ") }) : t("hub.linked.addFailed"),
      );
    }
    setBusy("");
  };
  const act = async (l: WorkLink, what: "refresh" | "remove") => {
    setBusy(l.id);
    try {
      if (what === "remove") {
        await api(`work/tasks/${taskId}/links/${l.id}`, { method: "DELETE" });
        setData((d) => (d ? { ...d, links: d.links.filter((x) => x.id !== l.id) } : d));
      } else {
        const fresh = await api<WorkLink>(`work/tasks/${taskId}/links/${l.id}/refresh`, { method: "POST" });
        setData((d) => (d ? { ...d, links: d.links.map((x) => (x.id === l.id ? fresh : x)) } : d));
      }
    } catch {
      // The card stays as it was; the next look reads it again.
    }
    setBusy("");
  };
  return (
    <section className={className} aria-labelledby="linked-h">
      <header className={headClass}>
        <h2 id="linked-h" className={titleClass}>
          {t("hub.linked.title")}
        </h2>
        {data.links.length ? <span className="text-ink-2 text-xs tabular-nums">{data.links.length}</span> : null}
      </header>
      {data.links.length ? (
        <ul className="m-0 mb-2 grid list-none gap-2 p-0">
          {data.links.map((l) => (
            <WorkCard key={l.id} link={l} busy={busy === l.id} onRefresh={() => void act(l, "refresh")} onRemove={() => void act(l, "remove")} />
          ))}
        </ul>
      ) : null}
      {data.connected.length ? (
        <form
          className="flex min-w-0 items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <input
            className={cx(input, "h-9 min-w-0 flex-1 text-sm")}
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setError("");
            }}
            inputMode="url"
            placeholder={t("hub.linked.placeholder", { list: data.connected.map((c) => c.name).join(", ") })}
            aria-label={t("hub.linked.add")}
            aria-invalid={!!error}
          />
          <button type="submit" className={cx(btn, btnSm, "h-9 shrink-0")} disabled={busy === "add" || !url.trim()}>
            {t("hub.linked.addBtn")}
          </button>
        </form>
      ) : null}
      {error ? (
        <p className="text-block m-0 mt-1.5 text-xs" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
