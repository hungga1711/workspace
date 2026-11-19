"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { useFormat, useT } from "@/lib/i18n/client";
import type { McpTone } from "@/lib/mcp-gallery";
import { useFeatures, type Feature } from "@/lib/features-context";
import { cx } from "@/lib/ui";
import { ArrowRightIcon, ChartIcon, FileIcon, PencilIcon, SparkleIcon, WorkflowIcon } from "@/components/app/icons";
import { CategoryTile } from "@/components/workflows/bits";
import { IconTile, card, type Tone } from "@/components/ui/Bento";
import { BrandMark } from "@/components/ui/BrandMark";
import { SpotArea } from "@/components/ui/SpotArea";
import type { Category, Runner } from "@/components/workflows/types";

// The connected tool servers' row (and its sign-in popup) is its own chunk: most companies have none (route budget).
const ToolServers = dynamic(() => import(/* webpackChunkName: "ask-extras" */ "./McpServersRow").then((m) => m.ToolServers));

export interface WelcomeTask {
  id: string;
  code?: string | null;
  title: string;
  dueAt: string | null;
}
export interface WelcomeWorkflow {
  id: string;
  name: string;
  category: Category;
  runner: Runner;
}

/** An outside tool server (MCP) this person's AI can use; `connected` false: they still sign in with their own account. */
export interface WelcomeServer {
  id: string;
  name: string;
  mono: string;
  tone: McpTone;
  perUser: boolean;
  connected: boolean;
}

/** What AI can be handed, each with its own colour so the four read as different jobs at a glance. */
const ACTIONS = [
  { key: "task", icon: <WorkflowIcon />, tone: "sky" },
  { key: "brief", icon: <ChartIcon />, tone: "green" },
  { key: "write", icon: <PencilIcon />, tone: "violet" },
  { key: "find", icon: <FileIcon />, tone: "tangerine" },
] as const satisfies readonly { key: string; icon: React.ReactNode; tone: Tone }[];

/**
 * The "Try" chips: what the assistant's tools can do, picked for who is asking. A manager first sees the questions
 * about their people (workload, the weekly report, AI next to output); everyone sees what waits for them and what
 * they missed. A chip whose feature this deployment left out is not shown.
 */
type Example = "attention" | "missed" | "doc" | "task" | "slot" | "workload" | "weekly" | "aiUse" | "plan" | "eod" | "sheet" | "slides";
const EXAMPLES: Record<"lead" | "member", readonly Example[]> = {
  lead: ["workload", "weekly", "aiUse", "attention", "slides", "task"],
  // Staff first see help with their own day (what to do first, the end-of-day report), then office work: a
  // spreadsheet, a deck.
  member: ["plan", "attention", "sheet", "slides", "eod", "missed", "task", "slot"],
};
const EXAMPLE_FEATURE: Partial<Record<Example, Feature>> = { doc: "docs", slot: "calendar", aiUse: "ai" };

/**
 * Hỏi đáp before the first message: a greeting under the
 * app's own mark (no glow, no gradient tile), the composer right under it (the page's one hero card, in the middle rather than at the foot),
 * then what AI can be handed as four tiles, and side by side the person's own open work ("plan it with AI") and the
 * company's agent workflows. Every pick only fills the composer (nothing is sent), so the person can finish the
 * sentence.
 */
