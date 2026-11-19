/**
 * Demo company for seed-demo.mjs: Workspace, a six-person open-source team building the product of the same name.
 * English content (the default locale). Hung Tran is the owner created at /setup; the five named people below are
 * invited by the seed. Task rows: [title, status, assignee, priority, due (days from today, null = none), extra?],
 * where extra is { desc, blocked, progress, sub: [[title, status, assignee]], comment: [author, text] }.
 */

/** department key → name, and the project its finished work (the 8-week history) goes into. */
export const DEPARTMENTS = [
  { key: "eng", name: "Engineering", project: "v1" },
  { key: "growth", name: "Product & Growth", project: "marketing" },
];
export const deptName = (key) => DEPARTMENTS.find((d) => d.key === key).name;

/** The named people: heads report to the owner. */
const CORE = [
  { key: "minh", name: "Minh Tran", dept: "eng", head: true, title: "Tech Lead", admin: true, location: "Ho Chi Minh City" },
  { key: "anh", name: "Anh Tran", dept: "eng", title: "Frontend Engineer", location: "Ho Chi Minh City" },
  { key: "quang", name: "Quang Nguyen", dept: "eng", title: "Desktop & Infra Engineer", location: "Remote" },
  { key: "trinh", name: "Trinh Le", dept: "growth", head: true, title: "Marketing & Community", location: "Ho Chi Minh City" },
  { key: "phong", name: "Phong Le", dept: "growth", title: "Product & QA", location: "Remote" },
];

/** No generated filler people: the story is these five plus the owner. */
const TEAMS = [];

export const CLIENTS = ["Lakeshore Logistics"];

export function company(domain) {
  const people = CORE.map((p) => ({ ...p, email: `${p.key}@${domain}`, location: p.location ?? "Ho Chi Minh City" }));
  for (const p of people) {
    if (p.head) p.manager = "owner";
    else p.manager = CORE.find((c) => c.dept === p.dept && c.head).key;
    p.role = p.head ? "Manager" : null;
  }
  const team = new Map();
  const at = (ref) => {
    if (!ref.startsWith("@")) return ref;
    throw new Error(`unknown team ${ref}`);
  };
  const resolve = (tasks) =>
    tasks.map(([title, status, who, prio, due, extra]) => [
      title,
      status,
      at(who),
      prio,
      due,
      extra && { ...extra, sub: extra.sub?.map(([t, s, w]) => [t, s, at(w)]), comment: extra.comment && [at(extra.comment[0]), extra.comment[1]] },
    ]);
  const projects = PROJECTS.map((p) => ({ ...p, tasks: resolve(p.tasks) }));
  const history = HISTORY.map((h) => ({ ...h, titles: h.titles.map(([t, who, desc]) => [t, at(who), desc]) }));
  return { people, team, projects, history, at };
}

/** title → description for every seeded task (project boards + history). Used by seed and by `--task-descs`. */
export function taskDescriptions() {
  const out = new Map();
  for (const pr of PROJECTS) {
    for (const [title, , , , , extra] of pr.tasks) {
      if (extra?.desc) out.set(title, extra.desc);
    }
  }
  for (const h of HISTORY) {
    for (const [title, , desc] of h.titles) {
      if (desc) out.set(title, desc);
    }
  }
  return out;
}

