/**
 * The live demo's company: Sunrise Software, ten people who make an invoicing app for small businesses. One story told
 * everywhere (tasks, meetings, chat, documents): Sunrise Mobile 2.0 goes to the stores in two weeks, and the customer
 * billing portal follows. Every name and company is fictional.
 *
 * Same exports as tooling/scripts/seed-demo-company.mjs, which seed-demo.mjs reads (SEED_COMPANY); what that script has
 * no place for (labels, comments, meetings with minutes, chat by day) is in the EXTRA* exports, read by seed-extra.mjs.
 * In text, @{key} mentions a person and {{title start}} becomes a task's code.
 */

export const DEPARTMENTS = [
  { key: "eng", name: "Engineering", project: "mobile" },
  { key: "growth", name: "Product & Marketing", project: "campaign" },
  { key: "ops", name: "Customer Success & Finance", project: "portal" },
];
export const deptName = (key) => DEPARTMENTS.find((d) => d.key === key).name;
export const CLIENTS = ["Lakeshore Logistics"];

// The keys are handles only: seed-demo-ai.mjs tells its story by them.
const PEOPLE = [
  { key: "minh", name: "Minh Tran", email: "minh", dept: "eng", head: true, title: "Engineering Lead", admin: true, location: "Ho Chi Minh City" },
  { key: "anh", name: "Ana Silva", email: "ana", dept: "eng", title: "Senior Frontend Engineer", location: "Lisbon" },
  { key: "quang", name: "Daniel Okafor", email: "daniel", dept: "eng", title: "Mobile Engineer", location: "London" },
  { key: "noah", name: "Noah Becker", email: "noah", dept: "eng", title: "Backend Engineer", location: "Berlin" },
  { key: "trinh", name: "Claire Dubois", email: "claire", dept: "growth", head: true, title: "Head of Marketing", location: "Paris" },
  { key: "phong", name: "Priya Nair", email: "priya", dept: "growth", title: "Product Manager", location: "London" },
  { key: "yuki", name: "Yuki Tanaka", email: "yuki", dept: "growth", title: "Product Designer", location: "Remote" },
  { key: "sam", name: "Sam Rivera", email: "sam", dept: "ops", head: true, title: "Head of Customer Success", location: "London" },
  { key: "lena", name: "Lena Fischer", email: "lena", dept: "ops", title: "Finance & People", location: "Berlin" },
];

export function company(domain) {
  const people = PEOPLE.map((p) => ({
    ...p,
    email: `${p.email}@${domain}`,
    manager: p.head ? "owner" : PEOPLE.find((h) => h.head && h.dept === p.dept).key,
    role: p.head ? "Manager" : null,
  }));
  return { people, team: new Map(), projects: PROJECTS, history: HISTORY, at: (ref) => ref };
}
export const taskDescriptions = () =>
  new Map([...PROJECTS.flatMap((p) => p.tasks.map((t) => [t[0], t[5]?.desc])), ...HISTORY.flatMap((h) => h.titles.map(([t, , d]) => [t, d]))].filter(([, d]) => d));

/** A task brief: why, what is in, how we know it is done, and what to mind. Done tasks have their boxes ticked. */
const brief = (why, scope, done, note, ticked = 0) =>
  [
    why,
    `## Scope\n${scope.map((s) => `- ${s}`).join("\n")}`,
    `## Done when\n${done.map((s, i) => `- [${i < ticked ? "x" : " "}] ${s}`).join("\n")}`,
    ...(note ? [`## Notes\n${note}`] : []),
  ].join("\n\n");

