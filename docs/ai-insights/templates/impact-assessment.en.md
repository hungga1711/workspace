# Impact assessment: AI Insights

> Template for a personal-data impact assessment (Vietnam: the impact assessment dossier for personal-data processing
> under Decree 13/2023/NĐ-CP, Art. 24; EU: a data protection impact assessment under GDPR Art. 35, read with Art. 88
> for the employment context). Not legal advice. The answers pre-filled below describe how workspace works; check
> them against your configuration and fill in every `[bracket]`.

**Controller:** [company], [address] · **Contact:** [name, e-mail] · **Prepared by:** [name] · **Date:** [date]

## 1. Description of the processing

| Item | Answer |
|---|---|
| Purpose | Protect company and customer data from leaking into AI tools; manage approved AI tools and their cost; learn whether AI helps work get done. |
| Not a purpose | Scoring or ranking individual performance; monitoring activity outside AI tools. |
| People concerned | Employees and contractors who connect the extension or use the company AI in workspace: [number]. |
| Data | Prompts sent on listed AI sites; answers only if `capture responses` is on ([yes/no]); site, model, time; topic; kinds of sensitive data found; task links; "Did AI help?" answers; sensitive-data filter counts (no text); a one-line summary written by AI. |
| Possibly special categories | Prompts may contain health, union or other sensitive data typed by staff. Mitigated by the sensitive-data filter and access limits (section 4). |
| Source | The person (browser extension after they connect it; the company AI in workspace); imports from AI vendors' admin consoles if used ([yes/no]). |
| Recipients | The person; their managers at policy level [topic/summary]; admins [roles] at the same level; nobody but the person reads the prompt text. No third party. [Model provider for summaries, if connected: name, agreement.] |
| Storage location | Company server [location, operator]; Postgres `ai` schema; backups [where]. |
| Retention | [180] days (configurable 7–730), deleted hourly after that. |
| Transfer abroad | [None / to the model provider in [country] for summaries only]. |

## 2. Necessity and proportionality

- Less intrusive options considered: training only, blocking AI sites, network inspection. [Why AI Insights instead,
  e.g. blocking pushes use to personal devices; network inspection reads all traffic.]
- Minimisation: only listed AI sites; only on send; answers off by default; managers see topic or summary by default;
  sensitive text redacted or blocked is never stored.
- Transparency: notice on every recorded page; notice to employees [link]; Me › My AI shows each person all their data
  and exactly what managers see.
- Lawful basis: [consent under Decree 13 Art. 11 / other basis — confirm]. If consent: it must be freely given; state
  what happens if someone does not connect the extension: [no consequence / company AI only].
- Employment safeguards (GDPR Art. 88): no use for performance scoring or as the only basis for discipline;
  [works council / staff representatives consulted on date].

## 3. Risks to people

| Risk | Likelihood | Severity | Notes |
|---|---|---|---|
| Staff feel watched and avoid or hide AI use | [ ] | [ ] | |
| Manager reads personal content in prompts | [ ] | [ ] | |
| Prompt data used against a person in evaluation | [ ] | [ ] | |
| Breach of the workspace server exposes prompts | [ ] | [ ] | |
| False positives in sensitive-data detection block legitimate work | [ ] | [ ] | |
| Data kept longer than needed | [ ] | [ ] | |

## 4. Measures

| Measure | In place |
|---|---|
| Off by default; per-person connection code; notice on every recorded page | built in |
| Detail level for managers `topic` / `summary` (one line written by AI); nobody but the person reads prompt text | built in; our level: [ ] |
| Safety net mode [warn/redact/block] and company keyword list | configured: [ ] |
| Self-service view, export (JSON) and deletion request in Me › My AI | built in |
| Retention [180] days, automatic deletion; delete-all switch for admins | built in |
| Access control by role and reporting line, checked by the server on every request; the AI module's database role reaches only its own schema | built in |
| Server hardening, encrypted backups, access log review | [ ] |
| Written rule that AI Insights data is not used for scoring people | [policy link] |
| Training for managers on what they may and may not do with the data | [ ] |

## 5. Outcome

Residual risk: [low / medium / high]. Decision: [proceed / proceed with changes / do not proceed].
Approved by: [name, role, date]. Next review: [date].
