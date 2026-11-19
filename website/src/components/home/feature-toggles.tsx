"use client";

import { useState } from "react";

// DISABLED_FEATURES (ADR-0026): chat and tasks are the product and always on; docs, whiteboards, calendar, time and
// AI can be left out at deploy time. Flipping a switch here writes the line an operator would put in .env.

const FEATURES: [key: string, label: string, what: string][] = [
  ["whiteboards", "Whiteboards", "Boards for brainstorming"],
  ["calendar", "Calendar", "Events and meeting notes"],
  ["time", "Time", "Attendance and leave"],
  ["docs", "Docs", "Pages and files"],
  ["ai", "AI", "Assistant, agents, insights"],
];

function Switch({ on, disabled, onClick, label }: { on: boolean; disabled?: boolean; onClick?: () => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`relative h-6 w-10 shrink-0 rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal disabled:cursor-not-allowed ${
        on ? (disabled ? "bg-ink-4" : "bg-signal") : "bg-muted shadow-[inset_0_0_0_1px_var(--color-hair-strong)]"
      }`}
    >
      <span className={`absolute top-1 left-1 size-4 rounded-full bg-white shadow transition-transform ${on ? "translate-x-4" : ""}`} />
    </button>
  );
}

export function FeatureToggles() {
  const [off, setOff] = useState<string[]>(["whiteboards"]);
  const flip = (k: string) => setOff((o) => (o.includes(k) ? o.filter((x) => x !== k) : FEATURES.map(([f]) => f).filter((f) => f === k || o.includes(f))));

  return (
    <div className="overflow-hidden rounded-xl bg-panel shadow-[0_0_0_1px_var(--color-hair),0_30px_60px_-30px_rgba(0,0,0,0.9)]">
      <div className="border-b border-hair px-5 py-3.5">
        <p className="text-sm font-medium text-ink">Features</p>
        <p className="mt-0.5 text-xs text-ink-3">Left-out features disappear from every menu, page and API route.</p>
      </div>
      <ul className="divide-y divide-hair">
        <li className="flex items-center gap-4 px-5 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm text-ink">Chat &amp; tasks</p>
            <p className="text-xs text-ink-3">Always on. They are the product.</p>
          </div>
          <Switch on disabled label="Chat and tasks, always on" />
        </li>
        {FEATURES.map(([k, label, what]) => {
          const on = !off.includes(k);
          return (
            <li key={k} className="flex items-center gap-4 px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className={`text-sm transition-colors ${on ? "text-ink" : "text-ink-4 line-through"}`}>{label}</p>
                <p className="text-xs text-ink-3">{what}</p>
              </div>
              <Switch on={on} onClick={() => flip(k)} label={label} />
            </li>
          );
        })}
      </ul>
      <div className="border-t border-hair bg-[#050505] px-5 py-3.5 font-mono text-[12.5px] break-all text-white/80">
        <span className="text-white/40"># infra/production/.env</span>
        <br />
        DISABLED_FEATURES=<span className="text-[#52a8ff]">{off.join(",")}</span>
      </div>
    </div>
  );
}
