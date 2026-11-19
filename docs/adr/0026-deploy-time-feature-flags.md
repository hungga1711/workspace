# ADR-0026: Optional features are left out at deploy time with one environment variable

- Status: Accepted
- Date: 2026-11-11

## Context

Not every company wants everything. A team that only needs chat and tasks should not see whiteboards, a calendar,
attendance or AI, and "hidden in the menu" is not enough: a feature that is not wanted should not answer at its
address or through the API either. The product rules hold: self-hosted, one workspace
([ADR-0023](0023-one-workspace-data-model.md)), every feature works without AI, no plans or tiers.

Two switches already existed and stay: the admin's `features.attendance` and the two AI switches (Admin › AI), which
are choices the company makes while running. What was missing is the operator's choice of what the installation is.

## Decision

- **One variable, read when the server starts**: `DISABLED_FEATURES=whiteboards,calendar`. Names: `docs` (documents
  and the file drive), `whiteboards`, `calendar` (calendar, events, meeting notes), `time` (attendance and leave),
  `ai` (assistant, AI Insights, agents and workflows, the AI section). Empty means everything, so existing
  installations do not change. Nothing is compiled in: the same image serves every combination, and no
  `NEXT_PUBLIC_*` value is involved.
- **Chat and tasks have no flag**, and neither do Home, sign-in, people and Admin. Asking to disable them is an
  unknown name: logged as a warning at start, never obeyed, and never a reason to stop.
- **One definition**: `DEPLOY_FEATURES` and the parser in `@workspace/shared` (`deploy-features.ts`). The platform
  module publishes every flag in the workspace's `features` (`docs: false`), next to the admin's switches; the web
  app reads only that (`lib/features.ts` on the server, `FeaturesProvider` / `useFeature` in the browser) and never
  parses the variable.
- **The deployment outranks the admin**: without `time`, `attendance` reads off whatever Settings says; without `ai`,
  `aiAssistant` and `aiMonitoring` read off. Everything that already followed those switches follows the flag, with
  no second code path.
- **Left out means absent**, at three levels:
  1. the gateway answers 404 `feature_off` for the feature's routes, reads and writes (`deployFeatureOf` in
     `gateway.ts`), and for the public calendar feed and the extension's intake; MCP tools of the feature are not
     listed; search does not return its kinds; the live-editing relays do not answer;
  2. the web app drops it from navigation, the create menu, the command palette, shortcuts, Home and Admin, and its
     pages are not-found (`requireFeature`);
  3. its outbound jobs do not run (AI topics and the weekly AI email, the yearly leave grant).
- **Data stays.** No migration, nothing deleted: removing the name and restarting brings the feature back as it
  was. Retention jobs keep running for a feature left out, so what was recorded still expires on schedule.

## Consequences

- A new optional feature adds its name to `DEPLOY_FEATURES`, its routes to `DEPLOY_ROUTES`, and its entries to the
  web's `Feature` type and `featureOfHref`; the tests of both lists fail until they agree with the code.
- Changing the variable needs a restart of the app container (it is not an admin setting on purpose: an admin
  cannot turn on what the operator left out).
- What tasks, chat and calls share stays on regardless: attachments (`/files`), video rooms (`/meet`), public
  holidays, requests.
- A task that came from a document, whiteboard or meeting still says so, without a link, when that feature is out.