export function AskWelcome({
  tasks,
  workflows,
  servers = [],
  name,
  composer,
  lead = false,
  onPick,
}: {
  tasks: WelcomeTask[];
  workflows: WelcomeWorkflow[];
  servers?: WelcomeServer[];
  /** The person's given name, for the greeting. */
  name?: string | undefined;
  /** The composer, placed under the greeting while the thread is empty. */
  composer?: React.ReactNode;
  /** The person sees others' progress (a manager or an admin): the chips lead with questions about their people. */
  lead?: boolean;
  onPick: (text: string) => void;
}) {
  const t = useT();
  const has = useFeatures();
  const examples = EXAMPLES[lead ? "lead" : "member"].filter((k) => has(EXAMPLE_FEATURE[k]));
  const { dueLabel, greeting } = useFormat();
  // The time of day is the browser's: greeted after mount, so the server's HTML and the first paint agree.
  const [hi, setHi] = useState("");
  useEffect(() => setHi(name ? t("aiw.chat.welcome.greet", { greeting: greeting(), name }) : greeting()), [greeting, name, t]);
  const label = "text-ink-2 m-0 text-xs font-medium uppercase tracking-[0.08em]";
  return (
    <SpotArea className="relative grid gap-6 max-sm:gap-5">
      <div className="relative grid justify-items-center gap-3 text-center">
        <BrandMark className="size-12" />
        <div className="grid gap-1">
          <h2 className="font-display m-0 min-h-[34px] text-balance text-[28px]/[1.2] font-semibold tracking-[-0.035em] max-sm:min-h-[29px] max-sm:text-2xl/[1.2]">
            {hi ? <span className="animate-rise inline-block">{hi}</span> : null}
          </h2>
          <p className="text-ink-2 m-0 text-[15px]">{t("aiw.chat.hello")}</p>
        </div>
      </div>

      {composer ? <div className="relative">{composer}</div> : null}

      <section aria-label={t("aiw.chat.welcome.actions")} className="stagger relative grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        {ACTIONS.map((a) => (
          <button
            key={a.key}
            type="button"
            onClick={() => onPick(t(`aiw.chat.welcome.${a.key}.prompt`))}
            className={cx(card, "group/act grid min-w-0 content-start gap-2.5 rounded-xl p-3.5 text-left")}
          >
            <span className="flex items-center justify-between">
              <IconTile tone={a.tone} className="size-9 rounded-[10px] [&_svg]:size-[18px]">
                {a.icon}
              </IconTile>
              <ArrowRightIcon className="text-ink-2 size-3.5 -translate-x-1 opacity-0 transition-[opacity,transform] group-hover/act:translate-x-0 group-hover/act:opacity-100" />
            </span>
            <span className="grid min-w-0 gap-0.5">
              <span className="text-ink text-sm font-semibold">{t(`aiw.chat.welcome.${a.key}.title`)}</span>
              <span className="text-ink-2 line-clamp-2 text-xs">{t(`aiw.chat.welcome.${a.key}.hint`)}</span>
            </span>
          </button>
        ))}
      </section>

      {/* What it can now do with the workspace itself: read it to answer, and change it once the person says yes. */}
      <section aria-label={t("aiMention.examples.label")} className="relative flex min-w-0 flex-wrap items-center gap-1.5">
        <span className="text-ink-2 mr-0.5 text-xs">{t("aiMention.examples.label")}</span>
        {examples.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => onPick(t(`aiMention.examples.${k}`))}
            className="bg-surface ring-hairline text-ink-soft hover:bg-hover hover:text-ink inline-flex min-h-7 max-w-full items-center rounded-full px-2.5 py-1 text-left text-xs ring-1 ring-inset max-md:min-h-8"
          >
            {t(`aiMention.examples.${k}`)}
          </button>
        ))}
      </section>

      {servers.length ? <ToolServers servers={servers} /> : null}

      {tasks.length || workflows.length ? (
        <div className={cx("relative grid gap-x-4 gap-y-6", tasks.length && workflows.length ? "sm:grid-cols-2" : null)}>
          {tasks.length ? (
            <section aria-labelledby="ask-mine" className="grid min-w-0 content-start gap-2">
              <h2 id="ask-mine" className={label}>
                {t("aiw.chat.welcome.mine")}
              </h2>
              <ul className="bg-surface shadow-card divide-divider-soft m-0 list-none divide-y overflow-hidden rounded-xl p-0">
                {tasks.map((x) => {
                  const due = dueLabel(x.dueAt);
                  return (
                    <li key={x.id}>
                      <button
                        type="button"
                        onClick={() => onPick(t("aiw.chat.welcome.planPrompt", { task: `${x.code ? `${x.code} ` : ""}«${x.title}»` }))}
                        title={t("aiw.chat.welcome.plan")}
                        className="hover:bg-hover group grid min-h-12 w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-3.5 py-2 text-left transition-colors"
                      >
                        <span className="grid min-w-0 gap-0.5">
                          <span className="text-ink truncate text-[13px] font-medium">{x.title}</span>
                          <span className="flex min-w-0 items-center gap-2 text-xs">
                            {x.code ? <span className="text-ink-2 shrink-0 font-mono">{x.code}</span> : null}
                            {due ? <span className={cx("truncate", due.overdue ? "text-block font-medium" : "text-ink-2")}>{due.text}</span> : null}
                          </span>
                        </span>
                        <span className="bg-accent-wash text-accent-text grid size-7 shrink-0 place-items-center rounded-full opacity-70 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                          <SparkleIcon className="size-3.5" />
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}

          {workflows.length ? (
            <section aria-labelledby="ask-agents" className="grid min-w-0 content-start gap-2">
              <div className="flex items-baseline">
                <h2 id="ask-agents" className={cx(label, "flex-1")}>
                  {t("aiw.chat.welcome.agents")}
                </h2>
                <Link href="/app/ai/workflows" className="text-ink-2 hover:text-ink inline-flex items-center gap-1 text-xs no-underline">
                  {t("aiw.chat.welcome.manage")}
                  <ArrowRightIcon className="size-3.5" />
                </Link>
              </div>
              <ul className="bg-surface shadow-card divide-divider-soft m-0 list-none divide-y overflow-hidden rounded-xl p-0">
                {workflows.slice(0, tasks.length ? Math.max(3, tasks.length) : 4).map((w) => (
                  <li key={w.id}>
                    <button
                      type="button"
                      onClick={() => onPick(t("aiw.chat.welcome.agentPrompt", { name: w.name }))}
                      className="hover:bg-hover group/wf flex min-h-12 w-full min-w-0 items-center gap-3 px-3.5 py-2 text-left transition-colors"
                    >
                      <CategoryTile category={w.category} size="sm" />
                      <span className="text-ink min-w-0 flex-1 truncate text-[13px] font-medium" title={w.name}>
                        {w.name}
                      </span>
                      <ArrowRightIcon className="text-ink-2 size-3.5 shrink-0 transition-transform group-hover/wf:translate-x-0.5" />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      ) : null}
    </SpotArea>
  );
}