export const PROJECTS = [
  {
    key: "mobile",
    owner: "minh",
    name: "Sunrise Mobile 2.0",
    description:
      "The rebuilt iOS and Android app: send an invoice in under 30 seconds, work offline, get paid on the spot. Goal: 4.6★ in both stores and 40% of invoices sent from a phone within a quarter. Public release on December 7, behind a staged rollout (5% → 25% → 100%).",
    due: 14,
    tasks: [
      [
        "Offline mode: create and edit invoices without a connection",
        "in_progress",
        "quang",
        "urgent",
        3,
        {
          progress: 75,
          labels: ["ios", "android", "offline"],
          start: -10,
          desc: brief(
            "A third of our customers work in basements, vans and new buildings with no signal. Today the app shows a spinner and the invoice is lost. This is the number one reason in 1-star reviews (41 of the last 120).",
            [
              "Create, edit and duplicate an invoice offline; photos and signatures are kept on the device",
              'A queue that syncs in order when the connection is back, with a visible "3 waiting to sync" chip',
              "Conflicts: the newest edit wins, the other version stays in the invoice's history",
              "**Not in 2.0:** taking card payments offline",
            ],
            [
              "Sync of 20 invoices on 3G under 15 s",
              "Invoice numbers never clash after sync",
              "Airplane mode for 24 h, 20 invoices, nothing lost on iOS and Android",
              "QA script in the test plan passes on 6 devices",
            ],
            "Numbers are reserved in blocks of 50 per device. See the decision in the *Mobile 2.0 release plan* page.",
            2,
          ),
          sub: [
            ["Local store and sync queue", "done", "quang"],
            ["Reserve invoice numbers per device", "done", "noah"],
            ["Conflict screen: keep mine / keep theirs", "in_progress", "quang"],
            ["24-hour airplane mode test on six devices", "todo", "phong"],
          ],
          comments: [
            ["quang", 70, "Queue and number blocks are merged. 20 invoices on throttled 3G sync in **11 s**. Conflict screen is what is left."],
            ["yuki", 49, "Conflict screen is ready in the design file: two cards side by side, changed fields highlighted. Copy is final."],
            [
              "phong",
              26,
              '@{quang} for 2.0 please make "newest wins" the default and show the screen only when the *amount* differs. 9 in 10 conflicts in the beta were just notes.',
            ],
            ["quang", 25, "Agreed, that removes most of the cases. Will be in tomorrow's build."],
          ],
        },
      ],
      [
        "Tap to pay: accept a card on the phone, no reader",
        "review",
        "noah",
        "urgent",
        1,
        {
          labels: ["payments", "ios", "android"],
          start: -14,
          desc: brief(
            "The headline feature of 2.0: the customer taps a card on the phone and the invoice is marked paid. 22 of the 30 beta companies asked for it before anything else.",
            ["iPhone XS and later, Android 11+ with NFC", "Up to €500 without a PIN, PIN entry above", "Receipt by email or SMS", "Refund from the invoice, full amount only"],
            [
              "Payment succeeds in under 4 s at p95",
              "A declined card shows the reason in plain words",
              "Duplicate taps never charge twice (idempotency key per attempt)",
              "Payment provider's certification checklist signed",
            ],
            "Certification took two rounds with the Android partner. The evidence files are with Lena.",
            3,
          ),
          sub: [
            ["Idempotency key on every attempt", "done", "noah"],
            ["Decline messages in five languages", "done", "phong"],
            ["Provider certification: Android", "in_progress", "noah"],
          ],
          comments: [
            ["noah", 96, "iOS certification came back green. Android needs one more log file, sent this morning."],
            ["lena", 72, "Contract addendum with the provider is signed: 1.2% + €0.10 per tap, no monthly minimum."],
            ["minh", 20, "Reviewed the retry path, two small comments on the PR. The double-tap test is exactly what I wanted to see."],
          ],
        },
      ],
      [
        "New invoice in 30 seconds: one-screen editor",
        "done",
        "anh",
        "high",
        -5,
        {
          labels: ["design", "editor"],
          desc: brief(
            "The old editor is six screens. In usability tests people needed 1 min 48 s for a two-line invoice and half of them looked for the save button.",
            ["Customer, lines, tax and total on one screen", "Recent customers and items first", 'Voice entry of an item ("two hours of plumbing at 60")'],
            ["Median under 30 s in a test with 8 customers", "Works one-handed on a 5.4″ phone", "VoiceOver and TalkBack pass"],
            "Result: **median 24 s**, 8 of 8 finished without help.",
            3,
          ),
          comments: [
            ["yuki", 190, "Test round 2 done with 8 customers: median 24 s, slowest 41 s. Recordings are in the research page."],
            ["owner", 180, "From 1:48 to 0:24. That number goes first in the launch post. Great work @{anh} @{yuki} 👏"],
          ],
        },
      ],
      [
        "Crash on Android 12 when the camera opens twice",
        "in_progress",
        "quang",
        "high",
        2,
        {
          progress: 60,
          labels: ["bug", "android"],
          start: -4,
          desc: `1.8% of Android beta sessions crash when the receipt camera is opened a second time. It is our only open crash above the 0.5% bar for release.

## Steps to reproduce
1. Pixel 5 or Galaxy A52, Android 12
2. New invoice → attach receipt → take a photo → back
3. Attach another receipt within about two seconds

**Expected:** the camera opens again. **Actual:** the app closes.

## What we know
| Device | Sessions | Crash rate |
| --- | --- | --- |
| Galaxy A52 | 1,204 | 3.1% |
| Pixel 5 | 688 | 1.9% |
| Others, Android 13+ | 5,310 | 0.0% |

The camera session is not released before the next one starts. Fix: wait for the close callback, disable the button meanwhile.

## Done when
- [x] Cause confirmed from the crash log
- [ ] Fix in a beta build
- [ ] Under 0.1% for 48 hours`,
          comments: [
            ["phong", 52, "Reproduced 5 of 5 times on the office A52."],
            ["quang", 28, "Cause found: we start a session before the old one reports closed. Fix is in review, beta build tonight."],
          ],
        },
      ],
      [
        "Store listing: screenshots, video and text in five languages",
        "in_progress",
        "yuki",
        "high",
        4,
        {
          progress: 45,
          labels: ["store", "design"],
          start: -5,
          desc: brief(
            "Both stores review the listing together with the build, so it has to be final before we submit.",
            [
              "Six screenshots per language (EN, FR, DE, ES, PT), phone and tablet",
              "20-second preview video, no voice-over",
              "Title, subtitle and description: lead with tap to pay and offline",
            ],
            ["Texts approved by Claire", "Screenshots use the Sunrise demo account, no customer names", "Uploaded as drafts in both stores"],
            'First screenshot decides: we test "Get paid on the spot" against "Invoice in 30 seconds" after launch.',
            1,
          ),
          sub: [
            ["Screenshot template", "done", "yuki"],
            ["English set", "done", "yuki"],
            ["French, German, Spanish, Portuguese sets", "in_progress", "yuki"],
            ["Preview video", "todo", "trinh"],
          ],
          comments: [["trinh", 30, "English texts approved. Please swap screenshots 2 and 3: people scroll past the third one."]],
        },
      ],
      [
        "Move 18,400 accounts to the new sync service",
        "todo",
        "noah",
        "urgent",
        8,
        {
          labels: ["backend", "migration"],
          start: 4,
          desc: brief(
            "2.0 talks only to the new sync service. Accounts move in waves during the staged rollout; nobody should notice.",
            [
              "Wave 1: our own accounts, wave 2: 30 beta companies, wave 3: 5%, then 25%, then all",
              "Both services written to for 14 days, so we can go back",
              "A dashboard: moved, failed, time per account",
            ],
            ["Dry run on a copy of production: under 2 hours, 0 differences", "Rollback rehearsed once, under 10 minutes", "Support has the list of accounts per wave"],
            "Two accounts have more than 60,000 invoices. Move them by hand, at night, with the customer told in advance.",
          ),
          comments: [
            ["noah", 44, "Dry run 1: 2 h 40 m, 3 accounts with differences (all rounding of old tax lines). Dry run 2 on Thursday."],
            ["sam", 40, "I will call the two big accounts myself. Harborview prefers a Sunday night."],
          ],
        },
      ],
      [
        "Submit 2.0 to the App Store and Google Play",
        "todo",
        "quang",
        "urgent",
        7,
        {
          labels: ["release", "store"],
          start: 7,
          desc: brief(
            "Review takes one to three days. Submitting a week ahead leaves room for one rejection.",
            [
              "Release candidate from the `release/2.0` branch",
              "Notes for the reviewer, with a test account and a test card",
              "Privacy labels updated: location is no longer collected",
            ],
            ['Both builds "ready for release"', "Staged rollout configured: 5%", "Release on hold until the go/no-go"],
            null,
          ),
        },
      ],
      [
        "Beta feedback: answer and sort all 212 reports",
        "in_progress",
        "sam",
        "medium",
        4,
        {
          progress: 80,
          labels: ["beta", "customers"],
          start: -12,
          desc: brief(
            "30 companies have used the beta for five weeks. Everyone who wrote gets an answer, and what they said decides what is left before release.",
            ["Every report answered by a person", "Sorted: bug, idea, question, praise", "Top five problems have an owner"],
            ["0 unanswered reports", "Summary page shared with the team", "Beta companies told about the release date"],
            "So far: 88 bugs (81 fixed), 67 ideas, 39 questions, 18 thank-yous.",
            1,
          ),
          comments: [["sam", 22, "171 of 212 answered. The most frequent wish left: duplicate a *paid* invoice. Two taps in 2.0, so we only have to tell people."]],
        },
      ],
      [
        "Push notification when an invoice is paid",
        "review",
        "anh",
        "medium",
        2,
        {
          labels: ["notifications"],
          start: -6,
          desc: brief(
            '"Did they pay?" is the question people open the app for, four times a day on average. The app should say it first.',
            ['Push: "Café Lumière paid €420.00"', "Grouped when several are paid at once", "Off by default between 21:00 and 7:00"],
            ["Arrives within 10 s of the payment", "A tap opens that invoice", "Can be turned off per account"],
            null,
            2,
          ),
          comments: [["minh", 18, "Looks good. Please add a test for the grouped case in a different time zone, then merge."]],
        },
      ],
      [
        "Accessibility pass: VoiceOver, TalkBack, large text",
        "in_progress",
        "anh",
        "medium",
        7,
        {
          progress: 35,
          labels: ["accessibility"],
          start: -3,
          desc: brief(
            "Two beta customers use a screen reader every day. We also want the store's accessibility section filled in honestly.",
            ["Every control has a name that makes sense on its own", "Layouts hold at 200% text", "Contrast 4.5:1 in light and dark"],
            ["Send, pay and refund an invoice with the screen off", "No clipped text at 200%", "Checklist signed by both customers"],
            null,
            1,
          ),
        },
      ],
      [
        "Release monitoring: crash, payment and sync alerts",
        "todo",
        "minh",
        "high",
        9,
        {
          labels: ["release", "backend"],
          start: 2,
          desc: brief(
            "During the rollout we want to know about a problem before a customer writes.",
            [
              "Alerts: crash rate over 0.5%, failed payments over 2%, sync queue older than 10 minutes",
              "One dashboard on the office screen",
              "Who is on call, hour by hour, for the first five days",
            ],
            ["A test alert reaches the right phone in under a minute", "Runbook: stop the rollout in three steps", "On-call plan agreed"],
            null,
          ),
        },
      ],
      [
        "Help center: 14 articles for the new app",
        "in_progress",
        "sam",
        "medium",
        8,
        {
          progress: 50,
          labels: ["help", "customers"],
          start: -5,
          desc: brief(
            "Version 1 articles show screens that no longer exist. Support expects three times the usual questions in the first week.",
            ["14 articles with new screenshots, English first", "Saved replies for the ten most likely questions", 'A short "What moved where" guide'],
            ["Reviewed by one person who has never seen 2.0", "Linked from the app's help menu", "Old articles marked as version 1"],
            "Written: 7 of 14. Next: tap to pay limits and refunds.",
          ),
        },
      ],
      [
        "Decide: keep version 1 working for how long?",
        "todo",
        "phong",
        "high",
        2,
        {
          labels: ["decision"],
          desc: `About 2,100 people are on phones that cannot run 2.0 (iOS 14 and earlier, Android 9 and earlier).

## Options
| | Cost | Risk |
| --- | --- | --- |
| **A.** Stop in January | none | Angry customers in the busiest month |
| **B.** Keep until June 30, fixes only | about 3 days a month | Two sync services until then |
| **C.** Keep for a year | about 6 days a month | Slows the billing portal |

## Recommendation
**B**, with a message in the app from March and 20% off a new phone through our partner.

## Done when
- [x] Numbers from analytics
- [ ] Alex decides
- [ ] Customers told, help article published`,
          comments: [
            ["sam", 48, "From support's side B is fine. Please not A: January is when the yearly invoices go out."],
            ["noah", 46, "B is fine for me too, if the old service gets fixes only."],
          ],
        },
      ],
      [
        "Face ID and fingerprint sign-in",
        "done",
        "quang",
        "medium",
        -7,
        {
          labels: ["security"],
          desc: brief(
            "People type a password nine times a week.",
            ["Face ID, Touch ID, Android biometrics", "Asked again after 5 minutes in the background"],
            ["Works after a restart", "Falls back to the PIN"],
            null,
            2,
          ),
        },
      ],
      [
        "Dark mode",
        "done",
        "anh",
        "low",
        -12,
        {
          labels: ["design"],
          desc: brief(
            "Second most requested idea of the beta, 54 votes.",
            ["Follows the phone's setting", "PDF preview stays white"],
            ["All screens checked by Yuki", "Contrast 4.5:1"],
            null,
            2,
          ),
        },
      ],
      [
        "Beta program: 30 companies, five weeks",
        "done",
        "sam",
        "high",
        -10,
        {
          labels: ["beta", "customers"],
          desc: brief(
            "Find out what breaks in real work before the stores do.",
            ["30 companies: 12 trades, 10 services, 8 shops", "One call a week with five of them"],
            ["25 or more active in week five", "Would you miss it? 60% or more say very"],
            "Result: 28 active, **71%** would miss it very much.",
            2,
          ),
        },
      ],
    ],
  },
  {
    key: "portal",
    owner: "phong",
    name: "Customer billing portal",
    description:
      'One page where a client of our customers sees every invoice, pays by card or bank, and downloads receipts, without an account. Goal: invoices paid 5 days sooner and a third fewer "can you send it again?" emails. Pilot with Lakeshore Logistics in January.',
    due: 46,
    tasks: [
      [
        "Invoice page: pay by card, bank transfer or Apple Pay",
        "in_progress",
        "anh",
        "high",
        9,
        {
          progress: 55,
          labels: ["portal", "payments"],
          start: -8,
          desc: brief(
            "The page behind the link in every invoice email. Today it is a PDF download and 38% of people leave to pay somewhere else.",
            [
              "Total and due date readable without scrolling",
              "Card, SEPA transfer with a QR code, Apple Pay and Google Pay",
              "Part payment when the company allows it",
              "The company's logo and color",
            ],
            ["Loads in under 1 s on 4G", "Pay in three taps with a saved wallet", "Works without JavaScript for reading", "Tested with 5 clients of pilot companies"],
            "Design is final for phone and desktop. QR code follows the EPC standard.",
            1,
          ),
          sub: [
            ["Layout and company branding", "done", "anh"],
            ["Card and wallets", "in_progress", "anh"],
            ["SEPA QR code", "in_progress", "noah"],
            ["Part payment", "todo", "anh"],
          ],
          comments: [
            ["yuki", 66, "Final screens are up. Biggest change after the tests: the *Pay* button carries the amount."],
            ["anh", 24, "Card works on staging. First load is 0.8 s, 61 KB of JavaScript."],
            ["phong", 21, "Lovely. I showed it to Lakeshore's accountant and they paid a test invoice without asking a single question."],
          ],
        },
      ],
      [
        "Secure links: open an invoice without an account",
        "review",
        "noah",
        "high",
        3,
        {
          labels: ["portal", "security"],
          start: -9,
          desc: brief(
            "Clients should not create a password to pay a €60 invoice. The link itself has to be safe enough.",
            [
              "A link per invoice, 128 random bits, can be renewed by the company",
              "Email code before showing *other* invoices of the same client",
              "Rate limit and an audit log of every opening",
            ],
            ["Links cannot be guessed or listed", "A renewed link stops the old one at once", "External security review has no high finding"],
            null,
            2,
          ),
          comments: [
            ["minh", 43, "Please log the opening *before* rendering, otherwise a timeout hides it."],
            ["noah", 42, "Good catch, changed. Review report arrives on Wednesday."],
          ],
        },
      ],
      [
        "Automatic payment reminders",
        "todo",
        "noah",
        "high",
        15,
        {
          labels: ["portal", "email"],
          start: 8,
          desc: brief(
            "Customers spend two hours a week chasing payments, by hand, and feel bad about it.",
            [
              "Friendly, firm and final: three tones, editable",
              "3 days before, on the day, 7 and 14 days after",
              "Stops the moment the invoice is paid",
              "Never on weekends or public holidays",
            ],
            ["Preview with real invoice data", "Can be paused per client", "No reminder after payment in 10,000 simulated cases"],
            "Ana's beta notes: people want to see *who already got one* in the invoice list.",
          ),
        },
      ],
      [
        "Pilot with Lakeshore Logistics: 40 clients, 4 weeks",
        "todo",
        "sam",
        "high",
        37,
        {
          labels: ["portal", "customers"],
          start: 30,
          desc: brief(
            "Lakeshore sends 1,100 invoices a month and is paid after 41 days on average. If it works there, it works anywhere.",
            ["Kick-off call, branding and bank details", "40 clients picked together, half of them slow payers", "Weekly call, one page of numbers"],
            ["Average time to payment 36 days or less", "Support questions per 100 invoices under 2", "Lakeshore agrees to a case study"],
            null,
          ),
          comments: [["sam", 75, "They signed the pilot letter. Their finance lead wants the weekly numbers on Fridays before 15:00."]],
        },
      ],
      [
        "Accounting export: Xero, DATEV and CSV",
        "blocked_todo",
        "noah",
        "medium",
        18,
        {
          blocked: "Waiting for DATEV partner access (requested Nov 12)",
          labels: ["portal", "integrations"],
          desc: brief(
            "Payments taken in the portal have to land in the books without typing.",
            ["Xero: payment and fee as separate lines", "DATEV: booking batch with the tax keys of the client", "CSV with the columns accountants asked for"],
            ["Month of test data matches to the cent in all three", "A failed export says what to fix", "Reviewed by one outside accountant"],
            null,
          ),
          comments: [["lena", 50, "I called DATEV again: access is expected this week. CSV can start without them."]],
        },
      ],
      [
        "Payment fees: who pays, and how we show it",
        "in_progress",
        "lena",
        "high",
        4,
        {
          progress: 65,
          labels: ["pricing", "decision"],
          start: -7,
          desc: brief(
            "Card fees are 1.4% on average. Small companies feel every cent, and surcharges are not allowed everywhere.",
            ["Three models with the numbers of 50 real customers", "Legal check for DE, FR, UK, ES", "How the fee appears on the statement"],
            ["Model chosen with Alex and Priya", "Prices page text ready", "Finance can reconcile a month in under an hour"],
            "Leaning to: bank transfer free, cards at cost + 0.3%, shown before sending.",
            1,
          ),
        },
      ],
      [
        "Design: the client's overview of all invoices",
        "review",
        "yuki",
        "medium",
        2,
        {
          labels: ["portal", "design"],
          start: -6,
          desc: brief(
            "After the email code, a client sees everything they owe and have paid to this company.",
            ["Open first, oldest on top, one button to pay several", "Receipts as one ZIP per year", "Empty, loading and error states"],
            ["Tested with 5 clients", "Phone and desktop", "Handed over to Ana with notes"],
            null,
            2,
          ),
          comments: [["phong", 27, "The *pay several* bar is great. Can we keep the total visible while scrolling?"]],
        },
      ],
      [
        "Load test: 5,000 people paying at once",
        "todo",
        "minh",
        "medium",
        23,
        {
          labels: ["portal", "backend"],
          desc: brief(
            "Most invoices go out on the first of the month between 9:00 and 10:00.",
            ["Replay of last month's peak at 4×", "Payment provider sandbox with slow answers", "What fails first, and how it looks to people"],
            ["p95 under 800 ms", "No payment lost or doubled", "Report with the next bottleneck"],
            null,
          ),
        },
      ],
      [
        "Interviews: how 12 clients pay invoices today",
        "done",
        "phong",
        "medium",
        -18,
        {
          labels: ["research"],
          desc: brief(
            "We were about to build a login. Twelve interviews said no.",
            ["12 clients of 6 companies", "30 minutes each, recorded with consent"],
            ["Findings page", "Three decisions changed or confirmed"],
            "Changed: no account, amount on the button, bank transfer as first choice in Germany.",
            2,
          ),
        },
      ],
      [
        "Choose the payment provider",
        "done",
        "lena",
        "high",
        -21,
        {
          labels: ["payments", "decision"],
          desc: brief(
            "Four offers compared on price, countries and support.",
            ["Price at our volume, payout time, SEPA and wallets", "References from two companies our size"],
            ["Contract signed", "Sandbox access for engineering"],
            "Saves about €14,000 a year over the current one.",
            2,
          ),
        },
      ],
    ],
  },
  {
    key: "campaign",
    owner: "trinh",
    name: "Launch campaign: get paid on the spot",
    description:
      "Tell 18,400 customers and the press about Mobile 2.0: launch post, customer film, emails, webinar and store features. Goal: 6,000 updates in week one and 400 new sign-ups.",
    due: 18,
    tasks: [
      [
        "Write the launch post for Mobile 2.0",
        "in_progress",
        "trinh",
        "high",
        3,
        {
          progress: 60,
          labels: ["content"],
          start: -4,
          desc: brief(
            "One story for the blog, the newsletter and the press. Reader: the owner of a three-person company, on a phone, between two jobs.",
            ["Open with Marta, who invoices from her van", "Three things only: 30 seconds, offline, tap to pay", "One honest paragraph about what is not in 2.0"],
            ["Under 600 words", "Every number checked by Priya", "Alex approves", "French and German versions"],
            "Plain words. No *revolutionary*, no *seamless*.",
            1,
          ),
          comments: [
            ["owner", 45, "Open with Marta's van, not with us. And the 24 seconds belong in the first paragraph."],
            ["trinh", 28, "Draft 2 does both. The agent's draft is attached to the workflow run, I rewrote the ending."],
          ],
        },
      ],
      [
        "Customer film: a day with Marta's Plumbing",
        "review",
        "trinh",
        "high",
        2,
        {
          labels: ["video"],
          start: -13,
          desc: brief(
            "60 seconds, real customer, real van. Shown on the site, in the stores and in ads.",
            ["One shooting day in Lisbon (done)", "Cuts: 60 s, 20 s, 6 s; subtitles in five languages"],
            ["Marta approves the cut", "Music licensed", "Files in the press kit"],
            "The 20-second cut doubles as the store preview.",
            1,
          ),
          comments: [["yuki", 23, "Second cut is great. Two spots where the phone shows the old icon: 0:14 and 0:41."]],
        },
      ],
      [
        "Email to 18,400 customers, in four waves",
        "todo",
        "trinh",
        "high",
        10,
        {
          labels: ["email"],
          start: 4,
          desc: brief(
            "The mail goes out with the rollout, so nobody reads about a version they cannot get yet.",
            ["Four waves that match the account migration", "Two subject lines tested on wave 1", "Plain-text version"],
            ["Lists match Noah's waves", "Unsubscribe and language checked", "Support knows the send times"],
            null,
          ),
        },
      ],
      [
        "Live webinar: Mobile 2.0 in 25 minutes",
        "todo",
        "phong",
        "medium",
        16,
        {
          labels: ["webinar", "customers"],
          desc: brief(
            "Last webinar: 310 sign-ups, 140 live, 22 upgrades.",
            ["Live demo on a real phone, with airplane mode", "10 minutes of questions, Sam answers in the chat"],
            ["Landing page and calendar invite", "One rehearsal", "Recording online the same day"],
            null,
          ),
        },
      ],
      [
        "Press kit and list of 25 journalists",
        "in_progress",
        "trinh",
        "medium",
        4,
        {
          progress: 70,
          labels: ["press"],
          start: -6,
          desc: brief(
            "Small-business and tech press in five countries. Embargo until release day, 9:00.",
            ["Fact sheet, founder photos, film, screenshots", "A personal first line for each journalist"],
            ["25 pitches sent", "Alex free for calls on release day"],
            "12 of 25 pitched, 4 have answered.",
            1,
          ),
        },
      ],
      [
        "Pricing page: tap to pay and fees in plain words",
        "todo",
        "yuki",
        "medium",
        8,
        {
          blocked: "Waiting for the fee decision (Payment fees: who pays)",
          labels: ["website"],
          desc: brief(
            "Visitors leave the page when they have to calculate.",
            ["A slider: your invoices per month → what you pay", "One sentence per fee"],
            ["Checked by Lena", "Tested with 5 people who do not know us"],
            null,
          ),
        },
      ],
      [
        "Launch calendar, day by day",
        "done",
        "trinh",
        "medium",
        -6,
        {
          labels: ["plan"],
          desc: brief("Who does what from T-14 to T+14.", ["Engineering, marketing, support on one page"], ["Agreed in the weekly", "Every line has one owner"], null, 2),
        },
      ],
      [
        "Choose and film the customer story",
        "done",
        "trinh",
        "medium",
        -11,
        {
          labels: ["video", "customers"],
          desc: brief(
            "Eleven companies applied. We looked for a story that needs no explaining.",
            ["Three video calls, one choice"],
            ["Release form signed", "Shooting day done"],
            "Marta's Plumbing: 3 people, 60 invoices a month, no office.",
            2,
          ),
        },
      ],
    ],
  },
];
// "blocked_todo" reads better in the table above than a status and a reason far apart.
for (const p of PROJECTS) for (const t of p.tasks) if (t[1] === "blocked_todo") t[1] = "todo";

