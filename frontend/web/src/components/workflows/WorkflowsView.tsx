"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { api } from "@/lib/client";
import { useT } from "@/lib/i18n/client";
import { btn, btnPrimary, btnSm, cx } from "@/lib/ui";
import { IconTile, card, type Tone } from "@/components/ui/Bento";
import { Tabs } from "@/components/ui/Tabs";
import { AllClear } from "@/components/ai-hub/Intro";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { Menu } from "@/components/ui/Menu";
import { useConfirm } from "@/components/ui/Confirm";
import { useToast } from "@/components/ui/Toast";
import { useOpenAsks } from "./useOpenAsks";
import { ApprovalIcon, ArrowRightIcon, BotIcon, CheckCircleIcon, GridIcon, InfoIcon, PlayIcon, PlusIcon, TerminalIcon, UsersIcon, WorkflowIcon } from "@/components/app/icons";
import type { Category, RunnerInfo, Workflow, WorkflowActivity, WorkflowTemplate } from "./types";
import { Runs, type RunFilter } from "./library/Runs";
import { TemplateCard, WorkflowCard } from "./library/cards";
import { CategoryChips, SearchField, categoryRank, type LibraryKey } from "./library/shared";

export type WorkflowTab = "list" | "runs" | "performance" | "templates";

// A template's preview opens on a click: its dialog is not part of the page's first load.
const TemplatePreview = dynamic(() => import("./library/TemplatePreview"), { ssr: false });
// Performance reads its own figures when its tab opens: neither its code nor its data is in the library's first load.
const Performance = dynamic(() => import("./library/Performance"), { ssr: false });

const has = (q: string, ...texts: string[]) => {
  const needle = q.trim().toLowerCase();
  return !needle || texts.some((x) => x.toLowerCase().includes(needle));
};
const countBy = <T extends { category: Category }>(items: T[]) => {
  const m = new Map<Category, number>();
  for (const x of items) m.set(x.category, (m.get(x.category) ?? 0) + 1);
  return m;
};

/**
 * AI › Workflows, the library: the company's workflows for every department, the runs, and the
 * templates. A head with one line and New; four figures that are also the Runs tab's filters; an orange bar when
 * something waits for the reader; then the tabs. Workflows and templates filter by department and by search. Making
 * and editing a workflow happen on their own pages (the studio: /app/ai/workflows/new, /<id>/edit), not in a dialog.
 * Without a company AI the page still works: sandbox and computer workflows run on connected computers.
 */
