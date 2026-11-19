# Roadmap

workspace is a self-hosted, single-workspace work app. Work that is not about AI comes first; AI is an optional layer
each company configures with its own provider. What has shipped is in [CHANGELOG.md](CHANGELOG.md); this file lists
what is next.

## Release checks

The single-server layout ([ADR 0021](docs/adr/0021-one-server-no-valkey.md)) has been booted end to end from empty
volumes (`install.sh`, `/setup`, sign-in, chat over Socket.IO through Caddy, local-disk uploads, a container restart
keeping sessions). Still to run on it:

- `backup.sh`, `restore.sh` and `upgrade.sh`, then update the status notes in `infra/production/README.md` and the
  runbooks.
- The load test (`tooling/loadtest`), replacing the four-service capacity numbers in `infra/production/README.md` §10
  and `docs/runbooks/operations.md` (idle RAM of the whole stack is about 295 MB).
- A real Let's Encrypt certificate, LiveKit meetings and Web Push in the production compose.
- The full Playwright suite (about 110 tests); the targeted set is green.

## Product

- Handover when someone leaves: also move docs, drive, goals, owned-but-unassigned tasks, channels and calendar
  series; member erasure.
- Admin audit for task, doc and message deletions, approval decisions and salary reads; whole-workspace export and
  delete.
- The work calendar still assumes a Saturday–Sunday weekend (`GET employee/holidays` exposes `workWeek`).
- People pickers use the directory's first page (`identity/members/search` exists).
- UI: the Goals tab keeps the old flat list styling; the full task page (`/app/work/tasks/:id`) keeps the white panel
  behind the cards.
- Auth: breached-password check, password strength meter, "new device signed in" notice, passkeys.
- Whiteboards: Excalifont, Liberation Sans and the CJK fallback (Xiaolai) are not served (no licence in the font
  files; Xiaolai is 12 MB), so boards made elsewhere in those fonts show the system font; image paste from other
  boards' files; per-board comments; follow a collaborator's view.

## AI Insights

- x.com/i/grok in the extension (it would need host access to all of x.com).
- The data safety net (warn, redact, block) inside the company assistant, not only the extension.
- `ActivityController.audience` and `aiAudience` (`ai/audience.ts`) apply the same rule: share one helper.

## Scale

Measured with one workspace at a million rows (`tooling/loadtest/million-rows/`); paged screens stay fast. Bounded by
design: chat history, my tasks, board columns, the admin audit log, the calendar.

- `GET /chat/channels` runs four correlated subqueries per channel: keep unread and mention counts on
  `channel_members`.
- Lists that render everything: Requests (`OpsView` refreshes per item on "approve selected"), board cards accumulated
  through "show more" without windowing, members admin, doc comments (O(n²) grouping), thread replies, the saved,
  mentions and threads pages, past meetings, drive folders, AI conversations.
- Task peek refreshes the page behind it on every field save.
- `GET /attendance/team` is capped at 500.
- One server per installation: events, caches, rate limits and Socket.IO rooms live in its memory. Scaling out needs a
  shared event bus and a Socket.IO adapter again; the outbox, the consumer groups and the `<MODULE>_URL` indirection
  are kept for that.

## Later

- Native shells around the web app (the PWA covers phones and desktops today), not rewrites:
  - Mobile: Capacitor (iOS, Android) loading the company's own URL, validated against `/api/health`; APNs and FCM
    next to Web Push in the home module; `workspace://` and universal links onto `/app/...` routes; reliable iOS push,
    CallKit ringing, share sheet.
  - Desktop: the Tauri 2 app (`frontend/desktop/`) loads the company's server; still to add: a tray badge, a global
    shortcut, Web Push inside the app and signed updates from GitHub Releases.
  - Code signing and store distribution need a maintainer decision first (companies may need to sign their own build).