const PROJECTS = [
  {
    key: "v1",
    owner: "minh",
    name: "Open source v1.0: web and desktop",
    description: "Ship the self-hosted web app and the Tauri desktop shell as v1.0: install, backup, meetings, Playwright green, signed image.",
    due: 14,
    tasks: [
      [
        "AI › Connect: one pasted line connects Claude Code, Codex and Ollama",
        "todo",
        "minh",
        "high",
        5,
        {
          desc: "Admin › AI › Connect: paste one line (Claude Code, Codex or Ollama) and the workspace uses that model. No separate env vars for the happy path. Acceptance: paste → test OK → assistant answers.",
        },
      ],
      [
        "One-command install: clean server to first sign-in in under 10 minutes",
        "todo",
        "quang",
        "high",
        7,
        {
          desc: "Documented curl | bash (or compose up) on a clean Ubuntu/Debian VPS: Postgres, app, Caddy. Clock starts on empty disk; stops at the owner's first sign-in. Target under 10 minutes on 2 vCPU / 2 GB.",
        },
      ],
      [
        "Desktop: signed updates from GitHub Releases",
        "todo",
        "quang",
        "urgent",
        12,
        {
          blocked: "Waiting for a maintainer decision on code signing",
          desc: "Tauri updater pulls signed artifacts from GitHub Releases. Blocked on the code-signing ADR (unsigned vs we hold certs). Wire the updater channel once the ADR lands.",
        },
      ],
      [
        "Desktop: global shortcut",
        "todo",
        "quang",
        "medium",
        10,
        {
          desc: "System-wide shortcut brings the desktop window to the front (or toggles show/hide). Respect OS reserved shortcuts; configurable later is fine for v1.0.",
        },
      ],
      [
        "Full task page: remove the white panel behind the cards",
        "todo",
        "anh",
        "low",
        11,
        {
          desc: "On the full task page the cards still sit on a white panel from the old layout. Remove it so the page matches Home and the board; keep spacing and section order.",
        },
      ],
      [
        "Run backup.sh, restore.sh and upgrade.sh on the single-server layout",
        "in_progress",
        "quang",
        "high",
        3,
        {
          progress: 70,
          desc: "Restore from last night's backup worked on a clean VPS in 4 minutes. Upgrade script next: pull image, migrate, reload Caddy without dropping chat sockets longer than a minute.",
        },
      ],
      [
        "LiveKit meetings and Web Push in the production compose",
        "in_progress",
        "minh",
        "high",
        4,
        {
          progress: 40,
          desc: "Production compose ships LiveKit + Web Push (VAPID) with the app. Meetings join from Calendar; push reaches the desktop and browser. Staging works; wire secrets and health checks for prod.",
        },
      ],
      [
        "Full Playwright suite green, about 110 tests",
        "in_progress",
        "phong",
        "high",
        2,
        {
          progress: 85,
          desc: "About 110 E2E tests against the test installation. 96 green; remaining failures follow the old Home layout selectors. Retarget to data-testid; do not block the tag on four Home cases if product signs off.",
          comment: ["phong", "96 of 110 green. The rest still follow the old Home layout."],
        },
      ],
      [
        "Desktop: tray badge for unread messages",
        "in_progress",
        "quang",
        "medium",
        6,
        {
          progress: 50,
          desc: "Tray / dock badge shows unread chat + notification count from the home feed. Clear when the window is focused and the user has read the threads. macOS and Windows first; Linux best-effort.",
        },
      ],
      [
        "People pickers: search the whole directory",
        "in_progress",
        "anh",
        "medium",
        5,
        {
          progress: 35,
          desc: "Assignee and mention pickers only search the first page of members. Search the whole directory (debounce, server search). Same component on tasks, docs and calendar.",
        },
      ],
      [
        "Real Let's Encrypt certificate through Caddy",
        "review",
        "quang",
        "high",
        1,
        {
          desc: "Production Caddyfile requests a real Let's Encrypt cert for the company domain. HTTP→HTTPS redirect; renew works on the single-server layout. Review: staging ACME run on the demo VPS.",
        },
      ],
      [
        "Goals tab: replace the old flat list styling",
        "review",
        "anh",
        "medium",
        2,
        {
          desc: "Goals still use the interim flat list. Match the new Work tabs: hierarchy, progress and owners readable at a glance. No behaviour change to KRs.",
        },
      ],
      [
        "Desktop builds for macOS, Windows and Linux in CI",
        "review",
        "quang",
        "high",
        3,
        {
          desc: "CI matrix builds Tauri for macOS, Windows and Linux and uploads artifacts. Signing may stay off until the ADR; unsigned artifacts are enough to prove the pipeline.",
        },
      ],
      [
        "Desktop: workspace:// links open the right screen",
        "done",
        "quang",
        "medium",
        -8,
        {
          desc: "Deep links workspace://app/... open the desktop shell on the matching route (task, channel, doc). Covered by a smoke test on macOS.",
        },
      ],
      [
        "Board columns are statuses",
        "done",
        "anh",
        "medium",
        -14,
        {
          desc: "Board columns map 1:1 to task statuses (todo / in progress / review / done). Dragging a card updates status; no free-form columns in the default board.",
        },
      ],
      [
        "English as the default, four languages complete",
        "done",
        "phong",
        "medium",
        -10,
        {
          desc: "Default locale is English; vi, zh and es catalogs complete with fallback to en for missing keys. First-run setup and the web shell respect the choice.",
        },
      ],
      [
        "Home › Today for owners",
        "done",
        "anh",
        "medium",
        -12,
        {
          desc: "Owners see Today: due work, approvals waiting, and at-risk projects. Same Home shell as everyone else; owner-only sections hide when the viewer is not an owner.",
        },
      ],
    ],
  },
  {
    key: "marketing",
    owner: "trinh",
    name: "Marketing the open source launch",
    description: "The public launch of v1.0: posts, video, store listings, demo and install help.",
    due: 21,
    tasks: [
      [
        "Draft the Show HN post",
        "todo",
        "trinh",
        "high",
        8,
        {
          desc: "Show HN title + first comment (≤120 words) from the launch post draft. Lead with workflows that wait for approval; link install one-liner. Keep the draft in the Launch space doc.",
        },
      ],
      [
        "Reply templates for common install questions",
        "todo",
        "trinh",
        "medium",
        12,
        {
          desc: "Short reply templates for: Docker not found, port 80/443 busy, migrate failed, forgot owner password, how to add a member. Tone from the community reply guide; paste-ready for GitHub Discussions and email.",
        },
      ],
      [
        "Bring the public demo online",
        "todo",
        "quang",
        "high",
        10,
        {
          blocked: "Waiting for the signed image on GHCR",
          desc: "Public demo workspace on a small VPS, reset hourly from the seed snapshot. Blocked until the signed image is on GHCR. Then: DNS, Caddy, demo clock, seed refresh cron.",
        },
      ],
      [
        "Write the launch post for v1.0",
        "in_progress",
        "trinh",
        "urgent",
        4,
        {
          progress: 20,
          desc: "Audience: engineering teams and founders of tech companies who self-host. Lead with three things: workflows that wait for a person's approval, AI adoption with sample sizes, web and desktop from one install. Plain tone, no hype. Source: the v1.0 changelog doc. Attach the Ship a change / launch-content workflow.",
          comment: ["owner", "Lead with the approval step. People are tired of agents that ship on their own."],
        },
      ],
      [
        "Record the 30-second launch video",
        "in_progress",
        "trinh",
        "high",
        5,
        {
          progress: 10,
          desc: "Hero: Ship a change. Shot list is in the Launch space. Record on staging; no real customer data. Export 1080p for README and X.",
        },
      ],
      [
        "Desktop app screenshots for the README",
        "in_progress",
        "anh",
        "medium",
        6,
        {
          progress: 40,
          desc: "Three README screenshots: board, chat + task, Ship a change approval. Light theme, English UI, fake company name Workspace. Same window chrome on macOS.",
        },
      ],
      [
        "Chrome Web Store and Firefox Add-ons listing for the extension",
        "review",
        "quang",
        "medium",
        3,
        {
          desc: "Store listing copy + screenshots for the AI Insights extension. Privacy blurb matches the in-product notice. Package from pnpm ext:zip; ready to submit once legal OK.",
        },
      ],
      [
        "Label 15 good first issues",
        "done",
        "phong",
        "low",
        -6,
        {
          desc: "Fifteen GitHub issues tagged good first issue with a clear acceptance note and pointer to CONTRIBUTING. Mix of docs, i18n and small UI.",
        },
      ],
      [
        "Two-week launch calendar, every channel",
        "done",
        "trinh",
        "medium",
        -9,
        {
          desc: "Day-by-day calendar for Show HN, X, GitHub release, store listings and demo go-live. Owners per channel; in the Launch space as Launch plan.",
        },
      ],
      [
        "Social preview image",
        "done",
        "anh",
        "low",
        -11,
        {
          desc: "1200×630 OG image: product name, one line on approval-first workflows, no stock photo. Used on GitHub and the launch post.",
        },
      ],
      [
        "README in vi, zh and es",
        "done",
        "phong",
        "medium",
        -7,
        {
          desc: "README.vi.md, README.zh.md, README.es.md mirror the English install and feature summary. Links from the main README language list.",
        },
      ],
    ],
  },
  {
    key: "roadmap",
    owner: "owner",
    name: "Roadmap: phases after v1.0",
    description: "What comes after the open-source launch: mobile, people/data, scale-out and sign-in.",
    due: 45,
    tasks: [
      [
        "Phase 2, mobile: scope the Capacitor shells for iOS and Android",
        "todo",
        "quang",
        "medium",
        20,
        {
          desc: "Spike: Capacitor wrappers around the web app for iOS and Android. List what breaks (push, file open, deep links). Parked until code-signing ownership is clear.",
        },
      ],
      [
        "Phase 3, people and data: handover when someone leaves, whole-workspace export and delete",
        "todo",
        "phong",
        "medium",
        25,
        {
          desc: "When a member leaves: reassign tasks, remove from channels, export their AI Insights. Workspace-level export + delete for the company admin. Write the threat model before UI.",
        },
      ],
      [
        "Phase 4, scale out: decide when one server is no longer enough",
        "todo",
        "minh",
        "low",
        30,
        {
          desc: "Criteria for leaving the single-process event bus (ADR-0021): connections, message rate, AI queue depth. One page of options; no build until a real install hits the limit.",
        },
      ],
      [
        "Sign-in: passkeys, SAML, breached-password check, pick an order",
        "todo",
        "minh",
        "medium",
        22,
        {
          desc: "Order the next auth work: passkeys, SAML/OIDC for companies, HIBP-style breached password check. Prefer what self-hosters ask for in the first 30 days of issues.",
        },
      ],
      [
        "Collect the top requests from the first 30 days of issues",
        "in_progress",
        "phong",
        "high",
        10,
        {
          progress: 30,
          desc: "Tag and rank GitHub issues and Discussions after launch. Weekly roll-up into this task; feeds the public roadmap page and phase ordering.",
        },
      ],
      [
        "Decide on code signing for desktop builds",
        "in_progress",
        "owner",
        "urgent",
        3,
        {
          progress: 15,
          desc: "ADR in the Team space: ship unsigned for v1.0 vs hold Apple/Windows certs. Decide before tagging so desktop updates and the public demo know which path we took.",
        },
      ],
      [
        "AI: safety net inside the company assistant, estimate",
        "in_progress",
        "minh",
        "medium",
        14,
        {
          progress: 25,
          desc: "Estimate effort to run the same sensitive-data redact/block path on the company assistant (not only the browser extension). Spike on prompt size and false positives; one-page estimate.",
        },
      ],
      [
        "Write the public roadmap page",
        "review",
        "phong",
        "medium",
        7,
        {
          desc: "Public markdown/page: phases 2–4 and sign-in, with status (parked / next / later). Matches the Roadmap doc in Team; ready to link from README after ADR on signing.",
        },
      ],
    ],
  },
];

