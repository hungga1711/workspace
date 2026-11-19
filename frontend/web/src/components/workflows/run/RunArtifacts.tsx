"use client";

import Link from "next/link";
import { api } from "@/lib/client";
import { useT } from "@/lib/i18n/client";
import { cx } from "@/lib/ui";
import { useToast } from "@/components/ui/Toast";
import { ChatIcon, ChecklistIcon, DownloadIcon, FileIcon } from "@/components/app/icons";
import type { Run } from "../types";
import { fileSize } from "./helpers";

const chip =
  "bg-surface ring-hairline text-ink inline-flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-full px-2.5 text-xs font-medium ring-1 ring-inset [&_svg]:size-3.5 [&_svg]:shrink-0";

/**
 * What a finished run handed over: the result as a comment, the page it saved, the files it attached to the task
 * (each downloads like any attachment) and how many subtasks it created.
 */
export function RunArtifacts({ run, className }: { run: Pick<Run, "status" | "artifacts" | "config">; className?: string }) {
  const t = useT();
  const toast = useToast();
  if (run.status !== "done") return null;
  const list = run.artifacts ?? [];
  // A run from before outputs were configurable always posted its result as a comment.
  const comment = run.config ? run.config.output.comment : true;
  if (!list.length && !comment) return null;
  const download = async (id: string) => {
    const r = await api<{ url: string }>(`work/files/${id}/download`).catch(() => null);
    if (r?.url) window.location.assign(r.url);
    else toast({ message: t("common.actionFailed") });
  };
  return (
    <section aria-label={t("workflows.run.delivered.title")} className={cx("flex min-w-0 flex-wrap items-center gap-1.5", className)}>
      <h3 className="text-ink-2 m-0 mr-1 text-xs font-medium">{t("workflows.run.delivered.title")}</h3>
      {comment ? (
        <span className={cx(chip, "text-ink-soft font-normal")}>
          <ChatIcon />
          <span className="truncate">{t("workflows.run.delivered.comment")}</span>
        </span>
      ) : null}
      {list.map((a, i) =>
        a.kind === "doc" && a.id ? (
          <Link key={i} href={`/app/work/docs/${a.id}`} className={cx(chip, "hover:bg-hover no-underline")} title={a.name}>
            <FileIcon />
            <span className="text-ink-2 font-normal">{t("workflows.run.delivered.doc")}</span>
            <span className="truncate">{a.name}</span>
          </Link>
        ) : a.kind === "file" && a.id ? (
          <button key={i} type="button" className={cx(chip, "hover:bg-hover")} title={t("workflows.run.delivered.download", { name: a.name })} onClick={() => void download(a.id!)}>
            <DownloadIcon />
            <span className="truncate">{a.name}</span>
            {a.size ? <span className="text-ink-2 shrink-0 font-normal tabular-nums">{fileSize(a.size)}</span> : null}
          </button>
        ) : a.kind === "subtasks" ? (
          <span key={i} className={cx(chip, "text-ink-soft font-normal")}>
            <ChecklistIcon />
            {t("workflows.run.delivered.subtasks", { count: a.count ?? 0 })}
          </span>
        ) : null,
      )}
    </section>
  );
}