const h = (title, who, desc) => [title, who, desc];
export const HISTORY = [
  {
    dept: "eng",
    project: "mobile",
    titles: [
      h("Cold start under 1.5 seconds", "quang", "Was 3.2 s on a Galaxy A52. Lazy-loaded the PDF engine and the charts. Now 1.3 s at p50."),
      h("Invoice list: scroll 5,000 rows without a stutter", "anh", "Windowed list, images decoded off the main thread. 60 fps on a five-year-old phone."),
      h(
        "Sync: retry with back-off after a timeout",
        "noah",
        "Retries at 1, 4, 15 and 60 seconds, then waits for the next connection. No duplicate uploads in 10,000 simulated drops.",
      ),
      h("Photos: compress receipts before upload", "quang", "From 4.1 MB to 380 KB on average, still readable for a tax office."),
      h("Customer search finds names with accents", "anh", "“Lumiere” now finds “Lumière”. Same fix for items."),
      h("PDF: totals stay with the last line", "anh", "No more page with only a total on it."),
      h("Fix rounding on mixed tax rates", "noah", "Rounded per rate instead of per line, as the tax rules of DE, FR and ES ask."),
      h("Build pipeline: 34 minutes to 11", "minh", "Cached native modules, tests in four shards."),
      h("Crash reports with the last five actions", "minh", "Breadcrumbs without customer data; found two crashes in the first day."),
      h("Deep links open the right invoice", "quang", "Links from email open the app when it is installed, the web page otherwise."),
      h("Signature: undo and bigger area", "anh", "Asked for by 12 beta companies."),
      h("Rate limit on the public API", "noah", "600 requests a minute per key, clear error with the wait time."),
      h("Rotate API keys without downtime", "noah", "Two active keys for 24 hours; runbook in the engineering space."),
      h("Test devices: add two low-end phones", "quang", "Galaxy A13 and Moto G22. They found three layout bugs in a week."),
      h("Sign-in: clearer message for a wrong code", "anh", "Says how many tries are left and when a new code can be sent."),
      h("Database: index for overdue invoices", "noah", "Home screen query from 900 ms to 40 ms."),
      h("Feature flags for the staged rollout", "minh", "Percent, country and account; a change is live in under a minute."),
      h("Tablet layout in landscape", "quang", "List and invoice side by side from 900 px."),
      h("Remove location permission", "quang", "No feature used it any more; one prompt less at first start."),
      h("Security review: fix three medium findings", "minh", "Session length, log redaction and a missing header. Report closed."),
    ],
  },
  {
    dept: "growth",
    project: "campaign",
    titles: [
      h("Name and icon for Mobile 2.0", "yuki", "Same name, new icon. Recognised by 9 of 10 customers in a test."),
      h("Survey: why people leave the old app", "phong", "640 answers. Top three: no signal, too many steps, cannot take a card."),
      h("Landing page for the beta", "trinh", "312 applications in nine days, 30 companies invited."),
      h("Brand: photos of real customers", "yuki", "Twelve portraits, no stock photos from now on."),
      h("Email: welcome series for new sign-ups", "trinh", "Three mails in ten days. Second-week use up from 41% to 49%."),
      h("Usability test round 1: invoice editor", "yuki", "8 people, 1 min 48 s on average. Led to the one-screen editor."),
      h("Positioning: one sentence for 2.0", "phong", "“Finish the job, send the invoice, get paid. Before you are back in the van.”"),
      h("Competitor check: five invoicing apps", "phong", "Nobody has offline and tap to pay together."),
      h("Store keywords for five languages", "trinh", "Based on search volume and where we can win."),
      h("Case study: Café Lumière", "trinh", "Paid 6 days sooner. Two pages, approved by the owner."),
      h("Newsletter: October issue", "trinh", "44% opened, 9% clicked; best issue this year."),
      h("Onboarding: three steps instead of seven", "yuki", "First invoice sent within 10 minutes: from 52% to 68%."),
    ],
  },
  {
    dept: "ops",
    project: "portal",
    titles: [
      h("Support: answer in under two hours", "sam", "Median from 5 h 10 m to 1 h 38 m with the new rota."),
      h("Saved replies: the 25 most asked questions", "sam", "Covers 60% of tickets, rewritten in plain words."),
      h("Health check of our 50 largest customers", "sam", "7 at risk, each has a call booked."),
      h("Month-end close in five days", "lena", "Was nine. Bank matching is automatic now."),
      h("Renew the insurance and data processing contracts", "lena", "Signed for 24 months, 8% cheaper."),
      h("Onboarding plan for new colleagues", "lena", "First day, first week, first month; used by Noah in September."),
      h("Budget for 2027, first draft", "lena", "Three scenarios, reviewed with Alex."),
      h("Refund process on one page", "sam", "Who may refund what, and how fast."),
      h("Customer council: first meeting", "sam", "Eight customers, 90 minutes. Reminders were the top wish."),
      h("Reconcile test payouts with the provider", "lena", "1,200 test payments, 0 differences."),
    ],
  },
];