/** Finished work over the last weeks: [title, assignee, description], into the department's project. */
const HISTORY = [
  {
    dept: "eng",
    project: "v1",
    titles: [
      [
        "Fix Caddy Socket.IO upgrade for chat",
        "minh",
        "Caddy was not upgrading WebSocket for /socket.io; chat reconnect looped. Fixed the reverse-proxy matcher and added a smoke check.",
      ],
      [
        "Local-disk uploads with signed expiring links",
        "quang",
        "STORAGE_DRIVER=local serves /storage/<token> with short-lived signatures; no public bucket required for single-server installs.",
      ],
      ["Board column status sync on import", "anh", "Notion/CSV import maps columns to statuses instead of leaving tasks stuck in todo."],
      ["Tray badge reads unread from home feed", "quang", "Desktop tray badge uses the same unread counters as Home; cleared on focus."],
      ["People picker first-page bug", "anh", "Picker showed duplicates when the first page of members was shorter than the page size."],
      ["Migrate work schema for agent runs", "minh", "Agent workflow runs and pause columns landed in the work schema; old runs stay readable."],
      ["PWA install banner on desktop", "anh", "Hide the web install banner when the Tauri shell is already hosting the app."],
      ["Backup script dry-run mode", "quang", "backup.sh --dry-run prints what would be copied without writing a tarball."],
      ["Playwright: login and Home smoke", "phong", "E2E: password login and Home › Today load on the test installation."],
      ["Playwright: chat send and thread", "phong", "E2E: send a channel message and open its thread."],
      ["Fix timezone on calendar events", "minh", "All-day and timed events respect the workspace timezone instead of the browser's."],
      ["Desktop connect page polish", "anh", "Connect-to-company page: clearer URL field, error copy, and keyboard submit."],
      ["CI: signed SBOM on the image", "quang", "Release job attaches a signed SBOM to the container image on GHCR."],
      ["Rate limit per IP behind Caddy", "minh", "Gateway rate limits use the real client IP from Caddy's forwarded headers."],
      ["Unread counts on channel_members", "minh", "Unread is stored per member; sidebar badges no longer recount the whole channel."],
      ["Window board cards after show more", "anh", "Board 'show more' no longer clips the last card under the window edge."],
      ["Doc comments: replace O(n²) grouping", "anh", "Doc comment threads group in linear time; large pages stay responsive."],
      ["LiveKit room join token expiry", "minh", "Join tokens expire in 2 hours; renew from the meeting page without dropping the room."],
      ["Extension site registry: 16 AI sites", "quang", "Browser extension knows 16 AI product hosts for prompt capture with the notice."],
      ["English-first i18n fallback", "phong", "Missing vi/zh/es keys fall back to English instead of showing the key path."],
      ["Goals flat-list interim fix", "anh", "Goals tab readable until the full redesign; owners and progress visible."],
      ["Restore script on empty volumes", "quang", "restore.sh works when data/ volumes are empty (fresh VPS), not only on replace."],
      ["Task peek refresh storm", "anh", "Opening task peek no longer refetches the whole board on every keystroke."],
      ["Web Push VAPID key docs", "quang", "Document how to generate and set VAPID keys for Web Push in production."],
    ],
  },
  {
    dept: "growth",
    project: "marketing",
    titles: [
      ["Draft GitHub About blurb", "trinh", "Short GitHub About text: self-hosted work management, approval-first agents, one install."],
      ["Good first issues labels pass 1", "phong", "First pass of good-first-issue labels before the full set of 15."],
      ["Social preview HTML mock", "anh", "HTML mock for the OG image layout before the final export."],
      ["Launch calendar week 1", "trinh", "Week-1 slice of the two-week launch calendar (channels and owners)."],
      ["Translate README keys for zh", "phong", "Chinese strings for the README feature summary and install section."],
      ["Translate README keys for es", "phong", "Spanish strings for the README feature summary and install section."],
      ["Show HN draft outline", "trinh", "Outline for the Show HN first comment before the full draft task."],
      ["Extension store listing copy", "trinh", "Draft store listing: what the extension records, the notice, and how to disconnect."],
      ["Demo seed refresh button copy", "phong", "Admin copy for the demo clock / seed refresh control on a demo workspace."],
      ["Weekly sync notes template", "phong", "Template for weekly sync: done / next / blocked — used in the Team space."],
      ["Launch video shot list", "trinh", "Second-by-second shot list for the 30s Ship a change video."],
      ["Competitor comparison notes", "trinh", "Internal notes: self-hosted peers vs SaaS; what we say and what we do not claim."],
      ["Install FAQ draft", "phong", "First draft of install FAQ before reply templates."],
      ["Roadmap page wireframe", "phong", "Wireframe for the public roadmap page (phases and status chips)."],
      ["Chrome Web Store screenshots brief", "trinh", "Brief for store screenshots: notice UI, connect flow, Insights sample."],
      ["Community reply tone guide", "trinh", "Tone guide for maintainers answering install and feature questions."],
    ],
  },
];