export function WorkflowsView({
  initial,
  templates,
  activity,
  runners,
  aiOn,
  tab,
}: {
  initial: Workflow[];
  templates: WorkflowTemplate[];
  /** Null when its read failed: the figures and runs say so with a retry, the rest of the page stays. */
  activity: WorkflowActivity | null;
  /** The computers seen lately that can take sandbox and computer runs. */
  runners: RunnerInfo[];
  aiOn: boolean;
  tab: WorkflowTab;
}) {
  const t = useT();
  const toast = useToast();
  const router = useRouter();
  const { confirm, dialog } = useConfirm();
  const [list, setList] = useState(initial);
  const [current, setCurrent] = useState<WorkflowTab>(tab);
  const [runFilter, setRunFilter] = useState<RunFilter>("all");
  const [cat, setCat] = useState<Category | "all">("all");
  const [q, setQ] = useState("");
  const [tplCat, setTplCat] = useState<Category | "all">("all");
  const [tplQ, setTplQ] = useState("");
  const [preview, setPreview] = useState<WorkflowTemplate | null>(null);
  const mine = useOpenAsks();
  const k = (key: LibraryKey, vars?: Record<string, string | number>) => t(`workflows.library.${key}`, vars);
  const href = (x: WorkflowTab) => (x === "list" ? "/app/ai/workflows" : `/app/ai/workflows?tab=${x}`);

  const remove = async (w: Workflow) => {
    if (!(await confirm({ title: t("workflows.confirmRemove", { name: w.name }), confirmLabel: t("common.delete"), danger: true }))) return;
    try {
      await api(`work/workflows/${w.id}`, { method: "DELETE" });
      setList((l) => l.filter((x) => x.id !== w.id));
    } catch {
      toast({ message: t("common.actionFailed") });
    }
  };
  const duplicate = async (w: Workflow) => {
    try {
      const copy = await api<Workflow>(`work/workflows/${w.id}/duplicate`, { method: "POST" });
      setList((l) => [copy, ...l.filter((x) => x.id !== copy.id)]);
      toast({ message: k("duplicated") });
    } catch {
      toast({ message: t("common.actionFailed") });
    }
  };

  const listCounts = useMemo(() => countBy(list), [list]);
  const shownList = list.filter((w) => (cat === "all" || w.category === cat) && has(q, w.name, w.description));
  const tplCounts = useMemo(() => countBy(templates), [templates]);
  const shownTpl = templates.filter((x) => (tplCat === "all" || x.category === tplCat) && has(tplQ, x.name, x.description, ...(x.uses ?? [])));
  // The gallery reads department by department, in the server's order.
  const tplGroups = useMemo(() => {
    const m = new Map<Category, WorkflowTemplate[]>();
    for (const x of shownTpl) m.set(x.category, [...(m.get(x.category) ?? []), x]);
    return [...m.entries()].sort((a, b) => categoryRank(a[0]) - categoryRank(b[0]));
  }, [shownTpl]);
  // An empty library starts from three templates of different departments that need nothing extra to run.
  const starters = useMemo(() => {
    const seen = new Set<Category>();
    const ready = [...templates].sort((a, b) => Number(a.runner === "local") - Number(b.runner === "local"));
    return ready.filter((x) => (seen.has(x.category) ? false : (seen.add(x.category), true))).slice(0, 3);
  }, [templates]);

  const s = activity?.stats;
  const waiting = s ? s.waiting + (s.asking ?? 0) : 0;
  const running = s ? s.active + (s.paused ?? 0) : 0;
  const finished = s ? s.done30d + s.failed30d : 0;
  const pick = (f: RunFilter) => {
    setRunFilter(f);
    setCurrent("runs");
    window.history.replaceState(null, "", href("runs"));
  };

  const online = runners.filter((r) => r.online);
  const showRunners = runners.length > 0 || list.some((w) => w.runner === "local");

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
      <header className="flex flex-wrap items-start gap-x-5 gap-y-3">
        <div className="min-w-0 flex-1 basis-64">
          <h2 className="text-ink m-0 text-xl font-semibold tracking-[-0.02em]">{t("workflows.title")}</h2>
          <p className="text-ink-2 m-0 mt-0.5 max-w-2xl text-[13px]">{k("lead")}</p>
          {showRunners ? (
            <Link href="/app/ai/connect" className="text-ink-2 hover:text-ink mt-1.5 inline-flex items-center gap-1.5 text-xs no-underline [&_svg]:size-3.5">
              <TerminalIcon />
              <span aria-hidden="true" className={cx("size-1.5 rounded-full", online.length ? "bg-ok-fill" : "bg-edge")} />
              {online.length
                ? [
                    online.some((r) => !r.shared) ? k("computers", { count: online.filter((r) => !r.shared).length }) : "",
                    online.some((r) => r.shared) ? k("companyRunners", { count: online.filter((r) => r.shared).length }) : "",
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : k("noComputers")}
            </Link>
          ) : null}
        </div>
        <Menu
          label={t("workflows.new")}
          align="right"
          items={[
            {
              label: k("fromTemplate"),
              icon: <GridIcon />,
              onSelect: () => {
                setCurrent("templates");
                window.history.replaceState(null, "", href("templates"));
              },
            },
            { label: t("workflows.blank"), icon: <PlusIcon />, onSelect: () => router.push("/app/ai/workflows/new") },
          ]}
          trigger={
            <span className={btnPrimary}>
              <PlusIcon className="size-4" />
              {t("workflows.new")}
            </span>
          }
        />
      </header>

      {aiOn ? null : (
        <p className="text-ink-2 m-0 -mt-2 flex max-w-3xl items-start gap-2 text-xs">
          <InfoIcon className="size-4 shrink-0" />
          {t("workflows.noAi")}
        </p>
      )}

      {/* The figures are the Runs tab's filters. A failed read says so here; the tabs below stay. */}
      {s ? (
        <section aria-label={t("workflows.stats.label")} className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <FigureTile
            tone="sky"
            icon={<PlayIcon />}
            label={k("fig.running")}
            n={running}
            live={running > 0}
            active={current === "runs" && runFilter === "running"}
            onClick={() => pick("running")}
          />
          <FigureTile
            tone="tangerine"
            icon={<UsersIcon />}
            label={k("fig.waiting")}
            n={waiting}
            warn={waiting > 0}
            active={current === "runs" && runFilter === "waiting"}
            onClick={() => pick("waiting")}
          />
          <FigureTile
            tone="green"
            icon={<CheckCircleIcon />}
            label={k("fig.done")}
            n={s.done30d}
            note={finished ? k("fig.rate", { pct: Math.round((s.done30d / finished) * 100) }) : undefined}
            active={current === "runs" && runFilter === "done"}
            onClick={() => pick("done")}
          />
          <FigureTile
            tone="red"
            icon={<InfoIcon />}
            label={k("fig.failed")}
            n={s.failed30d}
            alert={s.failed30d > 0}
            active={current === "runs" && runFilter === "failed"}
            onClick={() => pick("failed")}
          />
        </section>
      ) : activity === null ? (
        <div className={cx(card, "rounded-xl px-5 py-4")}>
          <LoadFailed what={t("workflows.stats.label")} />
        </div>
      ) : null}

      {/* What waits on me comes first, whatever the tab: each question or approval opens its conversation in chat. */}
      {mine.length ? (
        <section aria-labelledby="wf-wait-h" className="bg-warn-wash ring-warn/20 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-xl px-4 py-3 ring-1 ring-inset">
          <span className="bg-warn grid size-7 shrink-0 place-items-center rounded-lg text-[13px] font-semibold tabular-nums text-white">{mine.length}</span>
          <h2 id="wf-wait-h" className="text-ink m-0 min-w-0 flex-1 basis-40 text-sm font-medium">
            {t("workflows.waitingBar", { count: mine.length })}
          </h2>
          <span className="flex flex-wrap justify-end gap-1.5 max-sm:w-full max-sm:justify-start">
            {mine.map((a) => (
              <Link key={a.id} href={`/app/chat/ask/${a.runId}`} className={cx(btn, btnSm, "no-underline")} title={a.taskTitle}>
                {a.kind === "approval" ? <ApprovalIcon className="text-tangerine-text" /> : <BotIcon className="text-violet-text" />}
                {t(a.kind === "approval" ? "workflows.ask.approvalItem" : "workflows.ask.item", { code: a.taskCode })}
              </Link>
            ))}
          </span>
        </section>
      ) : null}

      <div className="border-hairline border-b">
        <Tabs
          active={current}
          onSelect={(x) => setCurrent(x as WorkflowTab)}
          tabs={[
            { key: "list", label: t("workflows.tabs.list"), href: href("list"), count: list.length, short: t("workflows.tabs.listShort") },
            { key: "runs", label: t("workflows.tabs.runs"), href: href("runs") },
            { key: "performance", label: t("workflows.tabs.performance"), href: href("performance") },
            { key: "templates", label: t("workflows.tabs.templates"), href: href("templates"), count: templates.length, short: t("workflows.tabs.templatesShort") },
          ]}
        />
      </div>

      {current === "list" ? (
        list.length ? (
          <section aria-label={t("workflows.tabs.list")} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
              {listCounts.size > 1 ? <CategoryChips counts={listCounts} total={list.length} value={cat} onChange={setCat} label={k("department")} /> : <span />}
              {list.length > 3 ? <SearchField value={q} onChange={setQ} label={k("search")} /> : null}
            </div>
            {shownList.length ? (
              <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(100%,21rem),1fr))] gap-4 p-0">
                {shownList.map((w) => (
                  <WorkflowCard
                    key={w.id}
                    w={w}
                    usage={activity ? (activity.usage[w.id] ?? null) : undefined}
                    onEdit={() => router.push(`/app/ai/workflows/${w.id}/edit`)}
                    onDuplicate={() => void duplicate(w)}
                    onRemove={() => void remove(w)}
                  />
                ))}
              </ul>
            ) : (
              <NoMatch
                onClear={() => {
                  setCat("all");
                  setQ("");
                }}
              />
            )}
          </section>
        ) : (
          <section aria-label={t("workflows.tabs.list")} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3">
            <div className="flex min-w-0 flex-wrap items-center gap-3.5">
              <IconTile tone="violet">
                <WorkflowIcon />
              </IconTile>
              <p className="text-ink-soft m-0 min-w-0 flex-1 basis-48 text-[13px]">{k("empty")}</p>
              <Link
                href={href("templates")}
                onClick={() => setCurrent("templates")}
                className="text-ink inline-flex items-center gap-1 text-[13px] font-medium no-underline hover:underline [&_svg]:size-3.5"
              >
                {k("allTemplates")}
                <ArrowRightIcon />
              </Link>
            </div>
            <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(100%,19rem),1fr))] gap-3 p-0">
              {starters.map((x) => (
                <TemplateCard key={x.key} x={x} aiOn={aiOn} runners={runners} onOpen={() => setPreview(x)} compact />
              ))}
            </ul>
          </section>
        )
      ) : current === "runs" ? (
        <Runs activity={activity} filter={runFilter} onFilter={setRunFilter} />
      ) : current === "performance" ? (
        <Performance />
      ) : (
        <section aria-label={t("workflows.templates")} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <CategoryChips counts={tplCounts} total={templates.length} value={tplCat} onChange={setTplCat} label={k("department")} />
            <SearchField value={tplQ} onChange={setTplQ} label={k("searchTemplates")} />
          </div>
          {tplGroups.length ? (
            tplGroups.map(([c, items]) => (
              <section key={c} aria-labelledby={`tpl-${c}`} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2.5">
                <h3 id={`tpl-${c}`} className="text-ink-2 m-0 text-xs font-medium uppercase tracking-[0.08em]">
                  {t(`workflows.category.${c}`)}
                </h3>
                <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(100%,19rem),1fr))] gap-3 p-0">
                  {items.map((x) => (
                    <TemplateCard key={x.key} x={x} aiOn={aiOn} runners={runners} onOpen={() => setPreview(x)} />
                  ))}
                </ul>
              </section>
            ))
          ) : (
            <NoMatch
              onClear={() => {
                setTplCat("all");
                setTplQ("");
              }}
            />
          )}
          <Link href="/app/ai/workflows/new" className={cx(card, "group/blank flex min-w-0 items-center gap-3.5 rounded-xl px-5 py-4 no-underline max-sm:px-4")}>
            <span aria-hidden="true" className="bg-ground ring-hairline text-ink-2 grid size-8 shrink-0 place-items-center rounded-[9px] ring-1 ring-inset [&_svg]:size-4">
              <PlusIcon />
            </span>
            <span className="min-w-0 flex-1 leading-[1.35]">
              <span className="text-ink block text-sm font-semibold tracking-[-0.01em]">{t("workflows.blank")}</span>
              <span className="text-ink-2 block text-[13px]">{t("workflows.blankSub")}</span>
            </span>
            <ArrowRightIcon className="text-ink-2 group-hover/blank:text-ink size-4 shrink-0 transition-transform group-hover/blank:translate-x-0.5" />
          </Link>
        </section>
      )}

      {preview ? <TemplatePreview x={preview} aiOn={aiOn} runners={runners} onClose={() => setPreview(null)} /> : null}
      {dialog}
    </div>
  );
}

