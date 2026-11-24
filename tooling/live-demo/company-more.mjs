/**
 * The rest of the live demo's company (company.mjs): what the owner works on, what they asked the AI and what it
 * answered, whiteboards, files, agent runs. Read by seed-extra.mjs; {{title start}} becomes a task's code.
 */

/** The owner's own work: [title, status, priority, due (days), project, labels, description, comments]. */
export const OWNER_TASKS = [
  [
    "Approve the launch post",
    "todo",
    "high",
    1,
    "campaign",
    ["content", "decision"],
    "Draft 2 is on the *Launch post, draft 2* page. Claire needs a yes or a list of changes by tomorrow, the translators start on Wednesday.\n\n## Check\n- [x] Opens with Marta, not with us\n- [x] 24 seconds in the first paragraph\n- [ ] The honest paragraph about what is not in 2.0\n- [ ] Read it once on a phone",
    [["trinh", 3, "Only the ending changed since you read it. Four minutes, promised ☕"]],
  ],
  [
    "Decide who pays card fees in the portal",
    "in_progress",
    "urgent",
    2,
    "portal",
    ["decision", "payments"],
    "Meeting on Wednesday at 10:00. Lena recommends **cards at cost + 0.3%, bank transfer always free**.\n\n| Model | 40 invoices a month | 1,100 invoices a month |\n| --- | --- | --- |\n| A. We pay all | €0 | €0 (costs us €610) |\n| B. Cost + 0.3% | €9 | €310 |\n| C. Flat €19 | €19 | €19 |\n\n## Open\n- [x] Legal note read\n- [ ] Ask Sam what Lakeshore Logistics expects\n- [ ] Tell Yuki, the pricing page waits for the number",
    [["lena", 20, "One number to remember: 71% of our customers send fewer than 60 invoices a month. For them B costs less than a coffee a week."]],
  ],
  [
    "Prepare the go/no-go: one page, yes or no",
    "in_progress",
    "high",
    3,
    "mobile",
    ["release"],
    "Thursday 15:00. Everybody answers three questions before the meeting: what is open, what happens if we wait a week, what would make you stop.\n\n- [x] Minh: engineering\n- [x] Sam: support\n- [ ] Claire: press and film\n- [ ] Crash rate of build 2.0.0 (418) after 48 hours",
    [["minh", 5, "My half is in: yes, if the camera crash stays under 0.1% until Thursday noon."]],
  ],
  [
    "Board update for November",
    "in_progress",
    "medium",
    4,
    null,
    ["board"],
    "Two pages, numbers first.\n\n1. 18,400 paying companies, +112 last week\n2. Mobile 2.0: date, risks, plan B\n3. Billing portal: why there is no login\n4. Budget 2027: three scenarios, one recommendation\n\nLena sends the numbers on Wednesday.",
    [],
  ],
  [
    "Call Lakeshore Logistics about the pilot",
    "todo",
    "medium",
    2,
    "portal",
    ["customers"],
    "40 clients, 4 weeks, start in December. They asked for a Sunday night migration and a name to call.\n\n- [ ] Agree on the start date\n- [ ] Who calls whom when something breaks\n- [ ] May we name them in the launch post?",
    [["sam", 2, "They are calm again. Ask for Greta, she decides."]],
  ],
  [
    "Interview: second mobile engineer, round 2",
    "todo",
    "medium",
    4,
    null,
    ["hiring"],
    "Three candidates, 45 minutes each, with Minh and Daniel. Ask about a release that went wrong and what they changed after it.",
    [],
  ],
  [
    "Answer the journalist: call on release day, 10:00",
    "todo",
    "low",
    7,
    "campaign",
    ["press"],
    "Claire said yes for us. Three sentences ready: who it is for, what changed, what is not in 2.0.",
    [],
  ],
  ["Read the postmortem of October 14 with the team", "done", "medium", -1, null, ["how-we-work"], "Read together on Friday. Two follow-ups agreed, both have an owner.", []],
  ["Sign the payment provider contract", "done", "high", -4, "portal", ["payments"], "Signed on both sides. Saves about €14,000 a year.", []],
  ["Feedback on the film, second cut", "done", "medium", -2, "campaign", ["video"], "Two shots to change, the music stays.", []],
];
/** Existing tasks the owner handed out ("Assigned by me"). */
export const OWNED = [
  "Decide: keep version 1",
  "Payment fees",
  "Write the launch post",
  "Beta feedback",
  "Pilot with Lakeshore",
  "Press kit",
  "Customer film",
  "Tap to pay",
  "Automatic payment reminders",
];

