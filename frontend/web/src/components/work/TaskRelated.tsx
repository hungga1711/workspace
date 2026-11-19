"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client";
import { useFormat, useT } from "@/lib/i18n/client";
import { Avatar, useDirectory } from "@/lib/people";
import { cx, skeleton } from "@/lib/ui";
import { ChatIcon, CheckCircleIcon, FileIcon } from "@/components/app/icons";
import { LoadFailed } from "@/components/ui/LoadFailed";

export interface RelatedData {
  keywords: string[];
  docs: { id: string; code: string; title: string; why: "mentioned" | "project" | "search"; excerpt: string | null; updatedAt: string | null; url: string }[];
  similar: { id: string; code: string; title: string; assigneeId: string | null; completedAt: string | null; how: string | null; subtasks: number }[];
  messages: { id: string; channel: string; body: string; url: string; at: string }[];
  partial: boolean;
}

/** One read per task while the page is open: the chat's compact list and the full tab share it. */
const cache = new Map<string, Promise<RelatedData>>();
export function loadRelated(taskId: string, fresh = false): Promise<RelatedData> {
  if (fresh) cache.delete(taskId);
  let p = cache.get(taskId);
  if (!p) {
    p = api<RelatedData>(`work/tasks/${taskId}/related`);
    p.catch(() => cache.delete(taskId));
    cache.set(taskId, p);
  }
  return p;
}

/**
 * "Liên quan": documents, similar finished tasks (who did them and how) and messages that name the task,
 * found by full-text search on the server. No model: every company has it, with or without AI. `compact` is the short
 * list under an empty task chat. Loaded on demand with the tab, never with the task page.
 */
export function TaskRelated({ taskId, code, compact = false }: { taskId: string; code: string; compact?: boolean }) {
  const t = useT();
  const { dayLabel } = useFormat();
  const dir = useDirectory();
  const [data, setData] = useState<RelatedData | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(
    (fresh = false) => {
      setFailed(false);
      loadRelated(taskId, fresh).then(setData, () => setFailed(true));
    },
    [taskId],
  );
  useEffect(() => load(), [load]);

  if (failed) return <LoadFailed what={t("related.failed")} onRetry={() => load(true)} className={compact ? "text-xs" : "py-2"} />;
  if (!data)
    return (
      <div className="grid gap-3 py-2" aria-busy="true">
        {[0, 1, 2].map((i) => (
          <span key={i} className={cx(skeleton, i === 1 ? "w-3/5" : "w-4/5")} />
        ))}
      </div>
    );

  const docs = compact ? data.docs.slice(0, 3) : data.docs;
  const similar = compact ? data.similar.slice(0, 3) : data.similar;
  const messages = compact ? data.messages.slice(0, 2) : data.messages;
  const nothing = !docs.length && !similar.length && !messages.length;
  if (compact && nothing) return null;

  const head = (icon: React.ReactNode, title: string, n: number) => (
    <h3 className={cx("text-ink m-0 flex items-center gap-2 font-semibold", compact ? "text-xs" : "text-[13px]")}>
      <span className="text-ink-2 [&_svg]:size-3.5" aria-hidden="true">
        {icon}
      </span>
      {title}
      {!compact && n ? <span className="text-ink-2 font-normal tabular-nums">{n}</span> : null}
    </h3>
  );
  const rowCls = "hover:bg-hover -mx-2 grid min-w-0 gap-0.5 rounded-lg px-2 py-1.5 no-underline transition-colors";

  return (
    <div className={cx("grid min-w-0 grid-cols-[minmax(0,1fr)]", compact ? "gap-3" : "gap-5 pt-1")}>
      {compact ? <p className="text-ink-2 m-0 text-xs font-medium">{t("related.compactTitle")}</p> : <p className="text-ink-2 m-0 text-xs">{t("related.sub")}</p>}
      {nothing ? <p className="text-ink-2 m-0 py-2 text-sm">{data.partial ? t("related.partial") : t("related.none")}</p> : null}

      {nothing ? null : docs.length || !compact ? (
        <section className="grid min-w-0 gap-1">
          {head(<FileIcon />, t("related.docs"), data.docs.length)}
          {docs.length ? (
            <ul className="m-0 grid list-none gap-0.5 p-0">
              {docs.map((d) => (
                <li key={d.id} className="min-w-0">
                  <Link href={d.url} className={rowCls}>
                    <span className="text-ink truncate text-sm font-medium">{d.title}</span>
                    <span className="text-ink-2 truncate text-xs">
                      {t(`related.why.${d.why}`)}
                      {d.excerpt && !compact ? ` · ${d.excerpt}` : ""}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-ink-2 m-0 text-xs">{t("related.noneHere")}</p>
          )}
        </section>
      ) : null}

      {nothing ? null : similar.length || !compact ? (
        <section className="grid min-w-0 gap-1">
          {head(<CheckCircleIcon />, t("related.similar"), data.similar.length)}
          {similar.length ? (
            <ul className="m-0 grid list-none gap-0.5 p-0">
              {similar.map((s) => (
                <li key={s.id} className="min-w-0">
                  <Link href={`/app/work/tasks/${s.id}`} className={cx(rowCls, "grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2.5")}>
                    {s.assigneeId ? (
                      <Avatar id={s.assigneeId} size="xs" className="mt-0.5" />
                    ) : (
                      <span className="border-ink-2/50 mt-0.5 block size-5 rounded-full border border-dashed" />
                    )}
                    <span className="grid min-w-0 gap-0.5">
                      <span className="text-ink truncate text-sm font-medium">
                        <span className="text-ink-2 mr-1.5 font-mono text-xs font-normal">{s.code}</span>
                        {s.title}
                      </span>
                      <span className="text-ink-2 truncate text-xs">
                        {t("related.doneBy", { name: s.assigneeId ? dir.name(s.assigneeId) : t("related.nobody"), date: s.completedAt ? dayLabel(s.completedAt) : "—" })}
                        {s.subtasks ? ` · ${t("related.subtasks", { count: s.subtasks })}` : ""}
                      </span>
                      {s.how && !compact ? <span className="text-ink-soft line-clamp-2 text-xs">{s.how}</span> : null}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-ink-2 m-0 text-xs">{t("related.noneHere")}</p>
          )}
        </section>
      ) : null}

      {nothing ? null : messages.length || !compact ? (
        <section className="grid min-w-0 gap-1">
          {head(<ChatIcon />, t("related.messages", { code }), data.messages.length)}
          {messages.length ? (
            <ul className="m-0 grid list-none gap-0.5 p-0">
              {messages.map((m) => (
                <li key={m.id} className="min-w-0">
                  <Link href={m.url} className={rowCls}>
                    <span className="text-ink line-clamp-2 text-sm">{m.body}</span>
                    <span className="text-ink-2 truncate text-xs">
                      {m.channel ? `#${m.channel.replace(/^#/, "")} · ` : ""}
                      {m.at ? dayLabel(m.at) : ""}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-ink-2 m-0 text-xs">{data.partial ? t("related.partial") : t("related.noneHere")}</p>
          )}
        </section>
      ) : null}
    </div>
  );
}

export default TaskRelated;