function NoMatch({ onClear }: { onClear: () => void }) {
  const t = useT();
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-3">
      <AllClear className="min-w-0 flex-1">{t("workflows.library.noMatch")}</AllClear>
      <button type="button" className={cx(btn, btnSm)} onClick={onClear}>
        {t("workflows.library.clear")}
      </button>
    </div>
  );
}

/** One figure as a tile that is also a filter: pressing it opens the Runs tab on those runs. */
function FigureTile({
  tone,
  icon,
  label,
  n,
  note,
  live,
  warn,
  alert,
  active,
  onClick,
}: {
  tone: Tone;
  icon: React.ReactNode;
  label: string;
  n: number;
  /** A small second figure beside the big one ("92% succeeded"). */
  note?: string | undefined;
  live?: boolean;
  warn?: boolean;
  alert?: boolean;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cx(
        card,
        "focus-visible:outline-accent flex min-w-0 cursor-pointer flex-col rounded-xl p-4 text-left focus-visible:outline-2 focus-visible:outline-offset-2 max-sm:p-3.5",
        active && "ring-ink/70 ring-1 ring-inset",
      )}
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <IconTile tone={tone}>{icon}</IconTile>
        <span className="text-ink-2 line-clamp-2 min-w-0 text-[13px] leading-tight">{label}</span>
      </span>
      <span className="mt-3 flex min-w-0 items-baseline gap-2">
        <span
          className={cx(
            "font-display text-[32px]/none font-semibold tabular-nums tracking-[-0.045em] max-sm:text-[28px]/none",
            alert ? "text-block" : warn ? "text-warn" : "text-ink",
          )}
        >
          {n}
        </span>
        {live ? <span aria-hidden="true" className="bg-accent size-2 shrink-0 self-center rounded-full motion-safe:animate-pulse" /> : null}
        {note ? <span className="text-ink-2 min-w-0 truncate text-xs">{note}</span> : null}
      </span>
    </button>
  );
}