const t = (start) => ({ task: start });
const bars = (title, unit, rows, series) => ({ kind: "chart", id: title, title, chart: "bars", unit, ...(series ? { series } : {}), rows });
const table = (title, columns, rows) => ({
  kind: "table",
  id: title,
  title,
  columns: columns.map((label, i) => ({ key: `c${i}`, label, ...(i && rows.every((r) => typeof r[i] === "number") ? { num: true } : {}) })),
  rows: rows.map((r) => ({ cells: Object.fromEntries(r.map((v, i) => [`c${i}`, v])) })),
});

/**
 * What the owner asked the company's AI, with the answers: [hours ago, topic, helpful, turns]. A turn is
 * [question, answer, { blocks, sources, steps, next }]. The questions the app suggests (its "Try" chips, the Home box)
 * are all here word for word: in the demo the browser answers them from these (runtime.js).
 */
export const ASK = [
  [
    1.2,
    "planning",
    "yes",
    [
      [
        "What needs my attention today?",
        `**Four things, most urgent first.**

1. **Three requests wait for you**, the oldest for two days: six test phones (€2,140, the quote ends on Friday), launch week ads (€9,500) and extra support for two weeks (€3,360). Together **€15,000**.
2. **Claire needs an answer on the launch post** by tomorrow. Draft 2 is ready; the translators start on Wednesday.
3. **Noah is stuck twice.** The accounting export ({{Accounting export}}) has waited for DATEV access since November 12, and the Android certification is past its date. A call from you to DATEV would probably move the first one.
4. **Minh asked you in #mobile-2-0** how long version 1 stays alive. Priya recommends until June 30, and Sam and Noah agree.

Your next meeting is the **Billing portal design review at 15:30**.`,
        {
          steps: ["Reading what waits for you", "Reading late and blocked tasks", "Reading your mentions"],
          sources: [t("Accounting export"), t("Decide: keep version 1"), t("Write the launch post"), { project: "mobile" }],
          blocks: [
            table(
              "Waiting for your decision",
              ["Request", "From", "Amount (€)", "Days"],
              [
                ["Six test phones for the device lab", "Daniel Okafor", 2140, 2],
                ["Extra support for the first two weeks", "Sam Rivera", 3360, 1],
                ["Launch week ads, EU and UK", "Claire Dubois", 9500, 0],
              ],
            ),
          ],
          next: ["What happens if I say no to the ads?", "Write a message to DATEV asking for access"],
        },
      ],
      [
        "What happens if I say no to the ads?",
        `The launch still happens, with a smaller first week.

- **What you lose:** about a third of the 400 sign-ups Claire plans for week one. The other two thirds come from email, the stores and press, and those cost nothing extra.
- **What you keep:** €9,500, and the option to start later. The ads have a stop rule: if a sign-up costs more than €38 after three days, they end.
- **Middle way:** approve the **UK and Germany only (€4,200)** and decide about the rest on December 10 with real numbers.

I would take the middle way. Claire's plan works with it, only the date of France and Spain moves.`,
        { sources: [{ project: "campaign" }], next: ["Write Claire a two-line answer with the middle way"] },
      ],
    ],
  ],
  [
    2.4,
    "planning",
    "yes",
    [
      [
        "Who on my team is overloaded, and who has room?",
        `**Noah is overloaded. Lena, Minh and Priya have room.**

- **Noah Becker** holds 9 open tasks, 2 late and 1 blocked. Two of them are on the release path.
- **Daniel Okafor** and **Claire Dubois** hold 6 each. Daniel has 5 in progress at once, which is the real problem: nothing of his can finish this week unless something waits.
- **Yuki Tanaka** is fine on paper, but one task is blocked by the fee decision on Wednesday.

**What I would move:** the SEPA QR code from Noah to Ana, who built the payment screen it sits on, and Noah's reminders task to after the release.`,
        {
          steps: ["Reading open work per person", "Reading late and blocked tasks"],
          sources: [t("Accounting export"), t("Automatic payment reminders")],
          blocks: [
            bars("Open tasks per person", "", [
              { label: "Noah Becker", value: 9, highlight: true },
              { label: "Daniel Okafor", value: 6 },
              { label: "Claire Dubois", value: 6 },
              { label: "Ana Silva", value: 5 },
              { label: "Sam Rivera", value: 4 },
              { label: "Yuki Tanaka", value: 4 },
              { label: "Priya Nair", value: 3 },
              { label: "Minh Tran", value: 2 },
              { label: "Lena Fischer", value: 1 },
            ]),
          ],
          next: ["What exactly could move from Noah this week?", "Write this week's progress report for my team"],
        },
      ],
      [
        "What exactly could move from Noah this week?",
        `Three things, about two days of work:

| Task | Move to | Why it works |
| --- | --- | --- |
| SEPA QR code | Ana | She built the screen; the bank details are already in the API |
| {{Automatic payment reminders}} Automatic payment reminders | Stays with Noah, after December 7 | Nothing waits for it |
| Second migration dry run, comparing results | Minh | He wrote the comparison script |

That leaves Noah with **tap to pay certification** and **secure links**, the two nobody else can do.`,
        { sources: [t("Automatic payment reminders"), t("Tap to pay"), t("Secure links")], next: ["Write Noah a short message about this"] },
      ],
    ],
  ],
  [
    4,
    "planning",
    "yes",
    [
      [
        "Plan my day: what should I do first, given what is late and what is due today?",
        `Nothing of yours is late. Here is a day that unblocks the most people first.

| When | What | Who it frees |
| --- | --- | --- |
| **Now, 20 min** | Decide the three requests | Daniel, Sam, Claire |
| **13:30, 30 min** | Read the launch post on your phone ({{Approve the launch post}}) | Claire, the translators |
| **14:15, 30 min** | Go/no-go page: ask Claire for her half ({{Prepare the go/no-go}}) | Thursday's meeting |
| **15:30** | Billing portal: design review | Yuki, Ana |
| **16:45** | Mobile 2.0 daily: ask for the crash rate | Minh |

Leave the board update for tomorrow. Lena's numbers come on Wednesday anyway.`,
        {
          steps: ["Reading your open tasks", "Reading your calendar", "Reading requests"],
          sources: [t("Approve the launch post"), t("Prepare the go/no-go"), t("Decide who pays card fees")],
          next: ["What needs my attention today?", "Which of my tasks are late, and what should I do about each one?"],
        },
      ],
    ],
  ],
  [
    74,
    "planning",
    "yes",
    [
      [
        "Which of my tasks are late, and what should I do about each one?",
        `**None of your own tasks is late.** Three in your team are, and each has a clear next step:

1. **Accounting export** ({{Accounting export}}, Noah). Waits for DATEV since November 12. *Next:* you call the partner manager, Noah ships Xero and CSV first.
2. **Provider certification: Android** (Noah). One log file is missing. *Next:* Lena has the contact; a nudge today is enough.
3. **Beta feedback** ({{Beta feedback}}, Sam). 198 of 212 answered. *Next:* nothing to decide, Sam finishes tomorrow.

Coming up for you: card fees and the Lakeshore call, both on Wednesday.`,
        {
          steps: ["Reading your open tasks", "Reading late tasks in your team"],
          sources: [t("Accounting export"), t("Beta feedback")],
          next: ["Who on my team is overloaded, and who has room?"],
        },
      ],
    ],
  ],
  [
    68,
    "writing",
    "yes",
    [
      [
        "Write this week's progress report for my team",
        `## Week 47 at Sunrise

**In one line:** Mobile 2.0 is on track for December 7 with one real risk, the billing portal is waiting for one decision.

### Done (18 tasks)
- Plan B for tap to pay written down on one page
- Build pipeline from 34 to 11 minutes
- Film: second cut approved except two shots
- First answer in support: **98 minutes**, a year ago five hours

### At risk
- **Camera crash on Android 12.** Fix in review, needs 48 hours without a crash.
- **Accounting export.** Blocked by DATEV since November 12.

### Next week
1. Card fees: decide on Wednesday
2. Go/no-go on Thursday, 15:00
3. Submit to both stores on Monday

*Everyone finished at least one task this week.*`,
        {
          steps: ["Reading finished work, 7 days", "Reading late and blocked tasks", "Reading decisions"],
          sources: [{ project: "mobile" }, { project: "portal" }, { project: "campaign" }],
          blocks: [
            bars(
              "Tasks done, this week and last",
              "",
              [
                { label: "Product & Marketing", value: 8, compare: 4 },
                { label: "Engineering", value: 7, compare: 4 },
                { label: "Customer Success & Finance", value: 3, compare: 1 },
              ],
              ["This week", "Last week"],
            ),
          ],
          next: ["Make it shorter, five lines for the board", "Does AI use go with more work done on my team?"],
        },
      ],
      [
        "Make it shorter, five lines for the board",
        `- **Mobile 2.0** ships December 7. One risk: a camera crash on Android 12, decision on Thursday.
- **Tap to pay** is certified on iOS, Android is one file away. Plan B exists.
- **Billing portal:** no login, by customers' request. Card fees are decided on Wednesday.
- **18 tasks done**, nine the week before. Three late, all with an owner.
- **18,400 paying companies**, +112 in the week. Support answers in 98 minutes.`,
        { next: ["Plan my day: what should I do first, given what is late and what is due today?"] },
      ],
    ],
  ],
  [
    70,
    "data",
    "yes",
    [
      [
        "Does AI use go with more work done on my team?",
        `**It goes with faster work, not clearly with more of it.**

Over 90 days, tasks done with AI took **1.5 days** (median) against 3.5 without, and **91%** were on time against 74%. Eight of ten people use it.

Be careful with the reading: people choose AI for tasks that suit it, such as drafts, tests and translations. That alone explains part of the difference.

**Where it helps most here:** support replies and test writing. **Where it does not:** design reviews and anything with the payment provider.

Two people have not started. A shared prompt would cost them five minutes.`,
        {
          steps: ["Reading finished work, 90 days", "Reading AI use per person"],
          blocks: [
            table(
              "Tasks done with and without AI, 90 days",
              ["", "With AI", "Without"],
              [
                ["Days to done, median", 1.5, 3.5],
                ["On time, %", 91, 74],
                ["Tasks", 23, 38],
              ],
            ),
          ],
          sources: [],
          next: ["Who has not used AI yet, and what would help them?", "Who on my team is overloaded, and who has room?"],
        },
      ],
      [
        "Who has not used AI yet, and what would help them?",
        `Two people have no AI use recorded in the last 30 days. I would not read anything into it: both finished their work on time.

What usually helps is one good example from their own work:

- **For finance:** "Compare these two payout files and list the rows that differ." Lena does this by hand every month.
- **For support:** "Turn these five answers into one saved reply, plain words, no promises."

Both are in the **prompt library**, ready to copy. Show one in Friday's demo rather than sending a link.`,
        { next: [] },
      ],
    ],
  ],
  [
    72,
    "planning",
    "yes",
    [
      [
        "Sum up my progress this week: what's done, what's late and what to do next.",
        `**Done:** payment provider contract signed, film feedback given, postmortem read with the team.

**Late:** nothing.

**In progress:** card fees, the go/no-go page and the board update. The go/no-go page is the one others wait for.

**Next, in this order:**
1. {{Approve the launch post}} Approve the launch post (20 minutes)
2. {{Prepare the go/no-go}} Finish your half of the go/no-go page
3. {{Call Lakeshore}} Call Lakeshore Logistics, ask for Greta`,
        {
          steps: ["Reading your tasks", "Reading what waits for you"],
          sources: [t("Approve the launch post"), t("Prepare the go/no-go"), t("Call Lakeshore")],
          next: ["Plan my day: what should I do first, given what is late and what is due today?"],
        },
      ],
    ],
  ],
  [
    5 * 24 + 3,
    "writing",
    "yes",
    [
      [
        "Make a 5-slide deck introducing our project",
        `Here is the deck for **Sunrise Mobile 2.0**, one idea per slide.

**1. Finish the job, send the invoice, get paid.**
Before you are back in the van. *Picture: Marta at the van door.*

**2. The problem**
One in three customers works without signal. 41 of the last 120 one-star reviews say so.

**3. What changes**
- An invoice in **24 seconds**, it was 1:48
- Works offline, nothing is lost
- A card on the phone, no reader

**4. Proof**
30 companies, five weeks, 212 reports answered by a person. Crash-free sessions 98.4%.

**5. When**
December 7, in steps: 5%, 25%, 100%. What is *not* in 2.0: card payments offline.`,
        {
          steps: ["Reading the project", "Reading the press kit"],
          sources: [{ project: "mobile" }, { doc: "Press kit" }, { doc: "Mobile 2.0 release plan" }],
          next: ["Write speaker notes, two sentences per slide"],
        },
      ],
      [
        "Write speaker notes, two sentences per slide",
        `1. Say the sentence and stop. Let them look at Marta.
2. Ask who has been in a basement without signal today. Then show the number.
3. Do it live: open the app, count to 24. If it goes wrong, laugh and do it again.
4. These are real companies, and a person answered each report. Name one that changed the product.
5. The date is firm, the steps protect our customers. Say what is missing before somebody asks.`,
        { next: [] },
      ],
    ],
  ],
  [
    6 * 24 + 2,
    "research",
    "yes",
    [
      [
        "Find the documents about our leave policy",
        `One page covers it: **Leave, sick days and travel**, by Lena.

- **25 days** a year, five can move to the next one
- Sick: tell your manager by 10:00, a note from day four
- **Two people of one team are not away in a release week**

The last line matters now: two requests for the end of December are open, Yuki (family visit) and Daniel (holidays). They are in different teams, so the rule is kept.`,
        {
          steps: ["Searching documents", "Reading leave requests"],
          sources: [{ doc: "Leave, sick days and travel" }, { doc: "How we work at Sunrise" }],
          next: ["Who is away during the release week?"],
        },
      ],
      [
        "Who is away during the release week?",
        `In the week of **December 7**: Ana, two days after the conference. She is not on the release path and Daniel covers her screens.

Everybody else is in. Lena is away this Friday only.`,
        { next: [] },
      ],
    ],
  ],
  [
    7 * 24 + 4,
    "writing",
    "partly",
    [
      [
        "Write a short quotation email to a customer",
        `**Subject:** Your quote: billing portal pilot, 40 clients

Hello Greta,

thank you for the call. Here is what we agreed:

- **Pilot:** 40 of your clients, four weeks, start in December
- **Price:** free during the pilot; afterwards cards at cost + 0.3%, bank transfer always free
- **Migration:** on a Sunday night, Sam is on the phone the whole time

The quote is valid until December 18. A short yes by email is enough.

Best regards,
Alex`,
        { sources: [t("Pilot with Lakeshore")], next: ["Make it warmer, and leave the fee open until Wednesday"] },
      ],
      [
        "Make it warmer, and leave the fee open until Wednesday",
        `**Subject:** Good to talk, and what happens next

Hello Greta,

I enjoyed our call, and I am glad Sam could help with the numbers.

So we start in December with 40 of your clients, for four weeks, free of charge. We move you on a Sunday night and Sam stays on the phone until it is done.

One thing is still open on our side: the card fee after the pilot. We decide on Wednesday, and you hear it from me the same day. Bank transfers stay free, whatever we decide.

Have a calm week,
Alex`,
        { next: [] },
      ],
    ],
  ],
  [
    10 * 24,
    "planning",
    "yes",
    [
      [
        "Should we delay Mobile 2.0 by a week?",
        `**Not today. Decide on Thursday with one number.**

| | Release December 7 | Wait until December 14 |
| --- | --- | --- |
| Camera crash | Fixed, 48 hours of proof | Nine days of proof |
| Tap to pay on Android | Maybe plan B | Certified |
| Press | 4 journalists confirmed | Two would drop it |
| Support | Rota is set | Into the holidays |

A week buys certainty for a problem that looks solved, and costs the press and a holiday rota.

**Stop rule:** more than 0.1% of sessions crash on Thursday noon → wait. Otherwise go. Any one person can stop the rollout at 5%.`,
        {
          steps: ["Reading the project", "Reading the release plan", "Reading meeting notes"],
          sources: [{ doc: "Mobile 2.0 release plan" }, t("Crash on Android 12"), t("Tap to pay")],
          next: ["What is plan B for tap to pay?"],
        },
      ],
      [
        "What is plan B for tap to pay?",
        `Release on Android **without** tap to pay and switch it on two weeks later with a feature flag. iOS keeps it from day one.

- Nothing to resubmit: the flag is already in the build
- The store text for Android needs one sentence less; Yuki has both versions
- Support knows the answer: "It comes to your phone before the end of the year"

Nobody likes plan B, everybody accepts it (company weekly).`,
        { sources: [t("Tap to pay")], next: [] },
      ],
    ],
  ],
  [
    12 * 24 + 2,
    "research",
    "yes",
    [
      [
        "Summarise the 12 client interviews in five lines",
        `1. **They pay when they find it.** Finding the invoice is the problem, not paying it.
2. **Nine of twelve** pay from the phone, mostly in the evening.
3. **Seven of twelve** mistyped an IBAN at least once.
4. **Nobody** wants another account. Hence no login.
5. **Five of twelve** like reminders, if they are friendly.

What changed because of it: a safe link, the amount on the button, bank transfer first in Germany and cards in the UK.`,
        { steps: ["Reading a document"], sources: [{ doc: "Interviews: what 12 clients told us" }, { doc: "Billing portal: one-page brief" }], next: [] },
      ],
    ],
  ],
];

