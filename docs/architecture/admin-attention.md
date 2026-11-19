# "Needs you": what an admin has to look at

Added 2026-11-13. Admin › Overview opens with one list of everything that is broken or about to break, each line
with the way to fix it. Before, each of these lived on its own page and an admin found out when someone complained.

## How it is put together

Every module answers for its own part with `GET /api/<module>/attention` (`{ items }`), from state it already keeps.
Nothing is stored for the list and nothing is dismissed by hand: an item is there while its cause is, and gone when
the cause is. The web's overview page (`/admin/workspace`) asks the modules the viewer may fix things in
(`frontend/web/src/components/admin/attention-sources.ts`; not ai when the deployment leaves AI out with
`DISABLED_FEATURES`), and each module answers only the kinds this person can act on.

| Module | Code | Who sees it | Items |
|---|---|---|---|
| ai | `backend/server/src/modules/ai/attention.ts` | `ai.agent.manage` (the model's state also `ai.policy.manage`) | The main model failing over (quota, outage); an enabled connection whose last check failed, or that was never checked; an outside tool (MCP server) with no company sign-in or an ended one, a failed check, three or more calls failing in a row in the last day, or never checked |
| work | `work/attention.ts` | Runs and workflow triggers: `ai.agent.manage`, runs only on tasks the reader may open. Task sync and hub connections: `workspace.configure` | A task's latest agent run that failed in the last 7 days; a run waiting over 24 hours for an approval or an answer; a run queued over 10 minutes with no connected computer that could take it; a task-sync connection that fails, or has not reported for 2 hours; a connection of the integrations hub whose last read failed; a workflow whose last three trigger fires in 7 days were all refused (the acting person lost access, a required input has no value, the hourly cap) |
| platform | `platform/attention.ts` | `workspace.configure` | A webhook the system switched off after repeated failures; one with three or more failed deliveries in a row |
| identity | `identity/attention.ts` | `workspace.configure` | A workspace API key that expires within 14 days; one that expired in the last 30 days while something was still using it |

An item: `id` (stable while the cause lasts), `kind`, `severity`, `since`, `name`, and where they apply `detail` (the
recorded error, clipped), `ownerId` (who set it up or started it), `count`, `taskCode`, `taskTitle`, `workflowId`. The web turns
`kind` into the sentence, the link and the button (`AttentionQueue.tsx`); a kind it does not know is left out.

## Rules

- **Missing data is unknown, never healthy.** A connection nobody checked, a sync that went quiet, are listed as
  `unknown`. A module whose read fails shows as "Could not check …" with a retry, not as an empty list. `since` is
  null when nobody knows since when, and the line says so.
- **Only what the system did.** A webhook a person switched off, or a personal API key, is their decision and is not
  listed.
- **One item per thing, the worst.** A server with a failed check and failing calls is one line.
- **No cost for anyone else.** Four small reads when an admin opens the overview, and again for the count on the
  admin menu's Overview entry; nothing on any other page.

## Adding a kind

Add it to the module's `attention.ts` (a pure function over rows, with a test), then to `KINDS` in
`frontend/web/src/components/admin/AttentionQueue.tsx` and the `admin.needs.k` texts (English first). A new module adds its key to
`attention-sources.ts`.