export const GOALS = [
  {
    title: "Launch Mobile 2.0 and make it loved",
    owner: "minh",
    department: "eng",
    krs: [
      { title: "Sunrise Mobile 2.0", kind: "project", project: "mobile" },
      { title: "Store rating", kind: "number", start: 3.9, target: 4.6, current: 4.4, unit: "★" },
      { title: "Crash-free sessions", kind: "number", start: 97.2, target: 99.5, current: 98.9, unit: "%" },
    ],
  },
  {
    title: "Customers get paid five days sooner",
    owner: "phong",
    department: "growth",
    krs: [
      { title: "Customer billing portal", kind: "project", project: "portal" },
      { title: "Average days to payment", kind: "number", start: 34, target: 29, current: 32, unit: "days", direction: "down" },
    ],
  },
  {
    title: "Grow to 20,000 paying companies",
    owner: "trinh",
    department: "growth",
    krs: [
      { title: "Launch campaign: get paid on the spot", kind: "project", project: "campaign" },
      { title: "Paying companies", kind: "number", start: 17200, target: 20000, current: 18400, unit: "companies" },
    ],
  },
  {
    title: "Support people recommend",
    owner: "sam",
    department: "ops",
    krs: [
      { title: "First answer, median", kind: "number", start: 310, target: 90, current: 98, unit: "min", direction: "down" },
      { title: "Satisfaction after a ticket", kind: "number", start: 86, target: 94, current: 93, unit: "%" },
    ],
  },
];

export const EXTENSION = [
  ["anh", "https://chatgpt.com/c/demo-ana-1", ["How do I keep a payment page under 70 KB of JavaScript?", "Accessible names for icon buttons in a list: best pattern?"]],
  [
    "trinh",
    "https://claude.ai/chat/demo-claire-1",
    ["Five headline options for an invoicing app launch post, no hype words", "Shorten this opening to 60 words and keep the customer's name"],
  ],
  ["phong", "https://gemini.google.com/app/demo-priya-1", ["Turn these 12 interview notes into a table: who, how they pay, what annoys them"]],
  [
    "quang",
    "https://chatgpt.com/c/demo-daniel-1",
    [
      "Why does our release job fail to push the image? docker login registry.example -u workspace-bot -p ghp_abcdefghijklmnopqrstuvwxyz0123456789 returns denied. First reported by Lakeshore Logistics (anna@lakeshore-logistics.example).",
    ],
  ],
  [
    "minh",
    "https://claude.ai/chat/demo-minh-1",
    ["Checklist for a staged mobile rollout with a rollback plan", "Alert thresholds for a payments service with 2,000 payments a day"],
  ],
];

export const APPROVALS = [
  [
    "quang",
    "owner",
    "purchase",
    "Six test phones for the device lab",
    "Two low-end Android phones, two mid-range, an iPhone SE and an iPad mini. The low-end pair found three layout bugs in a week on loan; we would own them.\n\nQuote from the dealer is valid until Friday.",
    2140,
  ],
  [
    "trinh",
    "owner",
    "purchase",
    "Launch week ads, EU and UK",
    "Seven days, five countries. 70% on people who already use an invoicing app. Stop rule: pause any ad above €38 per sign-up after 200 clicks.",
    9500,
  ],
  [
    "sam",
    "owner",
    "purchase",
    "Extra support for the first two weeks",
    "Two freelancers, 4 hours a day each, December 7 to 18. Both worked with us during the last price change.",
    3360,
  ],
  [
    "minh",
    "owner",
    "purchase",
    "External penetration test of the billing portal",
    "Five days, report before the pilot. Second of three offers, the only one with payment experience.",
    7800,
    ["approved", "Approved. Please book the week before the pilot so we have time to fix things."],
  ],
  ["yuki", "trinh", "purchase", "Music license for the customer film", "Worldwide, two years, all channels.", 420, ["approved", "Yes, the second track. Invoice to Lena please."]],
  [
    "anh",
    "minh",
    "other",
    "Conference: accessible mobile apps, two days",
    "Lisbon, December 10 and 11. Back online for the rollout's second wave. Notes for the whole team.",
    null,
  ],
  [
    "lena",
    "owner",
    "purchase",
    "Accounting tool: yearly plan instead of monthly",
    "Saves 18%. Same seats as today.",
    1680,
    ["rejected", "Good idea, but let us wait until the DATEV question is settled."],
  ],
];

export const LEAVE = [
  ["anh", "annual", 13, 14, "approved", "Two days off after the conference"],
  ["lena", "annual", 4, 4, "approved", "Moving house"],
  ["quang", "annual", 24, 28, "pending", "Home for the holidays"],
  ["yuki", "annual", 22, 26, "pending", "Family visit in Osaka"],
];

export const ANNOUNCEMENTS = [
  [
    "owner",
    "event",
    "Mobile 2.0 go/no-go: Thursday 15:00",
    "Minh walks us through crashes, payments and the migration. Please read the release plan page before; we decide in the meeting and tell everyone right after.\n\nIf you cannot come, send your yes or no with one sentence to Minh by noon.",
    true,
    [3, 15],
  ],
  [
    "trinh",
    "general",
    "Marta's film is here, first cut",
    "Sixty seconds, one van, no actors. The link is in #launch. Comments until tomorrow evening, then we lock the picture.",
    false,
    null,
  ],
  [
    "minh",
    "policy",
    "Code freeze for 2.0 starts Wednesday 17:00",
    "After that only fixes for release blockers, with two reviewers. The billing portal is not frozen: please keep shipping there.",
    true,
    null,
  ],
  [
    "lena",
    "general",
    "Welcome Noah, 90 days in",
    "Noah joined us in September, shipped the sync queue and already explained SEPA to half of the company. Ask about the sourdough.",
    false,
    null,
  ],
  [
    "sam",
    "general",
    "First answer in 98 minutes",
    "That is the median of last week. A year ago it was more than five hours. Thank you to everyone who took a support shift.",
    false,
    null,
  ],
];