export const GOALS = [
  {
    title: "Ship open source v1.0",
    owner: "minh",
    department: "eng",
    krs: [
      { title: "Open source v1.0: web and desktop", kind: "project", project: "v1" },
      { title: "Playwright tests green", kind: "number", start: 0, target: 110, current: 96, unit: "tests" },
    ],
  },
  {
    title: "Launch to the open-source community",
    owner: "trinh",
    department: "growth",
    krs: [
      { title: "Marketing the open source launch", kind: "project", project: "marketing" },
      { title: "Channels with a launch post ready", kind: "number", start: 0, target: 4, current: 1, unit: "channels" },
    ],
  },
  {
    title: "A clear roadmap after v1.0",
    owner: "owner",
    department: "growth",
    krs: [
      { title: "Roadmap: phases after v1.0", kind: "project", project: "roadmap" },
      { title: "Phases scoped with owners", kind: "number", start: 0, target: 4, current: 1, unit: "phases" },
    ],
  },
];

export const EXTENSION = [
  ["anh", "https://chatgpt.com/c/demo-anh-1", ["How do I keep a Next.js route under 200 KB of JS gzip?", "Lazy-load the whiteboard editor without breaking SSR"]],
  [
    "trinh",
    "https://claude.ai/chat/demo-trinh-1",
    ["Five headline options for the v1.0 launch post about self-hosted workflows", "Rewrite this launch post opening without hype words"],
  ],
  ["phong", "https://gemini.google.com/app/demo-phong-1", ["Turn these GitHub issue titles into a three-phase roadmap table"]],
  [
    "quang",
    "https://chatgpt.com/c/demo-quang-1",
    [
      "Why does our release job fail to push the image? docker login ghcr.io -u workspace-bot -p ghp_abcdefghijklmnopqrstuvwxyz0123456789 returns denied. First reported by our design partner Lakeshore Logistics (anna@lakeshore-logistics.example).",
    ],
  ],
  ["minh", "https://claude.ai/chat/demo-minh-1", ["Plan the LiveKit production compose checklist", "Draft the AI › Connect paste-one-line UX for Claude Code, Codex and Ollama"]],
];