/** The Drive: [folder or null, name, content type, KB, who, days ago, starred]. */
export const FILES = [
  ["Launch", "Launch calendar T-14 to T+14.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", 48, "trinh", 2, true],
  ["Launch", "Marta film, second cut.mp4", "video/mp4", 184_320, "trinh", 3, false],
  ["Launch", "Press kit 2.0.zip", "application/zip", 41_800, "trinh", 5, false],
  ["Launch", "Store screenshots EN.png", "image/png", 2_140, "yuki", 1, true],
  ["Launch", "App icon 2.0.svg", "image/svg+xml", 12, "yuki", 20, false],
  ["Mobile 2.0", "Beta report week 5.pdf", "application/pdf", 1_310, "sam", 4, true],
  ["Mobile 2.0", "Crash report build 418.csv", "text/csv", 220, "quang", 1, false],
  ["Mobile 2.0", "Certification evidence iOS.pdf", "application/pdf", 3_900, "noah", 8, false],
  ["Mobile 2.0", "Migration dry run 1, differences.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", 96, "noah", 5, false],
  ["Billing portal", "Payment fees, three models.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", 64, "lena", 3, true],
  ["Billing portal", "Interview recordings.zip", "application/zip", 512_000, "phong", 18, false],
  ["Billing portal", "Portal design v4.pdf", "application/pdf", 8_700, "yuki", 2, false],
  ["Finance", "Budget 2027, draft 1.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", 120, "lena", 11, false],
  ["Finance", "Payment provider contract, signed.pdf", "application/pdf", 780, "lena", 4, false],
  [null, "Board update October.pdf", "application/pdf", 940, "owner", 26, false],
  [null, "Company presentation 2026.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", 6_200, "owner", 40, true],
];
export const FOLDERS = { Launch: "trinh", "Mobile 2.0": "minh", "Billing portal": "phong", Finance: "lena" };

