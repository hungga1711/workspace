"use client";

import { Hand, MoveRight } from "lucide-react";
import { useState } from "react";

// The templates that ship with the app, from backend/server/src/modules/work/workflows/templates.ts, grouped by its
// categories. "a" marks a step that waits for a person, "s" a step that moves the task on the board.
type Step = [kind: "" | "a" | "s", title: string];
const TEMPLATES: [category: string, name: string, steps: Step[]][] = [
  [
    "Coding",
    "Ship a change",
    [
      ["", "Plan"],
      ["a", "Approve the plan"],
      ["", "Implement"],
      ["", "Tests pass"],
      ["", "Self-review"],
      ["", "Tests still pass"],
      ["", "Open a pull request"],
      ["s", "In review"],
    ],
  ],
  [
    "Coding",
    "Fix a bug",
    [
      ["", "Reproduce and find the cause"],
      ["a", "Approve the fix"],
      ["", "Fix"],
      ["", "Tests pass"],
      ["", "Open a pull request"],
      ["s", "In review"],
    ],
  ],
  [
    "Coding",
    "Review a pull request",
    [
      ["", "Review"],
      ["", "Security and data"],
      ["", "One review"],
      ["", "Findings are usable"],
      ["a", "Approve the review"],
    ],
  ],
  [
    "Coding",
    "Dependency audit in a sandbox",
    [
      ["", "Scan for vulnerabilities"],
      ["", "List outdated packages"],
      ["", "Write the report"],
      ["", "Report is actionable"],
      ["a", "Approve"],
    ],
  ],
  [
    "Product",
    "Feature spec",
    [
      ["", "Problem"],
      ["", "Options"],
      ["a", "Pick an option"],
      ["", "Spec"],
      ["", "Spec can be built from"],
      ["a", "Approve"],
    ],
  ],
  [
    "Product",
    "Bug triage",
    [
      ["", "Understand the report"],
      ["", "Severity and next step"],
      ["", "Triage is complete"],
      ["a", "Approve"],
    ],
  ],
  [
    "Product",
    "Release notes",
    [
      ["", "What changed"],
      ["", "Release notes"],
      ["", "Verify against the list"],
      ["", "Ready to publish"],
      ["a", "Approve"],
    ],
  ],
  [
    "Marketing",
    "Launch content",
    [
      ["", "Fact sheet"],
      ["", "Three angles"],
      ["a", "Pick an angle"],
      ["", "Draft"],
      ["", "Fact-check"],
      ["", "Channel versions"],
      ["a", "Final approval"],
      ["s", "In review"],
    ],
  ],
  [
    "Marketing",
    "Campaign content pack",
    [
      ["", "Message"],
      ["", "Posts"],
      ["", "Voice and message"],
      ["a", "Approve"],
    ],
  ],
  [
    "Marketing",
    "SEO article",
    [
      ["", "Outline"],
      ["a", "Approve the outline"],
      ["", "Article"],
      ["", "SEO basics and honesty"],
      ["a", "Approve"],
    ],
  ],
  [
    "Sales",
    "Proposal",
    [
      ["", "Understand the need"],
      ["", "Write the proposal"],
      ["", "Recheck prices and totals"],
      ["", "Ready to send"],
      ["a", "Approve before sending"],
    ],
  ],
  [
    "Sales",
    "Call prep",
    [
      ["", "Account profile"],
      ["", "Call plan"],
      ["", "Facts have sources"],
    ],
  ],
  [
    "Support",
    "Customer reply",
    [
      ["", "Understand"],
      ["", "Draft the reply"],
      ["", "Policy and tone"],
      ["a", "Approve and send"],
    ],
  ],
  [
    "Support",
    "FAQ from tickets",
    [
      ["", "Group the questions"],
      ["", "Write the FAQ"],
      ["", "Answers are usable"],
      ["a", "Approve"],
    ],
  ],
  [
    "Operations",
    "Incident postmortem",
    [
      ["", "Timeline and impact"],
      ["", "Causes"],
      ["", "Postmortem"],
      ["", "Blameless and complete"],
      ["a", "Approve"],
    ],
  ],
  [
    "Operations",
    "Write an SOP",
    [
      ["", "Outline"],
      ["", "Procedure"],
      ["", "A new person could follow it"],
      ["a", "Approve"],
    ],
  ],
  [
    "Finance",
    "Budget variance",
    [
      ["", "Variance table"],
      ["", "Recompute every line"],
      ["", "Commentary"],
      ["", "Numbers and reasons hold"],
      ["a", "Approve"],
    ],
  ],
  [
    "Finance",
    "Data report in a sandbox",
    [
      ["", "Look at the files"],
      ["", "Write the analysis"],
      ["", "The analysis runs"],
      ["", "Write the report"],
      ["", "Report is sound"],
      ["a", "Approve"],
    ],
  ],
  [
    "HR",
    "Job post and interview kit",
    [
      ["", "Role scorecard"],
      ["", "Job post and interview kit"],
      ["", "Fair and lawful wording"],
      ["a", "Approve"],
    ],
  ],
  [
    "HR",
    "Onboarding plan",
    [
      ["", "30-60-90 plan"],
      ["", "Concrete and dated"],
      ["a", "Manager approves"],
    ],
  ],
  [
    "Legal",
    "Contract review",
    [
      ["", "Clause map"],
      ["", "Risks"],
      ["", "Memo with redlines"],
      ["", "Memo is careful"],
      ["a", "Legal owner decides"],
    ],
  ],
  [
    "Research",
    "Research brief",
    [
      ["", "Research plan"],
      ["", "Findings"],
      ["", "Fact-check"],
      ["", "Brief"],
      ["", "Answer first, sourced"],
      ["a", "Approve"],
    ],
  ],
];
const CATEGORIES = [...new Set(TEMPLATES.map(([c]) => c))];