export const APPROVALS = [
  ["quang", "owner", "purchase", "Apple Developer Program, $99/year", "Needed to sign the macOS desktop build and TestFlight.", 99],
  ["quang", "owner", "purchase", "Windows code-signing certificate", "EV cert so SmartScreen stops blocking the installer.", 370],
  [
    "minh",
    "owner",
    "purchase",
    "Demo server for 12 months",
    "2 vCPU / 2 GB VPS for the public demo, billed yearly.",
    120,
    ["approved", "Go ahead. Keep it on the same region as GHCR."],
  ],
  ["anh", "minh", "other", "Annual leave, 2 days", "Family visit next week.", null],
];

/**
 * Document spaces and pages for the Docs home (spaces as cards, page trees, comments, stars).
 * `parent` is the parent page title in the same space (null = under the space home).
 * `comments`: [author, body, quote?]; `star`: person keys who star the page; `views`: who opens it once.
 */
export const DOC_SPACES = [
  {
    key: "ENG",
    name: "Engineering",
    icon: "⚙️",
    description: "Release, install, desktop and test notes for open-source v1.0.",
    by: "minh",
  },
  {
    key: "LAUNCH",
    name: "Open source launch",
    icon: "📣",
    description: "Posts, video, store listings and the public demo for the v1.0 launch.",
    by: "trinh",
  },
  {
    key: "TEAM",
    name: "Team",
    icon: "🏠",
    description: "How we work, weekly sync and decisions that span the whole company.",
    by: "owner",
  },
];