// Told by seed-extra.mjs instead.
export const MEETINGS = [];
export const CHAT = [];
export const CELEBRATE = /^$/;

export const CHANNELS = [
  { name: "general", topic: "The whole company", members: "all" },
  { name: "mobile-2-0", displayName: "Mobile 2.0", topic: "Release December 7 · go/no-go Thursday 15:00", members: ["eng", "growth", "ops"] },
  { name: "billing-portal", displayName: "Billing portal", topic: "Pilot with Lakeshore Logistics in January", members: ["eng", "growth", "ops"] },
  { name: "launch", displayName: "Launch", topic: "Post, film, emails, press and webinar", members: ["growth", "ops"] },
  { name: "customers", displayName: "Customer voices", topic: "What customers say, word for word", members: "all" },
  { name: "wins", displayName: "Wins", topic: "Small and big", members: "all" },
  { name: "random", topic: "Coffee, music, sourdough", members: "all" },
];

export const DOC_SPACES = [
  { key: "PROD", name: "Product", icon: "📱", description: "Plans, research and decisions for Mobile 2.0 and the billing portal.", by: "phong" },
  { key: "ENG", name: "Engineering", icon: "⚙️", description: "How we build, release and run things.", by: "minh" },
  { key: "LAUNCH", name: "Launch", icon: "📣", description: "Post, film, calendar and press kit.", by: "trinh" },
  { key: "TEAM", name: "Company", icon: "🏠", description: "How we work, people and policies.", by: "owner" },
];

export const DOCS = [
  {
    space: "PROD",
    by: "minh",
    title: "Mobile 2.0 release plan",
    emoji: "🚀",
    labels: ["release", "mobile"],
    star: ["owner", "minh", "phong", "quang"],
    views: ["owner", "quang", "anh", "phong", "sam", "trinh"],
    comments: [
      ["sam", "Support shifts for December 7 to 11 are filled.", "First five days"],
      ["owner", "I like that stopping needs one person, not a meeting.", "Who can stop it"],
    ],
    content: `# Mobile 2.0 release plan

Release on **December 7**, 9:00 London. We go when every line below is green.

## Where we stand

| Gate | Target | Today | Owner |
| --- | --- | --- | --- |
| Crash-free sessions | 99.5% | 98.9% | Daniel |
| Payment success | 98% | 98.6% ✅ | Noah |
| Offline test, 6 devices | 6 of 6 | 4 of 6 | Priya |
| Account migration dry run | 0 differences | 3 | Noah |
| Beta reports answered | 212 | 171 | Sam |
| Store listing | 5 languages | 1 | Yuki |

## Rollout

1. **Day 1:** 5% of accounts, our own and the beta companies first
2. **Day 3:** 25%, if crash-free is above 99.3% and no payment was lost
3. **Day 7:** everyone

## Who can stop it

Anyone on call. Set the flag \`mobile-2-rollout\` to 0, post in #mobile-2-0, then call Minh. No approval needed.

## First five days

| | 8–14 h | 14–20 h | Night |
| --- | --- | --- | --- |
| Engineering | Daniel | Noah | Minh |
| Support | Sam | Priya | none |

## Decisions

- Invoice numbers are reserved in blocks of 50 per device.
- Newest edit wins; we ask only when the amount differs.
- No offline card payments in 2.0.
`,
  },
  {
    space: "PROD",
    by: "phong",
    title: "Offline mode: test plan",
    emoji: "✈️",
    labels: ["testing"],
    parent: "Mobile 2.0 release plan",
    views: ["quang", "minh"],
    content: `# Offline mode: test plan

| # | Case | iOS | Android |
| --- | --- | --- | --- |
| 1 | 20 invoices in airplane mode, then sync | ✅ | ✅ |
| 2 | Kill the app in the middle of a sync | ✅ | ✅ |
| 3 | Same invoice edited on two phones | ✅ | ⏳ |
| 4 | Phone full, no space for photos | ✅ | ❌ message unclear |
| 5 | Clock set two days ahead | ✅ | ✅ |
| 6 | 24 hours offline, six devices | ⏳ | ⏳ |

Case 6 runs Tuesday to Wednesday. Phones stay in the meeting room, please do not connect them.
`,
  },
  {
    space: "PROD",
    by: "phong",
    title: "Billing portal: one-page brief",
    emoji: "💳",
    labels: ["portal", "brief"],
    star: ["phong", "owner"],
    views: ["owner", "anh", "yuki", "noah", "lena"],
    comments: [["lena", "Average fee in our data is 1.4%, I updated the number.", "1.4%"]],
    content: `# Billing portal: one-page brief

## Problem
Our customers wait **34 days** for their money. Not because clients do not want to pay: the PDF is in an inbox, the bank app is elsewhere, and the IBAN has 22 characters.

## For whom
The client who gets an invoice. They did not choose us and do not want an account.

## What we build
1. A page per invoice: see it, pay it, done
2. All invoices of that client, after an email code
3. Reminders that stop by themselves

## What we do not build
Accounts and passwords, disputes, instalments beyond one part payment.

## How we know it works
| | Now | Goal |
| --- | --- | --- |
| Days to payment | 34 | 29 |
| "Please send it again" emails per 100 invoices | 9 | 6 |
| Paid on the first visit | 38% | 60% |

## Risks
- Card fees (1.4% on average): decision this week
- DATEV access is late: CSV first
`,
  },
  {
    space: "PROD",
    by: "phong",
    title: "Interviews: what 12 clients told us",
    emoji: "🎧",
    labels: ["research", "portal"],
    parent: "Billing portal: one-page brief",
    views: ["yuki", "owner", "sam"],
    content: `# Interviews: what 12 clients told us

> "I pay when I find it. Finding it is the problem."

## What we heard
- **9 of 12** pay from the phone, mostly in the evening
- **7 of 12** typed an IBAN wrong at least once
- **0 of 12** want another account
- **5 of 12** like reminders, if they are friendly

## What we changed
1. No account. A safe link, and an email code for the rest
2. The amount is on the button
3. Bank transfer comes first in Germany, cards in the UK
`,
  },
  {
    space: "ENG",
    by: "noah",
    title: "Runbook: account migration",
    emoji: "🚚",
    labels: ["runbook", "migration"],
    views: ["minh", "quang", "sam"],
    comments: [["minh", "Please add how long the rollback took in the rehearsal."]],
    content: `# Runbook: account migration

## Before
- [x] Dry run 1 on a copy of production (2 h 40 m, 3 differences)
- [ ] Dry run 2 (Thursday)
- [ ] Rollback rehearsal

## A wave
\`\`\`bash
migrate plan  --wave 3 > wave-3.csv
migrate run   --wave 3 --dry-run
migrate run   --wave 3
migrate check --wave 3   # must print: 0 differences
\`\`\`

## Going back
1. \`migrate pause\`
2. Set the flag \`sync-v2\` to 0 for the wave
3. \`migrate check --reverse\`

Both services are written to for 14 days, so nothing is lost.

## The two big accounts
By hand, Sunday 23:00, after Sam has called them.
`,
  },
  {
    space: "ENG",
    by: "minh",
    title: "How we review code",
    emoji: "🔍",
    labels: ["how-we-work"],
    star: ["anh"],
    views: ["anh", "quang", "noah"],
    content: `# How we review code

1. **Small.** Under 400 lines, one idea.
2. **Fast.** First look within four working hours.
3. **Kind.** Ask before you assert. Say what is good.
4. **Clear.** Mark what blocks the merge and what is taste.

An agent may write the change. A person approves the plan before it starts, and another person reviews the pull request. Same rules, no exceptions.
`,
  },
  {
    space: "ENG",
    by: "minh",
    title: "Postmortem: payments delayed on October 14",
    emoji: "🧯",
    labels: ["postmortem"],
    views: ["owner", "noah", "sam", "lena"],
    content: `# Postmortem: payments delayed on October 14

**Impact:** 63 payments shown 47 minutes late. No money lost, nobody charged twice.

## Timeline (London)
| Time | What happened |
| --- | --- |
| 09:02 | Provider sends every webhook twice |
| 09:10 | Queue grows, workers retry each copy |
| 09:21 | Sam: two customers ask where their payment is |
| 09:34 | Noah finds the duplicate, pauses retries |
| 09:49 | Queue empty |

## Why
We treated a second copy as new work. One slow check per copy filled the workers.

## What we changed
- [x] Copies are dropped by event id
- [x] Alert when the oldest job is over 5 minutes
- [x] Status page is updated by whoever is on call
`,
  },
  {
    space: "LAUNCH",
    by: "trinh",
    title: "Launch calendar: T-14 to T+14",
    emoji: "🗓️",
    labels: ["launch", "plan"],
    star: ["trinh", "owner", "sam"],
    views: ["owner", "phong", "yuki", "sam", "minh"],
    comments: [["phong", "Moved the webinar to the 9th so Daniel can join."]],
    content: `# Launch calendar: T-14 to T+14

| Day | What | Owner |
| --- | --- | --- |
| T-14 | Film: last comments | Claire |
| T-11 | Go/no-go | Minh |
| T-10 | Launch post final, translations start | Claire |
| T-7 | Submit to both stores | Daniel |
| T-6 | Press pitches out, embargo | Claire |
| T-3 | Help center live | Sam |
| **T** | **5% rollout, post, email wave 1** | Minh, Claire |
| T+2 | 25%, webinar, email wave 2 | Priya |
| T+7 | 100%, emails 3 and 4 | Claire |
| T+14 | Review: numbers, what we learned | everyone |
`,
  },
  {
    space: "LAUNCH",
    by: "trinh",
    title: "Launch post, draft 2",
    emoji: "✍️",
    labels: ["content"],
    parent: "Launch calendar: T-14 to T+14",
    views: ["owner", "phong"],
    comments: [["owner", "This is the one. Cut the last sentence and ship it.", "Before you are back in the van"]],
    content: `# Finish the job, send the invoice, get paid

Marta fixes a boiler in a basement in Lisbon. No signal. She writes the invoice while the water heats up: 24 seconds. Her customer taps a card on her phone. Paid.

That is Sunrise Mobile 2.0.

## Three things changed
**It takes 24 seconds.** One screen instead of six. Your last customers and prices are already there.

**It works without a signal.** Write, photograph, sign. It syncs when you are back.

**You get paid on the spot.** Tap to pay, no reader, no monthly fee.

## What it does not do yet
Card payments need a connection. And phones older than iOS 15 or Android 10 stay on version 1, which we keep working.

Finish the job, send the invoice, get paid. Before you are back in the van.
`,
  },
  {
    space: "LAUNCH",
    by: "yuki",
    title: "Press kit",
    emoji: "📦",
    labels: ["press"],
    views: ["trinh"],
    content: `# Press kit

- **What:** Sunrise Mobile 2.0, invoicing for small companies
- **When:** December 7, embargo 9:00 London
- **Numbers:** 18,400 companies · 1.1 million invoices last year · 24 s median for a new invoice
- **Quote (Alex Morgan):** "Our customers did not start a company to do paperwork. We took it off their evening."

Screenshots in five languages, the film in 60, 20 and 6 seconds, and the portraits are in the Drive folder *Press kit 2.0*.
`,
  },
  {
    space: "TEAM",
    by: "owner",
    title: "How we work at Sunrise",
    emoji: "☀️",
    labels: ["how-we-work"],
    star: ["owner", "lena", "sam"],
    views: ["minh", "anh", "quang", "noah", "trinh", "phong", "yuki", "sam", "lena"],
    comments: [["noah", "I read this on my first day and it was all true. Rare."]],
    content: `# How we work at Sunrise

## Four habits
1. **Write it down.** If it was decided in a call, it is a decision on the meeting page.
2. **One owner.** Every task has one name on it.
3. **Say it early.** A task at risk on Tuesday is a plan. On Friday it is a surprise.
4. **Leave at a good hour.** Nobody here is paid to be tired.

## Our week
| | |
| --- | --- |
| Monday | Weekly, 30 minutes, with an agenda |
| Wednesday | No meetings |
| Friday | Demo: show something that works |

## AI
Use it. Never paste customer data into a tool that is not ours. Agents propose, people approve.
`,
  },
  {
    space: "TEAM",
    by: "lena",
    title: "Leave, sick days and travel",
    emoji: "🌴",
    labels: ["people", "policy"],
    views: ["anh", "yuki", "quang"],
    content: `# Leave, sick days and travel

- **25 days** a year, five can move to the next one
- Sick? Tell your manager by 10:00. A note from day four
- Travel: book yourself up to €300, ask for more in Approvals
- Two people of one team are not away in a release week
`,
  },
];

