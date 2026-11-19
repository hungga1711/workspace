# The integrations hub

Work that lives in another tool shows on the task it belongs to: a pull or merge request with its state, reviews and
checks; an issue; a design with its preview. The hub ships with **GitHub**, **GitLab** (gitlab.com or your own) and
**Figma**, and it is built so that anyone can add the next tool with one file ([Write an integration](#write-an-integration)).

It is read-only (nothing is ever written to the other tool), needs no AI, and costs nothing until a company connects
something: a task page in a workspace with no connection and no link makes one small request and draws nothing.

Not here: tools for the company's AI are [MCP servers](mcp-client.md), reading tasks from Asana, ClickUp, Linear or Jira
is [task sync](task-sync.md), apps and agents working in the workspace use [MCP](mcp.md) or the [API](../api/README.md).
A task's links and a project's reviews are also in both: `GET/POST /api/work/tasks/{id}/links`,
`GET /api/work/projects/{id}/reviews`, and the tools `list_task_links`, `link_work_to_task`, `project_reviews`.
Admin › Integrations lists all of them in one place.

## For admins

Admin › Integrations › **Connect your tools** (permission `workspace.configure`):

1. Pick the tool and paste a token. The dialog says what the token must be able to read and links to the vendor's page.
   For GitLab on your own server, give its address; tick *inside our network* if that address is private.
2. **Check the token**: the workspace says whose it is.
3. GitHub and GitLab: tick the repositories to look through for pull and merge requests that name a task's code.
4. Connect.

The token is stored encrypted (AES-256-GCM; the key is derived from `INTERNAL_TOKEN_SECRET`, or
`INTEGRATIONS_SECRETS_KEY` when set) and is never returned by the API or shown again. Use a dedicated read-only
account where the tool allows it. Disconnecting keeps the links on their tasks with what they last showed.

| Tool | Token | Least access |
|---|---|---|
| GitHub | Fine-grained personal access token (or a classic one with `repo`) | Read on Pull requests, Issues, Commit statuses, Metadata |
| GitLab | Personal, group or project access token | `read_api` |
| Figma | Personal access token | File content: Read only |

## For everyone

A link reaches a task in three ways:

- **Paste it** in the task's *Linked work* section (anyone who may read the task, as for a comment).
- **Write it** in the task's description or a comment: the address is picked up the next time the task is opened.
- **Name the task's code** in a pull or merge request's title or branch (`WEB-42 Fix login`,
  `feature/web-42-login`), in a repository the admin ticked. Looked for every ten minutes
  (`INTEGRATION_SCAN_INTERVAL_MS`).

Removing a link the hub found by itself hides it for good on that task; pasting it again brings it back.

A card is read again when someone opens the task and it is older than five minutes, or on *Read again*. When the
tool cannot be reached the card keeps what it last showed and says so. A design's preview picture is fetched and kept
by the server, so the browser never talks to the design tool; the design itself opens in the tool's own viewer inside
the page only when someone presses *Open the design here*.

A project has a **Reviews** tab once GitHub or GitLab is connected: every pull and merge request linked to its tasks,
open ones first, with how many are failing their checks.

## How it works

Code: `backend/server/src/modules/work/integrations/` (`define.ts` the contract, `registry.ts` the list,
`providers/` one file per tool, `hub.ts` everything they share), `http/integrations.controller.ts`, tables in
[work.md](../database/work.md#integrations-hub); web: `frontend/web/src/components/integrations/`
and `components/admin/IntegrationsHub.tsx`.

| Call (under `/api/work/`) | Who | What |
|---|---|---|
| `GET integrations` | any member | The catalogue and which are connected |
| `GET integrations/connections`, `POST integrations/check`, `POST integrations/connections`, `PATCH`/`DELETE integrations/connections/:id`, `GET integrations/connections/:id/repos` | `workspace.configure` | Connections. A token goes in and never comes out |
| `GET tasks/:ref/links` | whoever may read the task | The task's cards (finds addresses in the description and comments, reads stale cards again) |
| `POST tasks/:ref/links` `{ url }`, `DELETE tasks/:ref/links/:id`, `POST tasks/:ref/links/:id/refresh`, `GET tasks/:ref/links/:id/thumbnail` | whoever may read the task | Add, remove, read again, the preview picture |
| `GET projects/:ref/reviews` | any member | The project's reviews, each only with a task the caller may read |

What keeps a contributed provider safe:

- **One way out.** A provider has no database and no network of its own. It gets `ctx.request`, which is https only,
  refuses private addresses (unless the admin said the company's own server is inside its network), follows no
  redirects, reads at most 1 MB and waits at most 10 seconds.
- **The token goes to one place.** `ctx.request` refuses any address that is not on the API the connection was made
  for, so a provider cannot be tricked (or written) to send the company's token elsewhere.
- **Cards are plain data.** Every card passes `cleanCard`: fixed kinds and states, every text clipped. The web draws a
  card by its kind and never renders anything a provider returns as HTML.
- **Frames are named.** A card's `embedUrl` is shown only when its host is in the provider's `embedHosts`, and the
  web's content security policy (`frame-src` in `frontend/web/next.config.mjs`) lists exactly those hosts.

## Write an integration

An integration is one file. You write no frontend, no SQL and no HTTP plumbing.

1. **Copy the template.** `backend/server/src/modules/work/integrations/providers/_template.ts` → `<your-id>.ts`. The
   id is lower-case and permanent (it is stored with every connection and link).
2. **Describe it**: `name`, `category` (`development`, `design` or `other`), one-sentence `summary`, `webBase` (the
   site people open), `apiBase`, and `tokenHelp` (the vendor's page about tokens, and the least access needed, in
   words). Add `selfHosted: { apiPath }` if companies run their own copy.
3. **`match(url, webBase)`**: is this address yours? Return a `key` that names the thing for good (the same pull
   request must get the same key whatever tab or query string the address carries), its `kind` and the few strings
   `fetch` needs. Return `null` for everything else, including pages of your tool that are not a single thing.
4. **`fetch(ref, ctx)`**: read it through `ctx.request` and return a card. Use `okJson(name, response)` so refusals
   and missing things become sentences an office manager can act on.
5. **`check(ctx)`**: prove the token works and return whose it is.
6. Optional, for tools with repositories: `listRepos(ctx)` and `recentReviews(repo, since, ctx)` let the hub link
   requests that name a task code.
7. **Register it**: one line in `registry.ts`.
8. **Record answers**: `fixtures/<your-id>.json` with real responses from the API (remove anything private): a
   `check`, a few addresses that must not match, and one case per kind of thing with the card you expect.
   `providers.test.ts` runs the same contract over every registered provider; you add no test code.

```bash
pnpm --filter @workspace/server exec vitest run src/modules/work/integrations
```

### The card

| Field | Kinds | Meaning |
|---|---|---|
| `kind` | all | `review` (a pull or merge request), `issue`, `design`, `generic` |
| `title`, `ref` | all | Its own title; how people name it (`acme/web#128`, `Checkout flow › Cart`) |
| `state` | all | `open`, `draft`, `merged`, `closed`, `done`, or `none` when it has no state |
| `author`, `updatedAt`, `labels`, `comments` | all | As the source shows them |
| `branch`, `target`, `additions`, `deletions` | `review` | Where it comes from and goes, and its size |
| `checks` | `review` | `passing`, `failing` or `pending` for all its automatic checks together; leave out when there are none |
| `reviewers` | `review` | Each person's latest word: `approved`, `changes` or `pending` |
| `thumbnailUrl` | `design` | A picture the server may fetch (public https, PNG/JPEG/WebP/GIF, up to 180 KB) |
| `embedUrl` | `design` | The tool's own viewer; its host must be in your `embedHosts` |

If your tool needs something the four kinds cannot say, start with `generic` (title, ref, state, author, time). A new
kind is a change to `define.ts` and to `frontend/web/src/components/integrations/WorkCard.tsx`; open an issue first.

### What a pull request needs

- The provider file, its line in `registry.ts`, its fixture; the contract tests green.
- For an integration that embeds a viewer: its host in `embedHosts` and in `frame-src` (`next.config.mjs`), and why.
- Texts in English in the provider (`summary`, `tokenHelp.needs`). The web shows them as they are; translations for
  the built-in ones live in `frontend/web/src/lib/i18n/messages/` under `hub.summary` and `hub.needs`, and a tile
  (two letters and a colour, never the vendor's logo) in `components/integrations/types.ts`. Both are optional: a
  provider without them still shows, in English, with a tile made from its name.
- No new dependency: `ctx.request` and `JSON` are enough for a REST or GraphQL API.

## Limits

- Tokens are company-level: everyone sees a card through the one connected account, so connect an account that sees
  only what the whole company may see. Who sees a card inside the workspace follows the task, not the other tool.
- No webhooks from the tools yet: cards are as fresh as the last look (five minutes) and code scanning runs every ten
  minutes.
- At most 40 links per task; the scan reads the hundred most recently changed requests of each repository per run.