export const DOCS = [
  {
    space: "ENG",
    by: "minh",
    title: "v1.0 release checklist",
    emoji: "🚀",
    labels: ["release", "v1"],
    star: ["owner", "minh", "phong"],
    views: ["owner", "quang", "anh", "phong"],
    comments: [
      ["quang", "Restore on a clean VPS is green. I am on the upgrade script next.", "backup.sh, restore.sh and upgrade.sh"],
      ["phong", "Playwright is 96/110. I will leave the Home-layout failures listed under Testing."],
    ],
    content: `# v1.0 release checklist

Ship when every box is green. Owner of each line in parentheses.

## Install and ops
- [ ] \`backup.sh\`, \`restore.sh\` and \`upgrade.sh\` green on a clean VPS (Quang)
- [ ] Real Let's Encrypt certificate through Caddy (Quang)
- [ ] Signed image on GHCR with SBOM (Quang)

## Product
- [ ] LiveKit meetings and Web Push in the production compose (Minh)
- [ ] Desktop builds for macOS, Windows and Linux in CI (Quang)
- [ ] Desktop: signed updates from GitHub Releases — blocked on code-signing ADR (Quang)
- [ ] Full Playwright suite green, about 110 tests (Phong)

## Launch hand-off
- [ ] Tag v1.0
- [ ] Publish the launch post (Trinh)
- [ ] Public demo online (blocked on GHCR image)
`,
  },
  {
    space: "ENG",
    by: "minh",
    title: "v1.0 changelog and upgrade notes",
    emoji: "📋",
    labels: ["release", "changelog"],
    views: ["owner", "trinh", "phong"],
    comments: [["trinh", "I will pull the Added section into the launch post. Keep the upgrade steps as-is."]],
    content: `# v1.0 changelog (draft)

## Added
- Self-hosted install in one command (Postgres, app, Caddy).
- Desktop app (Tauri) with \`workspace://\` links.
- Workflows for tech teams: ship a change, fix a bug, review a PR, triage, specs, release notes, postmortem, launch content.
- AI adoption with sample sizes; tokens counted as input and output, not money.
- Browser extension AI Insights (opt-in), sensitive-data redact.

## Upgrade
1. Take a backup with \`backup.sh\`.
2. Pull the new image and run \`upgrade.sh\`.
3. Open Admin › Settings and confirm the setup checklist.

## Not ready yet
- Public demo URL (blocked on GHCR image).
- Capacitor mobile shells (phase 2).
`,
  },
  {
    space: "ENG",
    by: "quang",
    title: "Install and backup runbook",
    emoji: "🛠️",
    labels: ["ops", "runbook"],
    parent: "v1.0 release checklist",
    views: ["minh", "owner"],
    comments: [["minh", "Add the four-minute restore timing — useful for the launch post."]],
    content: `# Install and backup runbook

## Fresh install
\`\`\`bash
curl -fsSL https://get.workspace.example/install.sh | bash
\`\`\`
Target: clean Ubuntu 22.04 / Debian 12, 2 vCPU / 2 GB, ports 80 and 443 open. First sign-in under ten minutes.

## Backup
\`\`\`bash
./backup.sh
\`\`\`
Writes Postgres dump + \`data/\` volume to \`./backups/<timestamp>\`.

## Restore (tested)
\`\`\`bash
./restore.sh ./backups/<timestamp>
\`\`\`
Last dry run on a clean VPS: **4 minutes** to first sign-in.

## Upgrade
\`\`\`bash
./upgrade.sh
\`\`\`
Pulls the image, runs migrations, reloads Caddy. Still in progress.
`,
  },
  {
    space: "ENG",
    by: "phong",
    title: "Playwright: remaining failures",
    emoji: "🧪",
    labels: ["testing"],
    parent: "v1.0 release checklist",
    views: ["minh", "anh"],
    content: `# Playwright: remaining failures

**Score:** 96 of 110 green.

## Still red (old Home layout)
1. Home › Today owner cards — expect the new section order.
2. Notification group expand — selector follows the old list.
3. Meeting due chip — copy changed; assert on \`data-testid\` instead.
4. Recurring meeting group — flake under parallel workers.

## Plan
- Retarget selectors to \`data-testid\` only.
- Run the Home suite serially until the flake is gone.
- Do not block the tag on the four Home cases if product signs off.
`,
  },
  {
    space: "ENG",
    by: "anh",
    title: "Frontend polish queue for v1.0",
    emoji: "🎨",
    labels: ["frontend"],
    views: ["minh"],
    content: `# Frontend polish queue for v1.0

Open before tag; none of these are launch blockers alone.

| Item | Status | Owner |
| --- | --- | --- |
| Full task page: remove white panel behind cards | todo | Anh |
| Goals tab: replace flat list styling | in review | Anh |
| People pickers: search the whole directory | in progress | Anh |
| Desktop connect page polish | done | Anh |
| Window board cards after show more | done | Anh |
`,
  },
  {
    space: "LAUNCH",
    by: "trinh",
    title: "Launch plan: two weeks, every channel",
    emoji: "📣",
    labels: ["launch", "plan"],
    star: ["owner", "trinh", "phong"],
    views: ["owner", "minh", "anh", "phong", "quang"],
    comments: [
      ["owner", "Lead with the approval step. People are tired of agents that ship on their own.", "Lead with three things"],
      ["phong", "I can cut the README screenshots once Anh finishes the desktop set."],
    ],
    content: `# Launch plan: two weeks, every channel

Audience: engineering teams and founders who self-host. Tone: plain, no hype.

## Week 1
- Finish the launch post (Ship a change / launch-content workflow on the task).
- Record the 30-second video (Ship a change hero).
- Desktop screenshots for the README (Anh).
- Label 15 good first issues (done).

## Week 2
- Show HN, X thread, GitHub release notes (from the same draft).
- Chrome Web Store and Firefox Add-ons listing live.
- Public demo online (blocked on signed GHCR image).

## Proof points
1. Workflows that wait for a person's approval.
2. AI adoption with sample sizes; tokens in / out, not money.
3. Web and desktop from one install.
`,
  },
  {
    space: "LAUNCH",
    by: "trinh",
    title: "Launch post draft (v1.0)",
    emoji: "✍️",
    labels: ["launch", "draft"],
    parent: "Launch plan: two weeks, every channel",
    views: ["owner", "minh"],
    comments: [["owner", "Opening is good. Cut the second paragraph — too many product names before the approval story."]],
    content: `# Launch post draft (v1.0)

**Working title:** Self-hosted work management where agents wait for you

Most agent demos ship on their own. Ours stop for approval.

Workspace is a self-hosted app for one company: chat, tasks, docs, calendar and meetings in one install. Optional AI: your own model in Admin › AI connections, and ChatGPT / Claude / Gemini / Copilot through the browser extension — with a notice, and with tokens counted as input and output, not dollars.

## What ships in v1.0
- One-command install (Postgres, app, Caddy).
- Desktop app with \`workspace://\` links.
- Agent workflows: plan → approve → code → review → PR.
- AI Insights on outside AI use (opt-in).

## Try it
\`\`\`bash
curl -fsSL https://get.workspace.example/install.sh | bash
\`\`\`

Public demo: pending signed image on GHCR.
`,
  },
  {
    space: "LAUNCH",
    by: "trinh",
    title: "30-second video shot list",
    emoji: "🎬",
    labels: ["launch", "video"],
    parent: "Launch plan: two weeks, every channel",
    views: ["owner", "anh"],
    content: `# 30-second video shot list

Hero line on screen: **Ship a change.**

| Sec | Shot | VO / text |
| --- | --- | --- |
| 0–4 | Task "Write the launch post" opens | "An agent that waits for you." |
| 4–12 | Workflow steps: plan → approve → draft | Tap Approve on the plan. |
| 12–18 | AI Insights: tokens in / out | "Adoption in tokens, not invoices." |
| 18–24 | Chat + board + doc in one window | "Chat, tasks and docs together." |
| 24–30 | Install one-liner + desktop window | "One install. Web and desktop." |

Record on the staging workspace; no real customer data.
`,
  },
  {
    space: "LAUNCH",
    by: "trinh",
    title: "Show HN draft",
    emoji: "🍊",
    labels: ["launch"],
    views: ["owner"],
    content: `# Show HN draft

**Title:** Show HN: Workspace – self-hosted tasks, chat and agent workflows that wait for approval

**First comment (≤120 words):**
We built Workspace for companies that want one self-hosted place for chat, tasks and docs — and optional AI that does not run ahead of people. The workflow that ships with v1.0 is "Ship a change": the agent plans, a human approves, then it codes and opens a PR. AI use outside the company (ChatGPT, Claude, Gemini, Copilot) can be recorded with a notice through a browser extension; we show tokens in and out, not spend. Install is one command. Looking for feedback from teams who self-host.
`,
  },
  {
    space: "TEAM",
    by: "owner",
    title: "Draft ADR: code signing for desktop builds",
    emoji: "📝",
    labels: ["adr", "desktop"],
    star: ["owner", "quang"],
    views: ["minh", "quang", "phong"],
    comments: [
      ["quang", "Apple Developer Program is $99/year — approval is already in the queue. EV cert for Windows is the expensive part.", "cost of EV certs"],
      ["minh", "Prefer option B for v1.1; ship unsigned with docs for v1.0 so we do not block the tag."],
    ],
    content: `# Draft ADR: code signing for desktop builds

**Status:** proposed  
**Deciders:** Hung (owner), Quang (desktop)

## Context
Companies may need a signed desktop build. Unsigned macOS and Windows installs hit Gatekeeper / SmartScreen.

## Options
1. **Ship unsigned** and document how each company signs their own build.
2. **We hold certificates** and sign releases on GitHub Actions (Apple Developer Program + Windows EV).
3. **Hybrid:** unsigned for v1.0; option 2 after the first paying self-hosters ask for it.

## Open questions
- Cost of EV certs and who owns the Apple Developer account.
- Who rotates secrets in GitHub Actions.
- Whether the public demo needs a signed build on day one (no).

## Proposal
Take option 1 for v1.0. Revisit option 2 in phase 2 if install support volume justifies it.
`,
  },
  {
    space: "TEAM",
    by: "phong",
    title: "Weekly sync notes",
    emoji: "🗓️",
    labels: ["sync"],
    views: ["owner", "minh", "trinh", "anh", "quang"],
    content: `# Weekly sync

**Week of launch −2**

## Done
- Restore on clean VPS (4 minutes).
- Playwright 96/110.
- Launch calendar for every channel.
- README in vi, zh and es.

## Next
- Upgrade script.
- Launch post (Ship a change on the task).
- Code-signing ADR decision.
- Finish Home-layout Playwright failures.

## Blocked
- Public demo (GHCR signed image).
- Signed desktop updates (maintainer decision — see ADR).
`,
  },
  {
    space: "TEAM",
    by: "phong",
    title: "Roadmap: phases after v1.0",
    emoji: "🗺️",
    labels: ["roadmap"],
    views: ["owner", "minh"],
    comments: [["owner", "Phase 2 stays parked until code signing is decided — same dependency as desktop updates."]],
    content: `# Roadmap: phases after v1.0

## Phase 2 — Mobile
Capacitor shells for iOS and Android. Blocked on desktop code-signing ownership (same certificates story).

## Phase 3 — People and data
Handover when someone leaves; whole-workspace export and delete.

## Phase 4 — Scale out
Decide when one server is no longer enough (shared event bus).

## Sign-in
Passkeys, SAML, breached-password check — pick an order after v1.0 feedback.
`,
  },
  {
    space: "TEAM",
    by: "minh",
    title: "How we use workflows",
    emoji: "🤖",
    labels: ["workflows"],
    star: ["minh"],
    views: ["anh", "quang", "trinh"],
    content: `# How we use workflows

Templates live under Work › Workflows. Copy one into the company library, then attach it to a task.

| When | Template | Runner |
| --- | --- | --- |
| Feature or launch copy | Ship a change / Launch content | local / server |
| Production bug | Fix a bug | local |
| PR review | Review a pull request | local |
| Inbox bug | Bug triage | server |
| Spec before build | Feature spec | server |
| Tag notes | Release notes | server |
| Incident write-up | Incident postmortem | server |

Rules: every AI step ends with an approval or a human status change. One ask round per step. Prefer \`{{task}}\` and \`{{previous}}\` over pasting the same brief twice.
`,
  },
];

