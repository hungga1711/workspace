"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/client";
import { useT } from "@/lib/i18n/client";
import { btn, btnPrimary, cx } from "@/lib/ui";
import { CheckIcon, ChevronLeftIcon, InfoIcon } from "@/components/app/icons";
import { useConfirm } from "@/components/ui/Confirm";
import { Modal } from "@/components/ui/Modal";
import { Picker } from "@/components/ui/Picker";
import { CATEGORY } from "../bits";
import { analyze, type Finding, type Section } from "../analyze";
import { CATEGORIES, type Category, type ModelCatalog, type Prompting, type RunnerInfo, type Workflow } from "../types";
import { runnerOf, saveBody, SECTIONS, type Draft } from "./draft";
import { EnvironmentSection } from "./EnvironmentSection";
import { FindingList, HarnessSummary } from "./Harness";
import { ResourcesSection } from "./ResourcesSection";
import { GuardrailsSection, InputsSection, OutputSection, OverviewSection } from "./sections";
import { StartSection } from "./StartSection";
import { StepsSection } from "./StepsSection";

const LIBRARY = "/app/ai/workflows";

/**
 * The workflow studio: a workflow edited as the harness it is. A bar with the name, the department and
 * Save; seven sections in reading order (what it is for, what it asks, where it runs, what it reads, the steps, its
 * limits, what it delivers); and Preflight, which reads the harness back in plain words and lists what would go wrong
 * before anyone presses Run. Wide screens show the sections as a rail and Preflight beside the page; narrower ones a
 * chip row, with the readiness chip opening Preflight as a sheet.
 */