// ── read by seed-extra.mjs ──────────────────────────────────────────────

/** Task dependencies, by how the titles start: [waits, for]. */
export const DEPENDENCIES = [
  ["Submit 2.0", "Crash on Android"],
  ["Submit 2.0", "Store listing"],
  ["Submit 2.0", "Tap to pay"],
  ["Move 18,400", "Offline mode"],
  ["Pilot with", "Invoice page"],
  ["Pilot with", "Automatic payment"],
  ["Automatic payment", "Secure links"],
  ["Email to 18,400", "Write the launch post"],
];

/** Project status updates: [project, author, days ago, health, text]. */
export const UPDATES = [
  [
    "mobile",
    "minh",
    11,
    "on_track",
    "Beta closed with 28 of 30 companies active. The one-screen editor tested at a median of 24 seconds. Next: certification for tap to pay and the last offline cases.",
  ],
  [
    "mobile",
    "minh",
    1,
    "at_risk",
    "Two things stand between us and December 7: the Android 12 camera crash (fix in review) and the migration dry run (3 differences, second run on Thursday). Tap to pay is certified on iOS, Android is waiting for one log file. If the crash fix holds for 48 hours we submit next Monday as planned.",
  ],
  ["portal", "phong", 8, "on_track", "Interviews changed the plan for the better: no accounts. Designs are final, card payments work on staging."],
  [
    "portal",
    "phong",
    1,
    "on_track",
    "Invoice page is at 55% and loads in 0.8 s. Security review of the links arrives on Wednesday. DATEV access is late, so we start with CSV. Lakeshore signed the pilot letter.",
  ],
  [
    "campaign",
    "trinh",
    1,
    "on_track",
    "Film: second cut approved except two shots. Launch post draft 2 is with Alex. 12 of 25 journalists pitched, 4 answered. The pricing page waits for the fee decision.",
  ],
];

const ALL = ["owner", "minh", "anh", "quang", "noah", "trinh", "phong", "yuki", "sam", "lena"];
/** Meetings: [title, working day, "HH:MM", minutes, organizer, attendees, location, project, agenda, notes, action items [title, who, due, status], series?]. */
export const EXTRA_MEETINGS = [
  [
    "Company weekly",
    -5,
    "09:30",
    30,
    "owner",
    ALL,
    "Online",
    null,
    "1. Numbers of the week (Lena, 5 min)\n2. Mobile 2.0: what could stop us? (Minh, 10 min)\n3. Billing portal: what the interviews changed (Priya, 10 min)\n4. Anything else (5 min)",
    `## Numbers
- 18,400 paying companies, +112 this week
- First answer in support: 104 minutes
- Crash-free sessions: 98.4%

## Mobile 2.0
Minh: three open risks, each has an owner. Certification for tap to pay is the slowest because it is not in our hands. Plan B is to release without it on Android and add it two weeks later. **Nobody likes plan B, everybody accepts it.**

## Billing portal
Priya showed four clips of the interviews. Clear message: no account.

## Decisions
- The portal has **no client accounts**. Safe link plus email code.
- The Friday demo moves to 16:00 until the release.`,
    [
      ["Send the certification logs for Android again", "noah", -3, "done"],
      ["Write down plan B for tap to pay on one page", "minh", -4, "done"],
    ],
  ],
  [
    "Company weekly",
    0,
    "09:30",
    30,
    "owner",
    ALL,
    "Online",
    null,
    "1. Numbers of the week (Lena, 5 min)\n2. Two weeks to release: red, yellow, green (Minh, 10 min)\n3. Support plan for launch week (Sam, 5 min)\n4. Film, first cut (Claire, 5 min)\n5. Questions (5 min)",
    `## Numbers
- **18,400** paying companies (+96)
- First answer in support: **98 minutes**, best week ever
- Crash-free sessions: **98.9%** (goal 99.5%)
- Cash: as planned. 2027 budget draft goes to Alex on Friday

## Two weeks to release
| | Status | Next step |
| --- | --- | --- |
| Offline mode | 🟡 | Conflict screen, then 24-hour test |
| Tap to pay | 🟡 | Android certificate, expected Tuesday |
| Camera crash | 🔴 | Fix in tonight's beta, watch for 48 h |
| Migration | 🟡 | Second dry run on Thursday |
| Store listing | 🟢 | Four languages to go |

## Support in launch week
Sam asks for two freelancers for two weeks (€3,360). Request is in Approvals. Everyone takes one shift of two hours.

## Film
Everybody loved it. Two spots show the old icon.

## Decisions
- Code freeze on **Wednesday 17:00**.
- Go/no-go on **Thursday 15:00**. If the crash fix does not hold, we move by one week and say so the same day.`,
    [
      ["Watch the crash rate for 48 hours and report in #mobile-2-0", "quang", 3, "in_progress"],
      ["Support rota for December 7 to 18", "sam", 2, "in_progress"],
      ["Replace the old icon in the film at 0:14 and 0:41", "trinh", 1, "todo"],
      ["Second migration dry run, share the differences", "noah", 3, "todo"],
    ],
  ],
  [
    "Billing portal: design review",
    0,
    "15:30",
    45,
    "phong",
    ["yuki", "anh", "noah", "lena", "owner"],
    "Online",
    "portal",
    `**Goal:** agree on the client's overview so Ana can start on Wednesday.

1. Walkthrough on a phone (Yuki, 10 min)
2. Paying several invoices at once: what happens if one fails? (Noah, 10 min)
3. Where do we show the fee? (Lena, 10 min)
4. Decide and write it down (15 min)

Please open the prototype before: 5 minutes, on your own phone.`,
    "",
    [],
  ],
  [
    "Mobile 2.0 daily",
    0,
    "16:45",
    15,
    "minh",
    ["quang", "noah", "anh", "phong", "owner"],
    "Online",
    "mobile",
    "Only what is red or yellow. Fifteen minutes, then back to work.",
    "",
    [],
  ],
  [
    "Film: lock the picture",
    1,
    "11:00",
    30,
    "trinh",
    ["yuki", "owner", "phong"],
    "Online",
    "campaign",
    "1. Watch the second cut twice, no pausing\n2. Changes: only what is wrong, not what is taste\n3. Lock",
    "",
    [],
  ],
  [
    "1:1 Alex and Minh",
    1,
    "14:00",
    30,
    "owner",
    ["minh"],
    "Online",
    null,
    "- How is the team doing two weeks before the release?\n- On-call plan: too much for one person?\n- Hiring: second mobile engineer in spring?",
    "",
    [],
  ],
  [
    "Payment fees: decide",
    2,
    "10:00",
    45,
    "lena",
    ["owner", "phong", "sam"],
    "Online",
    "portal",
    `**Decision needed:** who pays card fees in the portal?

| Model | Small customer (40 invoices) | Large customer (1,100) |
| --- | --- | --- |
| A. We pay all | €0 | €0 (costs us €610) |
| B. At cost + 0.3% | €9 | €310 |
| C. Flat €19 a month | €19 | €19 |

Lena recommends **B**, bank transfer always free. Please read the legal note before.`,
    "",
    [],
  ],
  [
    "Mobile 2.0 go/no-go",
    3,
    "15:00",
    60,
    "minh",
    ["owner", "quang", "noah", "anh", "phong", "sam", "trinh"],
    "Meeting room Sol + online",
    "mobile",
    `**We leave this meeting with a yes or a no.**

1. Crash-free sessions, 48 hours after the fix (Daniel)
2. Payments: certification and success rate (Noah)
3. Migration: second dry run (Noah)
4. Offline: six devices, 24 hours (Priya)
5. Support and help center (Sam)
6. Store listing and campaign (Claire)
7. Vote, each with one sentence

**Rule:** one red gate is a no. We then pick the new date in the same meeting.`,
    "",
    [],
  ],
  [
    "Friday demo",
    4,
    "16:00",
    45,
    "phong",
    ALL,
    "Online",
    null,
    "Three demos, ten minutes each, no slides:\n1. Conflict screen (Daniel)\n2. Paying three invoices with one tap (Ana)\n3. Film, final cut (Claire)",
    "",
    [],
  ],
  [
    "Lakeshore Logistics: pilot kick-off",
    7,
    "13:00",
    60,
    "sam",
    ["phong", "lena", "owner"],
    "Online",
    "portal",
    "1. Who is who\n2. Which 40 clients, and why\n3. Branding and bank details: what we need by December 14\n4. The weekly page of numbers\n5. What would make them say no after four weeks?",
    "",
    [],
  ],
  [
    "Friday demo",
    -1,
    "16:00",
    45,
    "phong",
    ALL,
    "Online",
    null,
    "1. Push when an invoice is paid (Ana)\n2. Tap to pay, live with a real card (Noah)\n3. Help center, first seven articles (Sam)",
    `## Shown
- **Push when paid:** arrives in 3 seconds. Grouping works.
- **Tap to pay:** Alex bought a coffee from Noah for €2.40. It worked the first time, in front of everyone.
- **Help center:** Sam's "What moved where" guide. Lena, who has never seen 2.0, found everything.

## Questions we took home
- Can the push say *which* bank account? (Ana: later)
- What happens above €500? (Noah: PIN on screen, shown on Monday)`,
    [["Demo the PIN flow above €500", "noah", 4, "todo"]],
  ],
  [
    "Beta retrospective with five customers",
    -3,
    "14:00",
    60,
    "sam",
    ["phong", "yuki", "owner", "quang"],
    "Online",
    "mobile",
    "1. What did you use every day?\n2. What did you stop using?\n3. If we took it away tomorrow, would you mind?\n4. Open floor",
    `Five companies: a plumber, a florist, a moving company, a translator and a bike shop.

## What they use every day
The editor (all five), duplicating an invoice (four), photos (three).

## What annoys them
- "The conflict screen asked me about a *note*. I do not care about notes." (moving company)
- "I did not know I could take a card." (florist) → we have to say it louder
- The dark PDF preview confused two of them

## Best quote
> "I did my invoices at a red light. Please do not tell my wife." (plumber)

## Decisions
- Ask about a conflict only when the **amount** differs.
- First start shows tap to pay in one sentence.`,
    [
      ["Ask about conflicts only when the amount differs", "quang", 1, "in_progress"],
      ["First-start sentence about tap to pay", "yuki", 2, "done"],
    ],
  ],
  [
    "Campaign sync",
    -4,
    "11:00",
    30,
    "trinh",
    ["yuki", "phong", "sam", "owner"],
    "Online",
    "campaign",
    "1. Calendar T-14 to T+14\n2. Press list\n3. Email waves and the rollout",
    `- Calendar agreed, every line has one owner
- Emails follow Noah's migration waves, not our wishes
- Webinar moves to **December 9** so Daniel can show offline mode live
- Budget for ads: Claire sends a request with a stop rule`,
    [["Request for the ad budget with a stop rule", "trinh", -3, "done"]],
  ],
];

