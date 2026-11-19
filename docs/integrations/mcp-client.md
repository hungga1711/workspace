# MCP client: the company's AI uses outside tools

workspace is also an MCP **client**: the company's AI (Admin › AI connections) can call tools on external
[Model Context Protocol](https://modelcontextprotocol.io) servers, such as GitHub, Linear, Notion, Sentry or a server the
company runs itself. Staff ask in **AI › Ask** ("which Sentry issues are new since Friday?", "open a Linear issue
for this"), and the AI calls the tools as configured. Server-runner **agent workflows** use them in their AI steps.
The other direction (agents such as Claude or Cursor calling workspace) is [mcp.md](mcp.md).

Nothing changes for a company that adds no server: no extra query beyond one indexed `SELECT`, and the MCP SDK is only
imported when a tool is actually called. Without a connected AI model the section explains that a model is needed
first (servers can still be prepared).

## Add a server (Admin › AI connections › MCP servers)

- **Gallery**: GitHub, Linear, Notion, Sentry, Stripe, Supabase, Vercel, Intercom, Hugging Face, Context7 and
  Cloudflare Docs, each with its address and the sign-in it uses (`frontend/web/src/lib/mcp-gallery.ts`; the tiles are
  monograms in our own colours, not vendor logos). Check the vendor's own docs for tokens and scopes.
- **Another server**: any Streamable HTTP URL (MCP 2025-03-26 or later). SSE-only servers are not supported.
- **Check** (before saving) says whether the address answers, needs a sign-in and offers OAuth. Saving reads the
  server's name, version and tool list.

### Sign-in

| Kind | What is stored | Notes |
|---|---|---|
| None | nothing | Public servers (docs search…). |
| Token | the header value, encrypted (`secretBox("ai-mcp/v1")`, `AI_SECRETS_KEY` overrides the key) | `Authorization: Bearer <token>` by default, or any other header name. Only the last four characters are shown again. An edited URL never receives the old token. |
| OAuth 2.1 | client id (and secret, if any), the discovered endpoints, tokens (encrypted) | Authorization code with PKCE (S256); the server found through its protected-resource metadata (RFC 9728, the 401's `WWW-Authenticate`) and its authorization server's metadata (RFC 8414 or OpenID discovery, else the 2025-03-26 default paths); a client registered dynamically (RFC 7591) when offered, otherwise an admin-entered client id; the MCP server named as `resource` (RFC 8707). Tokens refresh a minute before expiry, and once more when the server answers 401. |

OAuth runs in a popup: workspace's redirect URI is `<APP_URL>/mcp-callback` (shown under "Advanced: OAuth client" for servers where
the admin registers a client by hand). Only the person who started a sign-in can finish it (the `state` is tied to
them and expires after ten minutes).

**Company account or each person's own.** An OAuth server is either signed in once by an admin (everyone uses that
account), or set to "Everyone connects their own account": each person connects their own account from the row of
tools on Ask's welcome screen, and the AI acts with their access in that system. Token servers are company-level.

### Tools and who may use them

- Each tool can be switched off, and set to **Runs on its own** (when the AI calls it) or **Asks first** (the person
  approves each call). Defaults follow the server's annotations: `readOnlyHint` tools run on their own, everything else
  asks first.
- **Who may use it**: everyone, chosen departments, or AI admins only (`ai.agent.manage`). Someone outside the audience
  never sees the server's tools.
- The admin page lists the last 40 calls (who, server › tool, Ask or workflow, outcome, time) and, per server, calls,
  failures and people over 30 days.

## At run time

- Tools are offered to the model as `<slug>__<tool>` (the slug is made from the server's name, `github__list_issues`),
  with the server's own description prefixed by its name, and the input schema from `tools/list`. The tool list is kept
  on the server row and read again when older than ten minutes (one request does it; the others keep the stored list).
- A tool result is cut at 12,000 characters, wrapped in `<untrusted_content>` (the system prompt tells the model never to
  follow instructions found there), and a call times out after 30 s. At most six model turns; after a minute of tool use
  the model must answer from what it has.
- **Ask**: a tool that asks first pauses the answer. The person sees a card with the server, the tool and the
  arguments the AI wrote, and approves or declines; the answer then carries on in the same bubble. A paused answer is
  kept for an hour (`mcp_pending`); a decision is taken once even on a double click. Under each answer, a chip
  ("Used GitHub · list_issues") opens to the list of calls with outcome and time; it is stored with the message.
  "Regenerate" uses only tools that run on their own.
- **Agent workflows (server runner)**: AI steps get the tools that run on their own (nobody is there to approve one).
- Not yet: @AI in chat channels and @Agent replies do not use MCP tools (their answers can be posted to a whole channel).
- Models that cannot call tools (the built-in extractive model, connections whose tool probe failed) answer without them.

## Security

- **SSRF**: server and OAuth URLs must be https and resolve to public addresses; the address actually connected to is
  checked (no DNS rebinding), redirects are not followed, responses are capped at 4 MB. Internal servers: list their
  hosts in `MCP_ALLOW_PRIVATE_HOSTS` (exact names, `*.suffix`, IP addresses, `*`); listed hosts may use http.
- **Audit**: every call is a row in `ai.mcp_calls` (user, agent, server, tool, feature, outcome, duration), never the
  arguments or the result; kept like the agent audit (`AI_AUDIT_RETENTION_DAYS`, 365 days). Adding, editing and removing
  servers goes to the audit log as `ai.connection.*` events with `mode: "mcp"`.
- **Permissions**: managing servers needs `ai.agent.manage`; using them needs `ai.use` and the server's audience. A
  company OAuth account acts with that account's access in the outside system, for everyone in the audience: prefer
  per-person sign-in, or a narrowly scoped token, for systems with sensitive data.
- The public demo (`DEMO_MODE=1`) refuses every change to MCP servers.

## Reference

| Endpoint (`/api/ai/…`) | Who | What |
|---|---|---|
| `GET mcp/servers` | AI admins | Servers (no secrets), recent calls, redirect URI |
| `POST mcp/servers`, `PATCH`/`DELETE mcp/servers/:id` | AI admins | Add, edit, remove |
| `PUT mcp/servers/:id/tools` | AI admins | `{ tools: { <name>: { enabled, confirm } } }` |
| `POST mcp/servers/:id/test`, `POST mcp/check` | AI admins | Read name, version, tools (saved / before saving) |
| `POST mcp/servers/:id/oauth/start`, `DELETE mcp/servers/:id/oauth` | AI admins | Company sign-in |
| `GET mcp/mine` | `ai.use` | Servers I can use, and whether I must connect my own account |
| `POST`/`DELETE mcp/servers/:id/connect` | `ai.use` | My own sign-in on a per-person server |
| `POST mcp/oauth/callback` | the person who started it | Finishes a sign-in (`{ state, code }`) |
| `POST assistant/pending/:id` | the asker | `{ approve }` for a confirm card; returns the rest of the answer |

Tables (schema `ai`, migration `002_mcp_client.sql`): `mcp_servers`, `mcp_tokens`, `mcp_oauth_states`, `mcp_calls`,
`mcp_pending`, and `ai_messages.tool_calls`. Code: `backend/server/src/modules/ai/mcp/` (`net.ts` guard, `transport.ts`
Streamable HTTP over it for the SDK's `Client`, `oauth.ts`, `client.ts` sessions and tool sets, `loop.ts` the tool loop,
`chat.ts`, `controller.ts`); tests in `backend/server/test/ai/mcp-client.test.ts` run a real MCP server (SDK) with OAuth.