/** Whiteboards: { title, by, project, days ago, columns [[heading, color, [notes]]] } or { nodes, edges }. */
export const BOARDS = [
  {
    title: "Beta retrospective: five weeks, 30 companies",
    by: "phong",
    project: "mobile",
    days: 4,
    folder: "Mobile 2.0",
    columns: [
      ["Went well", "#ECFDF5", ["24 seconds: everyone saw it", "A person answered each report", "Low-end phones in the lab", "Plan B on one page"]],
      ["To improve", "#FEF0F0", ["Camera crash found late", "Reports in three places", "Too many conflict screens"]],
      ["Try next", "#E6EEFE", ["Crash rate in the daily", "One inbox for beta reports", "Ask only when the amount differs"]],
    ],
  },
  {
    title: "Pay an invoice: from email to receipt",
    by: "yuki",
    project: "portal",
    days: 1,
    folder: "Billing portal",
    nodes: [
      ["mail", 400, 0, "Invoice email"],
      ["link", 400, 170, "Safe link, no login"],
      ["how", 400, 340, "How to pay?", "diamond"],
      ["card", 60, 560, "Card"],
      ["bank", 400, 560, "Bank transfer + QR"],
      ["wallet", 740, 560, "Apple Pay"],
      ["done", 400, 740, "Receipt by email"],
    ],
    edges: [
      ["mail", "link"],
      ["link", "how"],
      ["how", "card"],
      ["how", "bank"],
      ["how", "wallet"],
      ["card", "done"],
      ["bank", "done"],
      ["wallet", "done"],
    ],
  },
  {
    title: "Launch week, who does what",
    by: "trinh",
    project: "campaign",
    days: 2,
    folder: "Launch",
    columns: [
      ["Before", "#FEF3C7", ["Email wave 1 ready", "Film on the site", "Press embargo until 9:00"]],
      ["December 7", "#E6EEFE", ["5% at 8:00", "Post and newsletter 9:00", "Alex: press call 10:00", "Sam: rota until 22:00"]],
      ["After", "#ECFDF5", ["25% on day 2", "Webinar on the 9th", "Retro on the 18th"]],
    ],
  },
  {
    title: "2027: what we could build",
    by: "owner",
    project: null,
    days: 8,
    folder: null,
    columns: [
      ["Ideas", "#FEF3C7", ["Recurring invoices", "Expense photos", "Quotes that become invoices"]],
      ["Asked for most", "#E6EEFE", ["Accounting export", "Teams of 5 and more", "Deposit before the job"]],
      ["Not now", "#F4F4F5", ["Payroll", "Own card reader"]],
    ],
  },
];