/**
 * Chat: [channel, author, working days ago, "HH:MM", text, { r: {emoji: [people]}, t: [[author, "HH:MM", text]], pin }].
 * "dm:<person>" is a direct message with the owner.
 */
export const EXTRA_CHAT = [
  [
    "general",
    "owner",
    4,
    "09:02",
    "Good morning everyone ☀️ Two weeks and a bit until Mobile 2.0. The plan, the gates and who can stop it are on one page: *Mobile 2.0 release plan*. Please read it once, it takes four minutes.",
    { r: { "👍": ["minh", "anh", "sam", "lena"], "🚀": ["quang", "noah"] }, pin: true },
  ],
  [
    "general",
    "lena",
    4,
    "10:15",
    "Reminder: expenses for November until the 30th please. Photos of receipts are fine, pizza without a receipt is not 🍕",
    {
      r: { "😂": ["anh", "noah", "yuki"] },
      t: [
        ["noah", "10:21", "What about pizza with a witness?"],
        ["lena", "10:23", "The witness pays."],
        ["anh", "10:24", "😂 noted"],
      ],
    },
  ],
  [
    "general",
    "sam",
    1,
    "17:20",
    "Numbers of the week from support: **214 tickets, first answer in 98 minutes, 93% happy**. A year ago we needed five hours. Thank you to everyone who took a shift.",
    { r: { "🎉": ["owner", "minh", "trinh", "phong", "lena"], "❤️": ["yuki", "anh"] } },
  ],
  [
    "general",
    "owner",
    0,
    "10:06",
    "Notes and decisions of the weekly are on the meeting page. Short version:\n- Code freeze **Wednesday 17:00**\n- Go/no-go **Thursday 15:00**\n- Film: everybody loved it, comments until tomorrow evening",
    { r: { "👍": ["minh", "trinh", "phong", "sam", "noah"] } },
  ],
  [
    "general",
    "lena",
    0,
    "11:30",
    "I am off on Friday (moving house 📦). Payroll runs on Thursday, please send changes to me by Wednesday noon.",
    {
      r: { "👍": ["owner", "sam"] },
      t: [
        ["yuki", "11:34", "Good luck! Do you need boxes? I have twelve."],
        ["lena", "11:36", "You are my hero. Yes please 🙏"],
      ],
    },
  ],

  [
    "mobile-2-0",
    "quang",
    3,
    "14:10",
    "Queue and number blocks are merged. Twenty invoices on throttled 3G sync in 11 seconds. {{Offline mode}} is down to the conflict screen.",
    { r: { "🔥": ["minh", "noah", "phong"] } },
  ],
  [
    "mobile-2-0",
    "phong",
    3,
    "15:40",
    "From the beta retro: 9 in 10 conflicts are only about *notes*. Proposal: newest wins, and we ask only when the **amount** differs. @{quang} @{yuki} is that possible for 2.0?",
    {
      t: [
        ["yuki", "15:46", "Design-wise yes, the screen stays the same, it just appears less often."],
        ["quang", "15:52", "Yes. It is even less code. Tomorrow's build."],
        ["minh", "15:55", "Agreed. Please add it to the decisions on the release plan."],
        ["phong", "16:02", "Done ✅"],
      ],
      r: { "💯": ["sam", "anh"] },
    },
  ],
  [
    "mobile-2-0",
    "noah",
    2,
    "10:12",
    "iOS certificate for tap to pay is here 🟢 Android wants one more log file, sent it ten minutes ago. {{Tap to pay}}",
    { r: { "🎉": ["owner", "minh", "lena", "quang"], "💳": ["phong"] } },
  ],
  [
    "mobile-2-0",
    "phong",
    2,
    "16:25",
    "Crash on the office Galaxy A52: open the camera twice, quickly, and the app closes. 5 of 5 times. Filed as {{Crash on Android}} with steps.",
    {
      t: [
        ["quang", "16:31", "Looking now."],
        ["quang", "17:48", "Found it. We start a camera session before the old one reports closed. Two-line fix, and a test that is longer than the fix."],
        ["minh", "17:52", "As it should be 👌"],
      ],
    },
  ],
  [
    "mobile-2-0",
    "minh",
    1,
    "09:30",
    "Status for everyone: *at risk*, and here is why.\n1. Camera crash: fix in review\n2. Migration dry run: 3 differences out of 18,400, all rounding\n3. Android certificate: expected Tuesday\n\nIf 1 holds for 48 hours we submit on Monday as planned.",
    { r: { "👀": ["owner", "trinh", "sam"] }, pin: true },
  ],
  [
    "mobile-2-0",
    "anh",
    1,
    "15:05",
    "Push when paid works: the phone buzzes three seconds after the payment. Slightly addictive. {{Push notification}}",
    { r: { "😍": ["yuki", "trinh"], "👏": ["owner", "phong"] } },
  ],
  [
    "mobile-2-0",
    "noah",
    1,
    "16:40",
    "For the record: @{owner} bought a coffee from me for €2.40 with a real card, on stage, first try ☕",
    {
      r: { "☕": ["owner", "minh", "anh", "quang", "phong", "sam"], "😂": ["trinh"] },
      t: [
        ["owner", "16:44", "Best €2.40 of the year."],
        ["lena", "16:47", "I will need a receipt."],
      ],
    },
  ],
  [
    "mobile-2-0",
    "quang",
    0,
    "09:58",
    "Beta build 2.0.0 (418) goes out tonight with the camera fix. I post the crash rate here every morning until Thursday.",
    { r: { "🙏": ["minh", "phong"] } },
  ],
  [
    "mobile-2-0",
    "yuki",
    0,
    "11:05",
    "English store screenshots are done, French and German by tonight. Which one should come first?",
    {
      poll: ["Get paid on the spot", "Invoice in 30 seconds", "Works without a signal"],
      votes: { owner: "o1", minh: "o2", quang: "o3", phong: "o1", sam: "o1", trinh: "o1", noah: "o1", anh: "o2" },
    },
  ],
  [
    "mobile-2-0",
    "sam",
    0,
    "11:48",
    '171 of 212 beta reports answered. The florist wrote back: "I took my first card payment today and did a little dance." 💃',
    { r: { "💃": ["owner", "phong", "trinh", "yuki"], "❤️": ["noah", "quang"] } },
  ],
  [
    "mobile-2-0",
    "minh",
    0,
    "12:02",
    "@{owner} one decision for you before Thursday: how long do we keep version 1? Options and numbers are in {{Decide: keep version 1}}. Sam and Noah are fine with B (until June 30).",
    {},
  ],

  [
    "billing-portal",
    "phong",
    4,
    "11:20",
    "All 12 interviews are in. One sentence: **nobody wants an account.** Clips are on the research page, start with number 7.",
    {
      r: { "👏": ["yuki", "owner"] },
      t: [
        ["lena", "11:31", "Number 7 is my father. Not literally. But it is my father."],
        ["yuki", "11:33", "Same 😄"],
      ],
    },
  ],
  [
    "billing-portal",
    "yuki",
    3,
    "10:30",
    "Final screens for the invoice page are up, phone and desktop. Biggest change after the tests: the button says *Pay €420.00* instead of *Pay now*.",
    { r: { "😍": ["phong", "anh"], "👍": ["noah"] } },
  ],
  [
    "billing-portal",
    "anh",
    1,
    "11:15",
    "Card payments work on staging. First load 0.8 s, 61 KB of JavaScript. I would like to keep it under 70. {{Invoice page}}",
    {
      r: { "⚡": ["minh", "noah", "phong"] },
      t: [
        ["minh", "11:22", "Put 70 into CI, then it stays true."],
        ["anh", "11:40", "Done, it fails at 70."],
      ],
    },
  ],
  [
    "billing-portal",
    "sam",
    1,
    "14:20",
    "Lakeshore signed the pilot letter ✍️ 40 clients, four weeks, start in January. Their finance lead wants the numbers every Friday before 15:00. {{Pilot with}}",
    { r: { "🎉": ["owner", "phong", "lena", "trinh", "minh"] } },
  ],
  [
    "billing-portal",
    "lena",
    0,
    "10:40",
    "Fees: I ran three models with the numbers of 50 real customers. Summary is in the agenda of Wednesday's meeting, please read it before. {{Payment fees}}",
    {
      t: [
        ["phong", "10:52", "Super clear. One question: does B include refunds?"],
        ["lena", "10:58", "Yes, the 0.3% covers them up to a rate of 2%. We are at 0.7%."],
      ],
    },
  ],
  [
    "billing-portal",
    "noah",
    0,
    "11:20",
    "Security review of the links arrives on Wednesday. While waiting I changed the log order as @{minh} asked: the opening is written before the page renders. {{Secure links}}",
    { r: { "👍": ["minh"] } },
  ],

  [
    "launch",
    "trinh",
    4,
    "12:05",
    "Calendar is final, T-14 to T+14, one owner per line. If your name is there and you did not know: surprise 🎁",
    { r: { "😂": ["phong", "sam"], "👍": ["yuki", "owner"] } },
  ],
  [
    "launch",
    "trinh",
    2,
    "15:30",
    "The *Launch content* workflow gave me a first draft in six minutes. It stopped for approval, I said no to the ending, and it asked why. I have had interns with less patience. {{Write the launch post}}",
    {
      r: { "😄": ["phong", "yuki"], "🤖": ["owner"] },
      t: [
        ["owner", "15:41", "Open with Marta's van, not with us. And the 24 seconds go into the first paragraph."],
        ["trinh", "15:44", "Both are in draft 2."],
      ],
    },
  ],
  [
    "launch",
    "trinh",
    1,
    "10:00",
    "Film, second cut. Sixty seconds, one van, no actors. Comments until tomorrow evening please. {{Customer film}}",
    {
      r: { "😭": ["sam"], "❤️": ["owner", "yuki", "phong"] },
      t: [
        ["yuki", "10:20", "It is beautiful. Two spots with the old icon: 0:14 and 0:41."],
        ["sam", "10:26", "I know the product and I still want to buy it."],
        ["owner", "10:33", "Agree with Sam. Please do not touch the music."],
      ],
    },
  ],
  [
    "launch",
    "phong",
    1,
    "16:10",
    "Webinar is on December 9 at 16:00 London. Daniel does offline mode live, with a phone in airplane mode. 87 sign-ups in four hours.",
    { r: { "🔥": ["trinh", "sam"] } },
  ],
  [
    "launch",
    "trinh",
    0,
    "11:15",
    "Press: 12 of 25 pitched, 4 answered, one wants a call with @{owner} on release day at 10:00. Can I say yes?",
    {
      t: [
        ["owner", "11:27", "Yes. Please put it into my calendar."],
        ["trinh", "11:28", "Done 📅"],
      ],
    },
  ],
  ["launch", "yuki", 0, "11:52", "Pricing page is ready except one number: the fee. Waiting for Wednesday. {{Pricing page}}", {}],

  [
    "customers",
    "sam",
    3,
    "09:40",
    '> "I did my invoices at a red light. Please do not tell my wife."\nPlumber, beta group',
    { r: { "😂": ["owner", "anh", "noah", "trinh", "quang", "lena"] } },
  ],
  [
    "customers",
    "sam",
    2,
    "13:10",
    '> "We had three people chasing payments. Now it is one, and the two others do real work."\nLakeshore Logistics, finance lead',
    { r: { "❤️": ["phong", "lena", "owner"] } },
  ],
  [
    "customers",
    "anh",
    1,
    "12:15",
    'From the accessibility test: "It is the first invoicing app where I did not ask my daughter for help." 4 of 6 flows pass with the screen off, two to go. {{Accessibility pass}}',
    { r: { "❤️": ["owner", "yuki", "sam", "minh", "phong"] } },
  ],
  [
    "customers",
    "sam",
    0,
    "10:20",
    "One to learn from: Harborview (60,000 invoices) got two different answers from us about the migration night. My mistake. I called, apologized, and there is now one page: *Runbook: account migration*.",
    { r: { "🙏": ["owner", "noah"] } },
  ],

  ["wins", "lena", 3, "16:30", "Month-end close in **five days**. It was nine in spring. Nobody stayed late.", { r: { "🎉": ["owner", "sam", "minh", "trinh"] } }],
  ["wins", "minh", 2, "11:00", "Build pipeline: 34 minutes → 11. @{quang} and I celebrate with an actual lunch break.", { r: { "🚀": ["anh", "noah", "phong"], "🥪": ["quang"] } }],
  [
    "wins",
    "phong",
    0,
    "09:15",
    "Beta, last question: *How would you feel if you could no longer use it?* **71% very disappointed.** The bar for a good product is 40.",
    { r: { "🎉": ["owner", "minh", "anh", "quang", "noah", "trinh", "yuki", "sam", "lena"], "😮": ["owner"] }, pin: true },
  ],

  [
    "random",
    "noah",
    3,
    "12:40",
    "Sourdough report: day 4, the starter has a name. Gerald is doing well.",
    {
      r: { "🍞": ["lena", "yuki", "anh"] },
      t: [
        ["lena", "12:44", "Is Gerald on the payroll?"],
        ["noah", "12:45", "He works nights."],
      ],
    },
  ],
  ["random", "yuki", 1, "13:05", "Lunch playlist is open again. Rule: one song per person, no guilt.", { r: { "🎶": ["trinh", "sam", "quang"] } }],
  [
    "random",
    "anh",
    0,
    "08:55",
    "Lisbon this morning: 19 degrees and sun. I am not saying this to hurt anyone in London.",
    { r: { "😎": ["trinh"], "🌧️": ["quang", "phong", "sam"] } },
  ],

  ["dm:minh", "minh", 1, "18:05", "Quick one before the weekend: Daniel is close to done and tired. I took the Saturday watch so he is really off.", {}],
  ["dm:minh", "owner", 1, "18:11", "Good call. Let us talk about the on-call plan on Tuesday, I do not want it on one person.", {}],
  ["dm:minh", "minh", 0, "09:12", "Saturday was quiet, two alerts, both harmless. I put the plan into our 1:1 agenda.", { r: { "🙏": ["owner"] } }],
  ["dm:trinh", "trinh", 0, "11:02", "Alex, draft 2 of the post is in the Launch space. It needs your yes by Wednesday so the translators can start.", {}],
  ["dm:trinh", "owner", 0, "11:40", "Reading it at lunch.", {}],
  ["dm:lena", "lena", 0, "10:05", "2027 budget: draft one is done, three scenarios. Do you prefer to see it alone first or directly with Minh and Claire?", {}],
  ["dm:lena", "owner", 0, "10:30", "Alone first, 20 minutes on Friday morning? Then with everyone next week.", {}],
  ["dm:lena", "lena", 0, "10:31", "I am moving house on Friday 😅 Thursday 9:00?", {}],
  ["dm:lena", "owner", 0, "10:33", "Of course. Thursday 9:00 it is.", {}],
  ["dm:sam", "sam", 0, "11:55", "Harborview is calm again. They asked for a Sunday night migration with me on the phone, I said yes.", { r: { "❤️": ["owner"] } }],
];

