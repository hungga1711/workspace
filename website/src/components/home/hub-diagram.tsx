import {
  Bot,
  CalendarDays,
  ChartColumn,
  Check,
  FileText,
  Gauge,
  Globe,
  MessagesSquare,
  Plug,
  Presentation,
  ShieldCheck,
  SquareKanban,
  Stamp,
  Terminal,
  TrendingUp,
} from "lucide-react";
import type { ReactNode } from "react";
import { Mark } from "@/components/brand";

// How the product fits together: every feature feeds one workspace; the workspace hands tasks to AI agents (a task's
// assigned workflow, MCP) and manages the AI they use (usage, cost, safety net, whether it helps). Boxes are HTML
// placed on the SVG's coordinates by percentage, so the lines meet them at any width.

const W = 1000;
const H = 480;
const FEATURE_YS = [50, 126, 202, 278, 354, 430];
const HUB = { x: 380, y: 106, w: 240, h: 268 };
const AGENTS_BOX = { x: 780, y: 16, w: 220, h: 236 };
const MANAGE_BOX = { x: 780, y: 284, w: 220, h: 180 };
const AGENT_PORT = AGENTS_BOX.y + AGENTS_BOX.h / 2;
const MANAGE_PORT = MANAGE_BOX.y + MANAGE_BOX.h / 2;

const FEATURES: [ReactNode, string][] = [
  [<SquareKanban key="i" />, "Tasks and projects"],
  [<MessagesSquare key="i" />, "Chat and calls"],
  [<FileText key="i" />, "Docs"],
  [<CalendarDays key="i" />, "Meetings and calendar"],
  [<Stamp key="i" />, "Requests and time"],
  [<Presentation key="i" />, "Whiteboards"],
];
const AGENTS: [ReactNode, string, string][] = [
  [<Terminal key="i" />, "Coding agents", "Claude Code · Codex · Gemini CLI"],
  [<Globe key="i" />, "AI chat sites", "ChatGPT · Claude · Gemini"],
  [<Bot key="i" />, "Company model", "vendor key · API · Ollama"],
  [<Plug key="i" />, "MCP clients", "Cursor · VS Code · assistants"],
];
const MANAGE: [ReactNode, string][] = [
  [<ChartColumn key="i" />, "Usage and cost"],
  [<ShieldCheck key="i" />, "Safety net"],
  [<TrendingUp key="i" />, "Does it help"],
  [<Gauge key="i" />, "Policy and budgets"],
];

const pct = (v: number, of: number) => `${(v / of) * 100}%`;
const place = (b: { x: number; y: number; w: number; h: number }) => ({ left: pct(b.x, W), top: pct(b.y, H), width: pct(b.w, W), height: pct(b.h, H) });

