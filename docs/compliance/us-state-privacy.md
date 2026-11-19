# US notes: employee data and AI monitoring

> Not legal advice. State laws change often; confirm with employment counsel for each state where people work.

## California: CCPA as amended by the CPRA

Since 1 January 2023 the employee and job-applicant exemption has expired, so California employees and contractors
have CCPA rights when the employer is a covered "business" (for example, annual revenue above the threshold, which
is adjusted for inflation, [check the current figure]).

- **Notice at collection** before or when AI Insights starts: categories collected (see
  [data-inventory.md](data-inventory.md)), purposes, retention per category, whether sold or shared (it is not).
  The employee notice template covers most of this; add the CCPA categories.
- **Rights:** to know, delete, correct, and limit use of sensitive personal information. Me › My AI gives each person a
  view, JSON export and deletion request for AI data; set a process for the rest.
- **Sensitive personal information** (for example account log-ins, government ID numbers) may appear in prompts. The
  sensitive-data net redacting or blocking these keeps you closer to "collect only what is needed".
- **Service providers:** your hosting, email and AI model providers need CCPA service-provider terms.
- **Automated decision-making** rules from the California Privacy Protection Agency may apply to tools used for
  employment decisions. AI Insights is not designed for such decisions; keep it that way and say so.

Other comprehensive state privacy laws (Virginia, Colorado, Connecticut, Texas and others) generally exclude data
processed in an employment context. Check each one you rely on.

## Electronic monitoring notice laws

Some states require written notice of electronic monitoring of employees, regardless of privacy laws:

| State | Rule | What to do |
|---|---|---|
| New York | Civil Rights Law § 52-c (since May 2022) | Written notice at hiring, acknowledged by the employee, and posted in a conspicuous place. |
| Connecticut | Gen. Stat. § 31-48d | Prior written notice of the types of monitoring; post it where employees can see it. |
| Delaware | 19 Del. C. § 705 | Notice before monitoring, acknowledged electronically or in writing, or a daily notice on log-in. |

Using the employee notice template for every US employee, with an acknowledgement, covers the common ground.

## Practical checklist

- [ ] Notice sent and acknowledged before people connect the extension
- [ ] Retention set in Admin › AI and written in the notice
- [ ] Read policy chosen (topic, or topic and summary) and written in the notice
- [ ] Process for access, deletion and correction requests, with a response time (CCPA: 45 days)
- [ ] Service-provider terms with hosting, email and AI model providers
