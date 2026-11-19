"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client";
import { useT } from "@/lib/i18n/client";
import { cx } from "@/lib/ui";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { Empty } from "@/components/ui/bits";
import { WorkCard } from "./WorkCard";
import type { WorkLink } from "./types";

type Review = WorkLink & { task: { id: string; code: string; title: string; status: string } };
const FILTERS = ["open", "all"] as const;

/**
 * A project's pull and merge requests: every review linked to one of its tasks, the ones still open
 * first, each with the task it belongs to. For whoever leads the project: what is waiting for review, what is failing
 * its checks, what was merged, without opening the code host.
 */
export function ProjectReviews({ projectId }: { projectId: string }) {
  const t = useT();
  const [rows, setRows] = useState<Review[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("open");
  const load = useCallback(() => {
    setFailed(false);
    api<{ reviews: Review[] }>(`work/projects/${projectId}/reviews`)
      .then((r) => setRows(r.reviews))
      .catch(() => setFailed(true));
  }, [projectId]);
  useEffect(load, [load]);
  if (failed) return <LoadFailed what={t("hub.reviews.title")} onRetry={load} />;
  if (!rows)
    return (
      <div className="grid gap-2" aria-hidden="true">
        <span className="shimmer h-16 rounded-xl" />
        <span className="shimmer h-16 rounded-xl" />
      </div>
    );
  // One not read yet (its tool is not connected) may still be open: it counts as open rather than vanish.
  const open = rows.filter((r) => !r.card || r.card.state === "open" || r.card.state === "draft");
  const shown = filter === "open" ? open : rows;
  const failing = open.filter((r) => r.card?.checks === "failing").length;
  return (
    <section aria-label={t("hub.reviews.title")} className="grid min-w-0 gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <div role="tablist" aria-label={t("hub.reviews.title")} className="bg-hover flex gap-0.5 rounded-lg p-0.5">
          {FILTERS.map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={filter === k}
              onClick={() => setFilter(k)}
              className={cx("h-7 rounded-md px-2.5 text-xs font-medium tabular-nums", filter === k ? "bg-surface text-ink shadow-raised" : "text-ink-2 hover:text-ink")}
            >
              {t(`hub.reviews.${k}`)} <span className="text-ink-2 ml-0.5">{k === "open" ? open.length : rows.length}</span>
            </button>
          ))}
        </div>
        {failing ? <p className="text-block m-0 text-xs font-medium">{t("hub.reviews.failing", { n: failing })}</p> : null}
      </div>
      {shown.length ? (
        <ul className="m-0 grid list-none gap-2 p-0">
          {shown.map((r) => (
            <WorkCard
              key={r.id}
              link={r}
              task={
                <p className="text-ink-2 m-0 min-w-0 truncate text-xs">
                  <Link href={`/app/work/tasks/${r.task.code}`} className="text-ink-soft hover:text-ink font-medium no-underline hover:underline">
                    {r.task.code}
                  </Link>{" "}
                  {r.task.title}
                </p>
              }
            />
          ))}
        </ul>
      ) : (
        <Empty title={t(rows.length ? "hub.reviews.noneOpen" : "hub.reviews.none")}>{rows.length ? null : t("hub.reviews.noneHint")}</Empty>
      )}
    </section>
  );
}