/** Messages after which the owner has not read further: some badges, as on a real morning. */
export const UNREAD = { launch: 1, "billing-portal": 1, "mobile-2-0": 1, "dm:sam": 1 };

export const STATUS = [
  ["quang", "🎧", "Camera crash, back at 15:00"],
  ["yuki", "🎨", "Store screenshots"],
  ["sam", "📞", "Customer calls until noon"],
  ["lena", "📦", "Moving house on Friday"],
];

export const DECISIONS = [
  [
    "phong",
    "portal",
    "No client accounts in the billing portal",
    "Twelve interviews, nobody wants one. A safe link per invoice, and an email code to see the others.",
    "owner",
    true,
  ],
  [
    "phong",
    "mobile",
    "Ask about a sync conflict only when the amount differs",
    "9 in 10 conflicts in the beta were about notes. Newest edit wins; the other version stays in the history.",
    "minh",
    true,
  ],
  ["minh", "mobile", "Invoice numbers in blocks of 50 per device", "Offline phones need numbers that never clash. Gaps are allowed by the tax rules of our markets.", "minh", true],
  ["phong", "mobile", "How long do we keep version 1 working?", "Recommendation: until June 30, fixes only. About 2,100 people are on phones that cannot run 2.0.", "owner", false],
];

/** The plan-approve-draft run of the launch post is left to the app: the task is handed to this workflow template. */
export const WORKFLOW_TASK = [/launch post/i, "launch-content", "trinh"];
