"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { useT } from "@/lib/i18n/client";
import { Menu, type MenuItem } from "@/components/ui/Menu";
import { ChevronDownIcon, ListIcon, SparkleIcon } from "@/components/app/icons";
import { btnGhost, btnSm, cx } from "@/lib/ui";
import type { WriteMode } from "@/lib/task-write";

// The suggestion panel (request, diff, apply) loads on the first pick: the task page and the new-task window only
// carry this menu.
const TaskWritePanel = dynamic(() => import("./TaskWritePanel"), {
  ssr: false,
  loading: () => <div className="bg-surface shadow-card h-24 animate-pulse rounded-xl" aria-hidden="true" />,
});

export interface TaskWriteProps {
  /** Company AI usable: without it only the template is offered. */
  ai: boolean;
  title: string;
  description: string;
  /** The task being edited (id), absent in the new-task window. */
  taskRef?: string;
  projectId?: string | null;
  labels?: string[];
  /** Applies a proposal or the template; resolves true when it took (the host saves and offers undo). */
  onApply: (patch: { title?: string; description?: string }) => Promise<boolean>;
  /** Inserts the description template (no AI). */
  onTemplate: () => void;
  className?: string;
  /** Phones: the menu shows its mark only (the new-task window's header is one tight row). */
  compact?: boolean;
}

/**
 * "AI viết" next to a task's description: the menu (draft, improve, shorter, more detail, acceptance criteria,
 * checklist, something else, and the non-AI template) and the place its suggestion panel opens. Returns both so the
 * host puts the menu in its header and the panel above the text. Without company AI the menu is just "Mẫu mô tả".
 */
export function useTaskWrite(p: TaskWriteProps): { menu: React.ReactNode; panel: React.ReactNode } {
  const tx = useT();
  // `run` changes on every pick, so picking the same action again asks again.
  const [job, setJob] = useState<{ mode: WriteMode; run: number } | null>(null);
  const pick = (mode: WriteMode) => setJob((j) => ({ mode, run: (j?.run ?? 0) + 1 }));
  const hasText = !!p.description.trim();

  if (!p.ai) {
    return {
      menu: (
        <button type="button" className={cx(btnGhost, btnSm, "text-ink-2", p.className)} onClick={p.onTemplate} title={tx("work.taskwrite.template")}>
          <ListIcon />
          <span className={cx(p.compact && "max-sm:sr-only")}>{tx("work.taskwrite.templateShort")}</span>
        </button>
      ),
      panel: null,
    };
  }
  const items: MenuItem[] = [
    { label: tx("work.taskwrite.draft"), onSelect: () => pick("draft"), icon: <SparkleIcon className="size-4" /> },
    { label: tx("work.taskwrite.improve"), onSelect: () => pick("improve"), icon: <SparkleIcon className="size-4" /> },
    ...(hasText
      ? (["shorter", "longer", "criteria", "checklist"] as const).map((m) => ({
          label: tx(`work.taskwrite.${m}`),
          onSelect: () => pick(m),
          icon: <SparkleIcon className="size-4" />,
        }))
      : []),
    { label: tx("work.taskwrite.custom"), onSelect: () => pick("custom"), icon: <SparkleIcon className="size-4" /> },
    { label: tx("work.taskwrite.template"), onSelect: p.onTemplate, icon: <ListIcon className="size-4" /> },
  ];
  return {
    menu: (
      <div className={p.className}>
        <Menu
          align="right"
          label={tx("work.taskwrite.menu")}
          items={items}
          trigger={
            <span className={cx(btnGhost, btnSm, "text-ink-2 hover:text-ink", job && "text-ink")} data-testid="task-write-menu">
              <SparkleIcon />
              <span className={cx(p.compact && "max-sm:sr-only")}>{tx("work.taskwrite.trigger")}</span>
              <ChevronDownIcon className="text-ink-2" />
            </span>
          }
        />
      </div>
    ),
    panel: job ? (
      <TaskWritePanel
        key={job.run}
        mode={job.mode}
        title={p.title}
        description={p.description}
        taskRef={p.taskRef}
        projectId={p.projectId}
        labels={p.labels}
        onApply={p.onApply}
        onClose={() => setJob(null)}
      />
    ) : null,
  };
}