function Label({ x, y, children, accent }: { x: number; y: number; children: ReactNode; accent?: boolean }) {
  return (
    <span
      className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-full px-2 py-0.5 text-[10.5px] whitespace-nowrap shadow-[0_0_0_1px_var(--color-hair)] ${
        accent ? "bg-[#0b1020] text-[#a5b4fc]" : "bg-panel text-ink-3"
      }`}
      style={{ left: pct(x, W), top: pct(y, H) }}
    >
      {children}
    </span>
  );
}

/** The hub: a task page in miniature, the way the app shows a task handed to a workflow and waiting for a person. */
function TaskCard() {
  const props: [string, ReactNode][] = [
    ["Workflow", "Proposal"],
    ["Agent", "Company model"],
    [
      "Status",
      <span key="s" className="inline-flex items-center gap-1.5 text-[#f5a524]">
        <span className="size-1.5 rounded-full bg-[#f5a524]" /> Needs approval
      </span>,
    ],
  ];
  const steps: [string, boolean][] = [
    ["Understand the need", true],
    ["Write the proposal", true],
    ["Recheck prices and totals", true],
    ["Approve before sending", false],
  ];
  return (
    <div className="flex size-full flex-col overflow-hidden rounded-xl bg-panel text-left shadow-[0_0_0_1px_var(--color-hair-strong),0_0_80px_-16px_rgba(91,91,246,0.55)]">
      <div className="flex items-center justify-between border-b border-hair px-3 py-2">
        <span className="flex items-center gap-1.5 text-[11.5px] font-medium text-ink">
          <Mark className="size-4" /> Workspace
        </span>
        <span className="font-mono text-[10px] text-ink-4">T-214</span>
      </div>
      <div className="flex flex-1 flex-col px-3 py-2.5">
        <p className="text-[12.5px] leading-snug font-medium text-ink">Proposal for Lakeshore Logistics</p>
        <dl className="mt-2 space-y-1 text-[11px]">
          {props.map(([k, v]) => (
            <div key={k} className="flex items-center justify-between gap-2">
              <dt className="text-ink-4">{k}</dt>
              <dd className="text-ink-2">{v}</dd>
            </div>
          ))}
        </dl>
        <ol className="mt-2.5 space-y-1 border-t border-hair pt-2.5 text-[11px]">
          {steps.map(([t, done]) => (
            <li key={t} className="flex items-center gap-1.5">
              {done ? <Check className="size-3 shrink-0 text-ink-3" /> : <span className="ml-[3px] size-1.5 shrink-0 rounded-full bg-[#f5a524]" />}
              <span className={done ? "text-ink-3" : "text-ink"}>{t}</span>
            </li>
          ))}
        </ol>
        <div className="mt-auto flex gap-1.5 pt-2.5">
          <span className="inline-flex h-6 flex-1 items-center justify-center rounded-md bg-ink text-[11px] font-medium text-ground">Approve</span>
          <span className="inline-flex h-6 flex-1 items-center justify-center rounded-md text-[11px] text-ink-2 shadow-[0_0_0_1px_var(--color-hair-strong)]">Send back</span>
        </div>
      </div>
    </div>
  );
}

function Wide() {
  const toHub = FEATURE_YS.map((y) => `M222 ${y} C 300 ${y}, 300 ${H / 2}, ${HUB.x} ${H / 2}`);
  const toAgents = `M${HUB.x + HUB.w} ${H / 2 - 40} C 700 ${H / 2 - 40}, 700 ${AGENT_PORT}, ${AGENTS_BOX.x} ${AGENT_PORT}`;
  const toManage = `M${HUB.x + HUB.w} ${H / 2 + 40} C 700 ${H / 2 + 40}, 700 ${MANAGE_PORT}, ${MANAGE_BOX.x} ${MANAGE_PORT}`;
  const agentsToManage = `M${AGENTS_BOX.x + AGENTS_BOX.w / 2} ${AGENTS_BOX.y + AGENTS_BOX.h} L ${AGENTS_BOX.x + AGENTS_BOX.w / 2} ${MANAGE_BOX.y}`;
  const paths: [string, number][] = [...toHub.map((d, i): [string, number] => [d, i * 0.45]), [toAgents, 0.3], [toManage, 1.5], [agentsToManage, 2.2]];

  return (
    <div className="relative hidden lg:block" style={{ aspectRatio: `${W} / ${H}` }}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible" aria-hidden>
        {paths.map(([d, delay], i) => (
          <g key={i}>
            <path d={d} fill="none" stroke="var(--color-hair-strong)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
            <path d={d} fill="none" stroke={i >= FEATURE_YS.length ? "#a78bfa" : "#52a8ff"} strokeWidth="1.5" vectorEffect="non-scaling-stroke" className="packet" style={{ animationDelay: `${delay}s` }} />
          </g>
        ))}
      </svg>

      {/* features → workspace */}
      <p className="absolute -top-7 left-0 text-[11px] font-medium tracking-[0.06em] text-ink-4 uppercase">Everything your team does</p>
      {FEATURES.map(([icon, t], i) => (
        <div key={t} className="absolute left-0 w-[22%] -translate-y-1/2" style={{ top: pct(FEATURE_YS[i], H) }}>
          <div className="flex items-center gap-2.5 rounded-lg bg-panel px-3 py-2 shadow-[0_0_0_1px_var(--color-hair)]">
            <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-ink [&_svg]:size-3.5">{icon}</span>
            <span className="truncate text-[13px] text-ink">{t}</span>
          </div>
        </div>
      ))}

      {/* the hub */}
      <div className="absolute" style={place(HUB)}>
        <TaskCard />
      </div>

      <Label x={(HUB.x + HUB.w + AGENTS_BOX.x) / 2} y={(H / 2 - 40 + AGENT_PORT) / 2} accent>
        assigns workflows · MCP
      </Label>
      <Label x={(HUB.x + HUB.w + MANAGE_BOX.x) / 2} y={(H / 2 + 40 + MANAGE_PORT) / 2} accent>
        manages the AI
      </Label>
      <Label x={AGENTS_BOX.x + AGENTS_BOX.w / 2} y={(AGENTS_BOX.y + AGENTS_BOX.h + MANAGE_BOX.y) / 2}>
        usage reported
      </Label>

      {/* workspace → AI agents */}
      <div className="absolute flex flex-col rounded-xl bg-[#0b1020] p-3 shadow-[0_0_0_1px_rgba(91,91,246,0.45)]" style={place(AGENTS_BOX)}>
        <p className="px-1 text-[10.5px] font-medium tracking-[0.06em] text-[#a5b4fc] uppercase">AI agents</p>
        <div className="mt-2 flex flex-1 flex-col justify-between gap-1.5">
          {AGENTS.map(([icon, t, s]) => (
            <div key={t} className="flex items-center gap-2 rounded-md bg-white/[0.04] px-2 py-1.5">
              <span className="inline-flex size-6 shrink-0 items-center justify-center rounded bg-white/[0.06] text-white [&_svg]:size-3.5">{icon}</span>
              <span className="min-w-0">
                <span className="block truncate text-[12px] text-white">{t}</span>
                <span className="block truncate text-[10.5px] text-white/45">{s}</span>
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* workspace → manage AI */}
      <div className="absolute flex flex-col rounded-xl bg-panel p-3 shadow-[0_0_0_1px_var(--color-hair-strong)]" style={place(MANAGE_BOX)}>
        <p className="px-1 text-[10.5px] font-medium tracking-[0.06em] text-ink-3 uppercase">Manage AI</p>
        <div className="mt-2 grid flex-1 grid-cols-2 gap-1.5">
          {MANAGE.map(([icon, t]) => (
            <div key={t} className="flex flex-col justify-center gap-1 rounded-md bg-muted px-2 py-1.5">
              <span className="text-signal-text [&_svg]:size-3.5">{icon}</span>
              <span className="text-[11.5px] leading-tight text-ink">{t}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Phones and tablets: the same model, top to bottom. */
function Stacked() {
  const down = <div aria-hidden className="mx-auto h-6 w-px bg-gradient-to-b from-hair-strong to-signal" />;
  return (
    <div className="lg:hidden">
      <p className="mb-2 text-xs font-medium tracking-[0.04em] text-ink-3 uppercase">Everything your team does</p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {FEATURES.map(([icon, t]) => (
          <div key={t} className="flex items-center gap-2 rounded-lg bg-panel px-2.5 py-2 shadow-[0_0_0_1px_var(--color-hair)]">
            <span className="text-ink [&_svg]:size-3.5">{icon}</span>
            <span className="truncate text-[12.5px] text-ink">{t}</span>
          </div>
        ))}
      </div>
      {down}
      <div className="mx-auto h-[19rem] max-w-xs">
        <TaskCard />
      </div>
      {down}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl bg-[#0b1020] p-3 shadow-[0_0_0_1px_rgba(91,91,246,0.45)]">
          <p className="text-[10.5px] font-medium tracking-[0.06em] text-[#a5b4fc] uppercase">AI agents · assigned workflows, MCP</p>
          <ul className="mt-2 space-y-1.5">
            {AGENTS.map(([icon, t, s]) => (
              <li key={t} className="flex items-center gap-2 text-[12px] text-white">
                <span className="[&_svg]:size-3.5">{icon}</span>
                {t} <span className="truncate text-white/45">{s}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="rounded-xl bg-panel p-3 shadow-[0_0_0_1px_var(--color-hair-strong)]">
          <p className="text-[10.5px] font-medium tracking-[0.06em] text-ink-3 uppercase">Manage AI</p>
          <ul className="mt-2 grid grid-cols-2 gap-1.5">
            {MANAGE.map(([icon, t]) => (
              <li key={t} className="flex items-center gap-1.5 rounded-md bg-muted px-2 py-1.5 text-[12px] text-ink">
                <span className="text-signal-text [&_svg]:size-3.5">{icon}</span>
                {t}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

export function HubDiagram() {
  return (
    <div role="img" aria-label="Every feature feeds one workspace. In the workspace a task is assigned a workflow; the workspace hands work to AI agents and manages the AI they use: usage and cost, safety net, whether it helps, policy and budgets.">
      <Wide />
      <Stacked />
    </div>
  );
}
