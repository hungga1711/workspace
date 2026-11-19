# ADR-0007: AI oversight via browser extension with policy levels and view log

- Status: Accepted (amended by [ADR-0027](0027-nobody-reads-prompts.md))
- Date: 2026-10-15

## Context

The owner wants to know what staff do with AI, including public tools (ChatGPT, Claude, Gemini, Copilot) used outside the company assistant, and whether it helps. Capturing employee prompts is personal-data processing (Vietnam Decree 13/2023/NĐ-CP): it needs notice, a defined purpose and proportionality, access control and retention limits. Network-level interception (TLS MITM proxies) is invasive and breaks on modern clients.

## Decision

- **Capture**: an MV3 browser extension (`frontend/browser-extension`) with host permissions only for the five AI sites. It records a prompt (and the answer only if policy says so) when the person presses send, **after** they paste a personal connection code (`aim_…`, created in Của tôi › AI; a new code revokes the old one; stored hashed). It shows a notice on every monitored page. Rollout by enterprise policy (`ExtensionInstallForcelist`) or unpacked for pilots.
- **Intake**: `POST /api/ai-monitor/events` on the gateway (code is the only credential; 120/min per code, 600/min per IP) → ai-service `internal/monitor/events`, which resolves the code to a person and records turns in `ai_conversations`/`ai_messages` with topic, one-line summary and sensitive-data flags (`backend/services/ai/src/activity.ts`, `insight.ts`). The company assistant writes to the same store (source `company`).
- **Policy** (`ai_policy`, `ai.policy.manage`): `detail` = `topic` | `summary` (default) | `full`; `captureResponses` (default off); `retentionDays` 7–730 (default 180). Policy changes notify everyone.
- **Access**: managers see their reporting line; admins see everyone; full text only for admins when policy is `full`, and **every opening is logged** in `ai_content_views`.
- **Transparency**: `GET /api/ai/oversight/me` shows each person the policy, their 30-day stats, who opened their conversations and their extension status (Của tôi › AI).
- **Retention**: hourly `ai_prune_expired` deletes conversations older than the policy across workspaces (`migrations/005_ai_retention.sql`).
- **Effectiveness**: Công việc › AI shows AI use next to task outcomes per person (work-service `outcomes.ts`), over the same 8-week window.

## Consequences

- Visibility into shadow AI with a defensible privacy posture: notice, opt-in connection, minimal default detail, logged access, bounded retention, self-service view.
- Coverage is limited to supported browsers/sites and to people who connected the extension; the oversight view can remind people who have not (`oversight/remind-extension`). Site DOM changes can break capture.
- The company is the data controller; operators must still publish an internal policy and lawful basis. The product provides mechanisms, not legal compliance.
- Sensitive-data detection is heuristic.

## Amendment 2026-11-11

[ADR-0027](0027-nobody-reads-prompts.md) removes the `full` policy level and the view log: nobody but the person
reads their prompts, and managers see the topic or the topic and the AI's one-line summary. The text above is kept
as the record of the original decision.
