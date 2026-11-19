# DPIA for AI Insights (EU and UK)

> Not legal advice. Use with the full [impact assessment template](../ai-insights/templates/impact-assessment.en.md),
> which describes how workspace processes the data. Have your DPO or counsel review the result.

**Controller:** [company] · **DPO / contact:** [name] · **Prepared by:** [name] · **Date:** [date] · **Next review:** [date]

## 1. Is a DPIA required?

GDPR Art. 35 requires a DPIA when processing is likely to result in a high risk. The EDPB guidelines (WP248 rev.01)
list criteria; two or more usually mean a DPIA is needed. For AI Insights:

| Criterion | Applies? | Why |
|---|---|---|
| Systematic monitoring | Yes | Prompts on AI sites are recorded over time. |
| Vulnerable data subjects | Yes | Employees, because of the power imbalance with the employer. |
| Innovative use of technology | Likely | Browser extension, AI summaries and topic classification. |
| Sensitive data | Possible | Staff may type health, union or other special-category data into prompts. |
| Evaluation or scoring | No, if configured as documented | AI Insights is not used to score individuals; say so in the notice and keep it true. |

**Conclusion:** [a DPIA is carried out before switching on]. Many national authorities include employee monitoring
in their mandatory DPIA lists.

## 2. Legal basis

- **Art. 6(1)(f), legitimate interest** is the usual basis: protecting company and customer data, managing AI tools
  and cost, improving how work is done. Record the balancing test below.
- **Consent** is rarely valid for employees (EDPB Guidelines 05/2020 on consent, section 3.1.1): do not rely on it.
- **Art. 88** and national employment rules may add conditions (for example, a works agreement in Germany); see
  [works-council-eu.md](works-council-eu.md).
- Special-category data in prompts is not a purpose. Minimise it with the sensitive-data net set to redact or block,
  and say in the notice that it must not be typed.

## 3. Legitimate interest balancing test

| Question | Answer |
|---|---|
| What is the interest? | [Data protection, cost control, knowing whether AI helps work] |
| Is the processing necessary for it? | [Why less intrusive means are not enough: training alone, blocking AI sites, network inspection] |
| What would staff reasonably expect? | [Notice given before; extension connected by each person; notice shown on recorded pages] |
| Impact on staff | [Fear of being watched; mitigated by topic/summary-only manager view, self-view of all data, logging of every full-text opening, no individual scoring] |
| Safeguards | Read policy at [topic/summary]; answers not captured; retention [180] days; redaction [on]; access logs reviewed [monthly] |
| Outcome | [Interest not overridden, with the safeguards above] |

## 4. Risks and measures

| Risk | Likelihood / severity | Measures in workspace | Residual |
|---|---|---|---|
| Staff feel watched; chilling effect | [ ] | Self-view (Me › My AI) showing exactly what managers see, manager sees topic or summary only, nobody reads prompts, notice on every recorded page | [ ] |
| Prompt text reveals special-category data | [ ] | Sensitive-data net (warn / redact / block), answers off by default, retention limit | [ ] |
| Use for performance evaluation | [ ] | Purpose limitation in the notice and policy; no per-person scores in the product; works agreement | [ ] |
| Unauthorised access | [ ] | Role permissions, 2FA policy, audit log, self-hosted database | [ ] |
| Transfer outside the EEA/UK | [ ] | Self-hosted in [region]; model provider [none / EU region / SCCs] | [ ] |
| Data kept too long | [ ] | Hourly deletion after [180] days; side tables 365 days | [ ] |

## 5. Sign-off

DPO advice: [ ] · Staff representatives consulted: [date, outcome] · Decision: [ ] · Signed: [name, role, date]