/** Messages the owner kept for later: [channel, text contains]. */
export const SAVED = [
  ["mobile-2-0", "how long do we keep version 1"],
  ["launch", "wants a call with"],
  ["general", "Numbers of the week"],
  ["mobile-2-0", "Status for everyone"],
];

export const HOLIDAYS = [
  ["2026-12-25", "Christmas Day"],
  ["2026-12-26", "Boxing Day"],
  ["2027-01-01", "New Year's Day"],
];

/** Company AI topics carry one language in the demo. */
export const TOPIC_LABELS = "UPDATE ai.ai_topics SET label_vi = label_en WHERE NOT builtin;";

/** Agent runs: [workflow template, task title start, who, hours ago it started, status, { step key: output }, minutes]. */
export const RUNS = [
  [
    "launch-content",
    "Write the launch post",
    "trinh",
    94,
    "waiting_approval",
    {
      facts:
        "- Mobile 2.0 is released on December 7, in steps (release plan)\n- An invoice takes 24 seconds, it was 1:48 (usability test)\n- Works offline; invoices sync when the connection is back (task)\n- Tap to pay: a card on the phone, no reader (task)\n- 30 companies tested it for five weeks (beta program)\n\n## Not ready\n- Card payments offline are not in 2.0",
      angles:
        "**A. Before you are back in the van.** Marta finishes the job, sends the invoice, gets paid.\n\n**B. 24 seconds.** The number first, then why it matters.\n\n**C. No signal, no problem.** For everyone who works in basements.\n\nI recommend **A**: it holds all three facts without listing them.",
      draft:
        "# Finish the job, send the invoice, get paid\n\nMarta fixes heating systems. Last Tuesday she sent her invoice from the van, 24 seconds after closing the door.\n\n## Three things change\nAn invoice takes 24 seconds. It works without signal. And your customer can tap a card on your phone.\n\n## What is not in it\nCard payments need a connection. We are working on it, and we would rather say so.\n\nUpdate on December 7.",
      verify: "Checked 14 sentences against the fact sheet. Two changed: *fastest* removed, the date now names the steps. Nothing else is unsupported.",
      channels:
        "## Email\n**Subject:** Paid before you are back in the van\n\n## LinkedIn\nMarta sends invoices from her van. It takes her 24 seconds.\n\n## Store note\nSend invoices offline. Take cards on your phone.",
    },
    9,
  ],
  [
    "release-notes",
    "Submit 2.0 to the App Store",
    "phong",
    2,
    "waiting_approval",
    {
      changes: "31 finished tasks read, 12 matter to customers, grouped in three themes.",
      notes:
        "## New in 2.0\n- Invoices work without signal\n- Take a card on your phone\n- One screen instead of five\n\n## Fixed\n- Names with accents are found\n- Totals stay with the last line",
      verify: "Every line has a finished task behind it. Dark mode was removed from the list: it ships in 2.1.",
    },
    5,
  ],
  [
    "fix-bug",
    "Crash on Android 12",
    "quang",
    75,
    "done",
    {
      reproduce: "Open the camera, go back before the preview starts, open it again. Crashes 9 of 10 times on a Galaxy A52 (Android 12). The session is closed twice.",
      fix: "Close the capture session once, behind a lock, and wait for the surface before opening again. 3 files, 41 lines.",
    },
    22,
  ],
  [
    "faq-from-tickets",
    "Help center: 14 articles",
    "sam",
    97,
    "done",
    {
      groups: "212 reports → 9 groups. The first three hold 64%.",
      faq: "**Is my invoice lost without signal?** No. You see *3 waiting to sync*.\n\n**Do I need a card reader?** No.",
    },
    6,
  ],
  [
    "support-reply",
    "Beta feedback",
    "sam",
    76,
    "done",
    {
      understand: "The customer asks for a refund of a double charge. Policy: refund page, up to €500 without approval.",
      draft: "Hello Ben, you were right, and we have refunded €84 today.",
    },
    3,
  ],
  [
    "feature-spec",
    "Automatic payment reminders",
    "phong",
    120,
    "done",
    {
      problem: "Five of twelve clients like reminders if they are friendly. 38% of invoices are paid late.",
      options: "A. One mail on the due date. B. Three mails with a pause. C. The sender decides.",
      spec: "Three reminders: 3 days before, on the day, 7 days after. Off with one click.",
    },
    11,
  ],
  [
    "contract-review",
    "Renew the insurance",
    "lena",
    290,
    "done",
    { clauses: "18 clauses read.", risks: "Two to discuss: notice period and price index.", memo: "Sign after the notice period is 60 days." },
    8,
  ],
  [
    "budget-variance",
    "Budget for 2027",
    "lena",
    245,
    "done",
    { table: "14 lines compared.", recheck: "All sums agree.", commentary: "Cloud costs +9%, explained by the migration rehearsals." },
    7,
  ],
  ["seo-article", "Store keywords", "trinh", 340, "done", { outline: "Five sections.", article: "How to invoice without signal." }, 9],
  [
    "research-brief",
    "Competitor check",
    "phong",
    430,
    "done",
    { plan: "Five apps, six questions.", findings: "Nobody has offline and tap to pay together.", verify: "Two claims dropped.", brief: "One page." },
    14,
  ],
  ["repo-audit", "Security review", "minh", 170, "failed", { audit: "0 critical, 3 medium", outdated: "14 packages" }, 4],
  [
    "repo-audit",
    "Security review",
    "minh",
    169,
    "done",
    { audit: "0 critical, 3 medium", outdated: "14 packages", report: "Three medium findings, all with a fix. Two are one-line updates." },
    12,
  ],
  ["review-pr", "Fix rounding", "noah", 260, "done", { review: "Two comments, one test missing.", security: "Nothing found.", report: "Ready after the test for 0% tax." }, 8],
  ["onboarding-plan", "Onboarding plan", "lena", 480, "done", { plan: "First day, first week, first month: 14 steps with an owner." }, 5],
];
export const RUNNERS = [
  ["minh", "minh-macbook", "claude", "macOS"],
  ["quang", "daniel-macbook", "claude", "macOS"],
  ["noah", "noah-thinkpad", "codex", "Linux"],
  ["owner", "alex-macbook", "claude", "macOS"],
];