export function Studio({
  initial,
  catalog,
  prompting,
  runners,
}: {
  initial: Draft;
  /** The models to pick from; null when they could not be read (steps keep the company's default). */
  catalog: ModelCatalog | null;
  prompting: Prompting | null;
  /** The runners seen lately; null when they could not be read (nothing is said about them). */
  runners: RunnerInfo[] | null;
}) {
  const t = useT();
  const router = useRouter();
  const { confirm, dialog } = useConfirm();
  const [d, setD] = useState<Draft>(initial);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openStep, setOpenStep] = useState<number | null>(null);
  const [active, setActive] = useState<Section>("overview");
  const [sheet, setSheet] = useState(false);
  const saved = useRef(false);
  const set = (fn: (d: Draft) => Draft) => {
    setD(fn);
    setDirty(true);
    // What the server refused is about the draft as it was: gone once it changes.
    setError(null);
  };

  const runner = runnerOf(d.config.environment);
  const a = useMemo(() => analyze(d.steps, runner, catalog, { config: d.config, runners }), [d.steps, d.config, runner, catalog, runners]);
  const errors = a.summary.errors;

  // Leaving with unsaved changes: the browser asks on close or reload; the page's own ways out ask below.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty && !saved.current) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const leave = async (href: string) => {
    if (dirty && !(await confirm({ title: t("workflows.studio.leaveTitle"), body: t("workflows.studio.leaveBody"), confirmLabel: t("workflows.studio.leaveConfirm") }))) return;
    saved.current = true;
    router.push(href);
  };

  // The rail follows the section in view.
  const chosenUntil = useRef(0);
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        // A section just chosen in the rail stays the one shown: the last ones are too short to reach the top.
        if (Date.now() < chosenUntil.current) return;
        const top = entries.filter((e) => e.isIntersecting).sort((x, y) => x.boundingClientRect.top - y.boundingClientRect.top)[0];
        if (top) setActive(top.target.id.replace("studio-", "") as Section);
      },
      { rootMargin: "-20% 0px -65% 0px" },
    );
    for (const s of SECTIONS) {
      const el = document.getElementById(`studio-${s}`);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, []);

  const go = (s: Section, step?: number | null) => {
    setSheet(false);
    if (typeof step === "number") setOpenStep(step);
    chosenUntil.current = Date.now() + 1200;
    setActive(s);
    requestAnimationFrame(() => {
      const el = (typeof step === "number" && document.getElementById(`studio-step-${step}`)) || document.getElementById(`studio-${s}`);
      el?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    });
  };
  const pickFinding = (x: Finding) => go(x.section, x.step);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const w = await api<Workflow>(d.id ? `work/workflows/${d.id}` : "work/workflows", { method: d.id ? "PUT" : "POST", body: saveBody(d) });
      saved.current = true;
      router.push(`${LIBRARY}/${w.id}`);
      router.refresh();
    } catch (e) {
      setError((e as { body?: { message?: string } }).body?.message ?? t("workflows.editor.saveFailed"));
      setBusy(false);
    }
  };

  const issue = (s: Section) => {
    const list = a.findings.filter((x) => x.section === s);
    return list.some((x) => x.severity === "error") ? "error" : list.some((x) => x.severity === "warn") ? "warn" : null;
  };
  const filled: Record<Section, boolean> = {
    overview: !!d.description.trim(),
    inputs: d.config.inputs.length > 0,
    environment: true,
    resources: !!d.config.resources.notes.trim() || d.config.resources.docs.length + d.config.resources.files.length + d.config.resources.links.length > 0,
    steps: d.steps.length > 0,
    guardrails: true,
    output: true,
    start: true,
  };
  const dot = (s: Section) => {
    const i = issue(s);
    return (
      <span
        aria-hidden="true"
        className={cx("size-1.5 shrink-0 rounded-full", i === "error" ? "bg-block" : i === "warn" ? "bg-warn-fill" : filled[s] ? "bg-ok-fill" : "bg-edge")}
      />
    );
  };

  const ready = (
    <span
      className={cx(
        "inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 text-xs font-medium tabular-nums [&_svg]:size-3.5",
        errors ? "bg-block-wash text-block" : a.summary.warnings ? "bg-warn-wash text-warn" : "bg-ok-wash text-ok",
      )}
    >
      {errors || a.summary.warnings ? <InfoIcon /> : <CheckIcon />}
      {errors ? t("workflows.studio.blocked", { count: errors }) : a.summary.warnings ? t("workflows.studio.warnings", { count: a.summary.warnings }) : t("workflows.studio.ready")}
    </span>
  );
  const preflight = (
    <div className="grid min-w-0 gap-3">
      <HarnessSummary config={d.config} analysis={a} onPick={(s) => go(s)} />
      {a.findings.length ? (
        <FindingList findings={a.findings} steps={d.steps} onPick={pickFinding} />
      ) : (
        <p className="bg-ok-wash text-ok m-0 flex items-center gap-2 rounded-lg px-2.5 py-2 text-[13px]">
          <CheckIcon className="size-3.5 shrink-0" />
          {t("workflows.studio.nothingToCheck")}
        </p>
      )}
    </div>
  );

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4">
      <header className="bg-ground/95 border-divider sticky top-14 z-20 -mx-1 grid min-w-0 gap-2 border-b px-1 py-2.5 backdrop-blur md:top-12">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-2">
          <button type="button" onClick={() => void leave(d.id ? `${LIBRARY}/${d.id}` : LIBRARY)} className={cx(btn, "w-8 shrink-0 px-0")} aria-label={t("workflows.studio.back")}>
            <ChevronLeftIcon className="size-4" />
          </button>
          <input
            className="font-display text-ink placeholder:text-ink-2 hover:bg-hover focus:bg-surface focus:ring-edge h-9 min-w-0 flex-1 basis-56 rounded-lg bg-transparent px-2 text-xl font-semibold tracking-[-0.02em] outline-none focus:ring-1"
            value={d.name}
            onChange={(e) => set((x) => ({ ...x, name: e.target.value }))}
            placeholder={t("workflows.studio.namePh")}
            aria-label={t("workflows.editor.name")}
            maxLength={120}
            autoFocus={!initial.name}
          />
          <div className="flex min-w-0 flex-wrap items-center gap-2 max-sm:w-full">
            <Picker
              variant="button"
              label={t("workflows.editor.category")}
              value={d.category}
              onChange={(v) => set((x) => ({ ...x, category: v as Category }))}
              options={CATEGORIES.map((c) => ({ value: c, label: t(`workflows.category.${c}`), icon: <span className="[&_svg]:size-4">{CATEGORY[c].icon}</span> }))}
            />
            <span className="max-lg:hidden">{ready}</span>
            {/* Below lg Preflight has no column: its chip opens it as a sheet. */}
            <button type="button" className="rounded-full lg:hidden" onClick={() => setSheet(true)} aria-haspopup="dialog" aria-label={t("workflows.studio.preflight")}>
              {ready}
            </button>
            <span className="ml-auto flex shrink-0 items-center gap-2">
              <button type="button" className={btn} onClick={() => void leave(d.id ? `${LIBRARY}/${d.id}` : LIBRARY)}>
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className={btnPrimary}
                disabled={busy || !d.name.trim() || !d.steps.length || errors > 0}
                title={errors ? t("workflows.studio.blocked", { count: errors }) : undefined}
                onClick={() => void save()}
              >
                {t("common.save")}
              </button>
            </span>
          </div>
        </div>
        {error ? (
          <p role="alert" className="bg-block-wash text-block m-0 rounded-lg px-3 py-2 text-sm">
            {error}
          </p>
        ) : null}
        {/* Below 2xl the sections are a row of chips that scrolls sideways. */}
        <nav aria-label={t("workflows.studio.sections")} className="-mx-1 flex min-w-0 gap-1 overflow-x-auto px-1 [scrollbar-width:none] 2xl:hidden">
          {SECTIONS.map((s, i) => (
            <button
              key={s}
              type="button"
              aria-current={active === s ? "true" : undefined}
              onClick={() => go(s)}
              className={cx(
                "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[13px] max-md:h-8",
                active === s ? "bg-ink/[0.07] text-ink font-medium" : "text-ink-soft hover:bg-ink/[0.04]",
              )}
            >
              <span className="text-ink-2 text-xs tabular-nums">{i + 1}</span>
              {t(`workflows.studio.section.${s}`)}
              {dot(s)}
            </button>
          ))}
        </nav>
      </header>

      <div className="grid min-w-0 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_19rem] 2xl:grid-cols-[11rem_minmax(0,1fr)_20rem]">
        <nav aria-label={t("workflows.studio.sections")} className="sticky top-32 grid gap-0.5 max-2xl:hidden">
          {SECTIONS.map((s, i) => (
            <button
              key={s}
              type="button"
              aria-current={active === s ? "true" : undefined}
              onClick={() => go(s)}
              className={cx(
                "flex h-8 min-w-0 items-center gap-2 rounded-lg px-2 text-left text-[13px]",
                active === s ? "bg-ink/[0.07] text-ink font-medium" : "text-ink-soft hover:bg-ink/[0.04]",
              )}
            >
              <span className="text-ink-2 w-3 shrink-0 text-xs tabular-nums">{i + 1}</span>
              <span className="min-w-0 flex-1 truncate">{t(`workflows.studio.section.${s}`)}</span>
              {dot(s)}
            </button>
          ))}
        </nav>

        <div className="grid min-w-0 gap-4">
          <div id="studio-overview" className="min-w-0 scroll-mt-40">
            <OverviewSection d={d} set={set} />
          </div>
          <div id="studio-inputs" className="min-w-0 scroll-mt-40">
            <InputsSection d={d} set={set} />
          </div>
          <div id="studio-environment" className="min-w-0 scroll-mt-40">
            <EnvironmentSection d={d} set={set} runners={runners} />
          </div>
          <div id="studio-resources" className="min-w-0 scroll-mt-40">
            <ResourcesSection d={d} set={set} prompting={prompting} />
          </div>
          <div id="studio-steps" className="min-w-0 scroll-mt-40">
            <StepsSection d={d} set={set} catalog={catalog} analysis={a} open={openStep} setOpen={setOpenStep} />
          </div>
          <div id="studio-guardrails" className="min-w-0 scroll-mt-40">
            <GuardrailsSection d={d} set={set} />
          </div>
          <div id="studio-output" className="min-w-0 scroll-mt-40">
            <OutputSection d={d} set={set} />
          </div>
          <div id="studio-start" className="min-w-0 scroll-mt-40">
            <StartSection d={d} set={set} />
          </div>
        </div>

        <aside
          aria-label={t("workflows.studio.preflight")}
          className="bg-surface shadow-card sticky top-32 grid max-h-[calc(100dvh-9rem)] min-w-0 gap-3 overflow-y-auto rounded-xl p-3 max-lg:hidden"
        >
          <div className="flex items-center justify-between gap-2 px-2 pt-1">
            <h2 className="text-ink m-0 text-sm font-semibold">{t("workflows.studio.preflight")}</h2>
            {ready}
          </div>
          {preflight}
        </aside>
      </div>

      {sheet ? (
        <Modal title={t("workflows.studio.preflight")} onClose={() => setSheet(false)}>
          {preflight}
        </Modal>
      ) : null}
      {dialog}
    </div>
  );
}
