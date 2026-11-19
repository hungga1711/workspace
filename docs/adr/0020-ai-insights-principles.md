# ADR-0020: AI Insights principles

- Status: Accepted (extends [ADR-0007](0007-ai-oversight-extension-transparency.md) and
  [ADR-0011](0011-ai-usage-linked-to-work.md); principle 4 amended by [ADR-0027](0027-nobody-reads-prompts.md))
- Date: 2026-10-25

## Context

AI Insights is the feature workspace leads with: what a team does with AI, with what data, and whether the work gets
done better. The same data, built carelessly, is employee surveillance. Monitoring software that captures screens,
keystrokes and idle time is common, widely resented, and in many places legally risky. Staff who feel watched stop
using the company's tools and use AI where nobody can see it, which defeats the purpose.

So the rules below are product decisions, not settings. A change that breaks one of them needs a new ADR.

## Decision

1. **Consent before recording.** AI Insights is off by default (`features.ai.monitoring`). Nothing is recorded
   until an admin turns it on and each person connects the browser extension with their own code. Every page the
   extension records shows a notice. Recording happens only when the person presses send.
2. **Staff see everything about themselves.** Me › AI shows each person every conversation recorded about them,
   their sensitive-data warnings, their safety-net counts, which tasks their AI use is linked to, and every time
   someone opened their full text. They can export all of it as JSON and ask for it to be deleted.
3. **No screenshots, no keystroke counting, no idle or activity timers, no browsing history.** The extension runs
   only on listed AI chat sites, reads only the prompt being sent (and the answer, if the policy says so), and
   ignores everything else.
4. **Managers see what the company policy allows, and opening full text is audited.** The policy (`ai_policy.detail`)
   is `topic`, `summary` (default) or `full`. Managers see their reporting line, admins everyone. Full text needs
   policy `full` and admin rights; every opening is written to `ai_content_views` and shown to the person.
   Safety-net records (`ai_safety_events`) hold who, where, what kind and how many, never the text that was
   redacted or blocked.
5. **Data never leaves the company's server.** Prompts are stored in the company's own database. workspace sends
   nothing to its authors or any third party. Topic classification and sensitive-data detection run locally
   without a model; summaries and model-based topics use only the AI connection the company configured, in an
   hourly batch, and can be left off.
6. **Off by default, and removable.** Admins can switch it off (installed extensions then send nothing) and delete
   all recorded data in one action. Retention is bounded (7–730 days, default 180).
7. **Useful to the person first.** Me › AI is built as something staff want to open: what they used AI for this
   week, which tasks it helped and how much faster they finished, their own warnings, and a one-tap "Did AI help?".
   Feedback, task links and shared prompts are the person's actions; nothing is attributed to them silently.
8. **Correlation, said plainly.** "Tasks done with AI help" compares outcomes; the UI says it is a correlation and
   keeps the per-person view next to it. There is no productivity score. The skills map (Work › AI) points
   managers to people whose AI use others could learn from (frequent use rated "helped"); it is a list of possible
   mentors, not a league table, and it never counts against anyone.

## Consequences

- The feature can be explained to staff on one page (`docs/ai-insights/templates/`), which makes rolling it out
  easier and keeps the company's notice honest.
- Some things owners ask for are refused by design: silent recording, screen capture, per-person productivity
  scores, reading full text without a trace.
- Coverage is limited to people who connected the extension and to supported sites; the company AI and imports from
  AI vendors' admin consoles fill part of the gap.
- The company remains the data controller and must still publish a notice and a lawful basis; the product provides
  the mechanisms, not legal compliance.

## Amendment 2026-11-11

[ADR-0027](0027-nobody-reads-prompts.md) removes the `full` policy level and the view log: nobody but the person
reads their prompts, and managers see the topic or the topic and the AI's one-line summary. The text above is kept
as the record of the original decision.
