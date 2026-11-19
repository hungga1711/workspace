"use client";

import Link from "next/link";
import { useT } from "@/lib/i18n/client";
import { btn, btnPrimary, cx } from "@/lib/ui";
import { Modal } from "@/components/ui/Modal";
import { CategoryTile, StepNode } from "../bits";
import { useKindLabel } from "../Graph";
import { plainText } from "../plain";
import type { RunnerInfo, WorkflowTemplate } from "../types";
import { HarnessFacts } from "./HarnessFacts";
import { Missing } from "./cards";
import { configOf, missingFor, type LibraryKey } from "./shared";

/**
 * A template before it is used: what it does, its harness in five rows, what it asks at Run, every step, and what to
 * put in the task. Loaded on demand (WorkflowsView), so the gallery's page does not carry it.
 */
export default function TemplatePreview({ x, aiOn, runners, onClose }: { x: WorkflowTemplate; aiOn: boolean; runners: RunnerInfo[]; onClose: () => void }) {
  const t = useT();
  const kind = useKindLabel();
  const c = configOf(x);
  const missing = missingFor(c, aiOn, runners);
  const k = (key: LibraryKey) => t(`workflows.library.${key}`);
  return (
    <Modal
      wide
      title={k("templateTitle")}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btn} onClick={onClose}>
            {t("common.close")}
          </button>
          <Link href={`/app/ai/workflows/new?template=${encodeURIComponent(x.key)}`} className={cx(btnPrimary, "no-underline")}>
            {t("workflows.useTemplate")}
          </Link>
        </>
      }
    >
      <div className="grid min-w-0 gap-5">
        <div className="flex min-w-0 items-start gap-3">
          <CategoryTile category={x.category} />
          <div className="min-w-0 flex-1">
            <p className="text-ink-2 m-0 text-xs">{t(`workflows.category.${x.category}`)}</p>
            <h3 className="text-ink m-0 text-base font-semibold tracking-[-0.01em]">{x.name}</h3>
            <p className="text-ink-soft m-0 mt-1 text-[13px]">{plainText(x.description)}</p>
          </div>
        </div>

        {missing ? (
          <p className="bg-warn-wash ring-warn/20 m-0 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-3 py-2 ring-1 ring-inset">
            <Missing what={missing} className="flex-1 basis-48 text-[13px]" />
            <Link href={missing === "ai" ? "/admin/workspace/ai" : "/app/ai/connect"} className="text-ink text-[13px] font-medium underline underline-offset-2">
              {k(missing === "ai" ? "connectAi" : "connectComputer")}
            </Link>
          </p>
        ) : null}

        <HarnessFacts config={c} steps={x.steps} />

        {c.inputs.length ? (
          <section className="grid gap-2">
            <h4 className="text-ink m-0 text-[13px] font-semibold">{k("asksAtRun")}</h4>
            <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
              {c.inputs.map((i) => (
                <li key={i.key} className="bg-ground ring-hairline text-ink-soft inline-flex h-6 items-center gap-1 rounded-md px-2 text-xs ring-1 ring-inset">
                  {i.label}
                  {i.required ? (
                    <span className="text-block" title={k("required")}>
                      *<span className="sr-only">{k("required")}</span>
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="grid gap-2">
          <h4 className="text-ink m-0 text-[13px] font-semibold">{t("workflows.steps")}</h4>
          <ol className="m-0 grid list-none p-0">
            {x.steps.map((s, i) => (
              <li key={s.key || i} className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-3">
                <span className="flex flex-col items-center">
                  <StepNode kind={s.kind} size="sm" />
                  {i < x.steps.length - 1 ? <span aria-hidden="true" className="bg-edge my-0.5 w-px flex-1" /> : null}
                </span>
                <div className="min-w-0 pb-3 leading-[1.35]">
                  <p className="m-0 flex min-w-0 flex-wrap items-baseline gap-x-2">
                    <span className="text-ink text-sm font-medium">{s.title}</span>
                    <span className="text-ink-2 text-xs">{s.kind === "check" ? t("workflows.kind.check") : kind(s, x.runner)}</span>
                  </p>
                  {s.kind === "ai" && s.role ? <p className="text-ink-2 m-0 line-clamp-1 text-xs">{plainText(s.role)}</p> : null}
                  {s.kind === "check" && s.criteria ? <p className="text-ink-2 m-0 line-clamp-2 text-xs">{plainText(s.criteria)}</p> : null}
                  {(s.kind === "command" || s.kind === "check") && s.command ? <p className="text-ink-2 m-0 truncate font-mono text-xs">{s.command}</p> : null}
                </div>
              </li>
            ))}
          </ol>
        </section>

        {x.uses?.length ? (
          <section className="grid gap-2">
            <h4 className="text-ink m-0 text-[13px] font-semibold">{k("goodFor")}</h4>
            <ul className="text-ink-soft m-0 grid list-disc gap-1 pl-5 text-[13px]">
              {x.uses.map((u, i) => (
                <li key={i}>{u}</li>
              ))}
            </ul>
          </section>
        ) : null}
        <p className="text-ink-2 m-0 text-xs">{t("workflows.templatesSub")}</p>
      </div>
    </Modal>
  );
}