export const MEETINGS = [
  ["Weekly sync", 0, 10, 45, "owner", ["minh", "anh", "quang", "trinh", "phong"], "Online"],
  ["v1.0 go/no-go", 0, 15, 60, "minh", ["owner", "quang", "phong", "trinh"], "Online"],
  ["Launch video review", 1, 14, 45, "trinh", ["owner", "anh", "phong"], "Online"],
  ["Roadmap workshop: phase 2", 2, 11, 60, "owner", ["minh", "quang", "phong"], "Online"],
  ["Friday demo", 4, 16, 45, "minh", ["anh", "quang", "trinh", "phong", "owner"], "Online"],
  ["1:1 Hung / Minh", 1, 9, 30, "owner", ["minh"], "Online"],
];

export const CHANNELS = [
  { name: "general", topic: "The whole team", members: "all" },
  { name: "v1-launch", displayName: "v1 launch", topic: "Open source v1.0: web and desktop", members: ["eng", "growth"] },
  { name: "marketing", displayName: "Marketing", topic: "Launch posts, video and community", members: ["growth", "eng"] },
  { name: "roadmap", displayName: "Roadmap", topic: "Phases after v1.0", members: ["eng", "growth"] },
  { name: "random", topic: "Anything else", members: "all" },
];

export const CHAT = [
  ["general", "owner", "Morning — from this week all v1.0 and launch work lives here. Questions in #general."],
  ["general", "minh", "Restore from last night's backup worked on a clean VPS, 4 minutes end to end. Upgrade script next."],
  ["general", "phong", "Playwright: 96 of 110 green. The rest still follow the old Home layout."],
  ["v1-launch", "quang", "Let's Encrypt through Caddy is in review. Desktop CI builds for the three OSes are next."],
  ["v1-launch", "anh", "People pickers now hit identity/members/search — still wiring the UI."],
  ["v1-launch", "minh", "LiveKit + Web Push in the production compose is about 40% done."],
  ["marketing", "trinh", "Running the Marketing / Launch content workflow on the launch post. Hung, the draft will wait for you."],
  ["marketing", "owner", "Good. Lead with the approval step — no revolutionary, please 🙂"],
  ["marketing", "anh", "Desktop screenshots for the README are in progress; I'll drop them in the doc when ready."],
  ["marketing", "phong", "README vi/zh/es is done for the keys we had last week."],
  ["roadmap", "minh", "One server holds a million rows fine. I'd keep scale-out for phase 4."],
  ["roadmap", "phong", "Collecting the top requests from early issues — table draft in the roadmap doc."],
  ["roadmap", "quang", "Capacitor shells are phase 2; I won't start until v1.0 ships."],
  ["random", "trinh", "Coffee shop near the office has a new cold brew. Not a blocker."],
  ["random", "anh", "Anyone else seeing Turbopack warm the Goals tab slowly on first open?"],
];
export const CELEBRATE = /worked on a clean VPS|96 of 110|is done for the keys/;

export const LEAVE = [
  ["anh", "annual", 5, 6, "approved", "Family visit"],
  ["quang", "annual", 12, 12, "pending", "Personal"],
];

export const ANNOUNCEMENTS = [
  ["owner", "event", "v1.0 go/no-go today at 15:00", "Backup/restore, Playwright and the launch post. Online.", true, [0, 15]],
  ["trinh", "general", "Launch video shoot this week", "We need a clean demo workspace and one successful Ship a change run.", false, null],
  ["minh", "policy", "Code freeze for v1.0", "No new features on the v1 branch after Tuesday 17:00.", true, null],
];

void TEAMS;