function Pill({ step: [kind, title], n }: { step: Step; n: number }) {
  if (kind === "a")
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-[#f5a524]/10 px-2.5 py-1 text-xs text-[#f5a524] shadow-[0_0_0_1px_rgba(245,165,36,0.45)]">
        <Hand className="size-3" /> {title}
      </span>
    );
  if (kind === "s")
    return (
      <span className="text-ink-3 inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs shadow-[0_0_0_1px_var(--color-hair-strong)]">
        <MoveRight className="size-3" /> {title}
      </span>
    );
  return (
    <span className="bg-muted text-ink-2 inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs">
      <span className="text-ink-4 font-mono text-[10px]">{n}</span>
      {title}
    </span>
  );
}

export function WorkflowTemplates() {
  const [cat, setCat] = useState(CATEGORIES[0]);
  const shown = TEMPLATES.filter(([c]) => c === cat);
  return (
    <div className="bg-panel overflow-hidden rounded-xl shadow-[0_0_0_1px_var(--color-hair),0_30px_60px_-30px_rgba(0,0,0,0.9)]">
      <div className="border-hair flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3.5">
        <p className="text-ink text-sm font-medium">
          Workflow templates <span className="text-ink-4 ml-1 font-mono text-xs">{TEMPLATES.length}</span>
        </p>
        <p className="text-ink-3 text-xs">Copy one and edit its steps, or start from scratch</p>
      </div>
      <div role="tablist" aria-label="Template categories" className="border-hair flex gap-1 overflow-x-auto border-b px-3 py-2 [scrollbar-width:none]">
        {CATEGORIES.map((c) => (
          <button
            key={c}
            type="button"
            role="tab"
            aria-selected={c === cat}
            onClick={() => setCat(c)}
            className={`focus-visible:outline-signal shrink-0 rounded-md px-2.5 py-1 text-xs transition-colors focus-visible:outline-2 ${
              c === cat ? "bg-muted text-ink" : "text-ink-3 hover:text-ink"
            }`}
          >
            {c}
          </button>
        ))}
      </div>
      <div role="tabpanel" aria-label={`${cat} templates`}>
        <ul className="divide-hair divide-y">
          {shown.map(([, name, steps]) => {
            let n = 0;
            return (
              <li key={name} className="grid gap-3 px-5 py-4 md:grid-cols-[14rem_1fr] md:items-center">
                <p className="text-ink text-sm">{name}</p>
                <ol className="flex flex-wrap items-center gap-y-2">
                  {steps.map((st, i) => (
                    <li key={`${st[1]}-${i}`} className="flex items-center">
                      {i > 0 ? <span aria-hidden className="bg-hair-strong mx-1.5 h-px w-4" /> : null}
                      <Pill step={st} n={st[0] === "" ? ++n : 0} />
                    </li>
                  ))}
                </ol>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
