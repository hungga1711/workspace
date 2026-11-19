# ADR-0024: Whiteboards: Excalidraw scenes, a Yjs relay for live editing, REST snapshots merged per element

- Status: Accepted
- Date: 2026-10-28

## Context

Teams want a Miro-like board in Work: sticky notes, templates (retro, Kanban, SWOT…), several people drawing at once,
notes turned into tasks, and help from the company AI when one is connected. The product rules hold: self-hosted,
one workspace ([ADR-0023](0023-one-workspace-data-model.md)), everything works without AI, light routes, no CDN calls.

## Decision

- **Engine: Excalidraw** (`@excalidraw/excalidraw`, MIT). It is a mature React canvas with shapes, text, arrows,
  images, frames, export to PNG/SVG and a collaboration model built on per-element versions. tldraw needs a commercial
  licence for production use; building our own canvas is out of proportion. Excalidraw (about 1 MB) loads only on the
  editor route, after the app shell; its fonts and assets are served by the app itself.
- **Data: Excalidraw's own element JSON** in `work.whiteboards.scene` (jsonb, ≤ 5 MB), with the board's text derived on
  every save for search and AI. The server treats elements as data: it validates the envelope (ids, versions, the files
  map), never draws. Images are ordinary work `files` attached to the board; the scene names them, bytes never go in
  the row.
- **Live editing: a Yjs relay in chat**, a copy of the docs relay (`chat/whiteboard-collab.ts`, events `wb:*`). The
  browser keeps a `Y.Map` of elements by id (and one of files); the server checks access with work
  (`internal/whiteboards/:id/access`), relays and stores updates as a draft kept a day, and never parses them. Viewers
  join to watch; only editors' updates are relayed. Yjs gives the same guarantees docs already rely on (late joiners
  get the whole state, drafts survive a restart) with no new infrastructure.
- **Durability: REST snapshots, merged per element.** Editors save the scene (debounced, and on leave). The server
  merges each save into the stored scene element by element with Excalidraw's rule (higher `version`, then lower
  `versionNonce`); deletions are tombstones (`isDeleted: true`) that merge like edits. A save therefore never fails
  and never drops another person's elements, in or out of a live session; there is no 409 to retry.
- **Permissions** reuse existing grants: workspace boards follow `document.read`/`document.create`, project boards
  `project.read` plus the project's editors and the people working on its tasks, private boards their owner; the owner,
  admins (`document.edit` at workspace scope) and project editors manage.
- **AI** goes through the ai module (`ai/whiteboard/summarize|cluster|ideas`), reading the board as the person, metered
  as every AI call, with deterministic answers from the built-in model (`AI_LOCAL_MODEL=1`) in English and Vietnamese.
  Without an AI connection the endpoints answer 503 `ai_not_configured` and the editor hides the AI panel.
- Search indexes title and text through `work.whiteboard.*` events (and the `whiteboards` re-index feed).

## Consequences

- A board's history is its activity log (created, renamed, moved, tasks made, deleted), not scene versions: saves
  happen every few seconds and only the merged state is kept.
- Tombstones accumulate; the 5,000 most recent are kept, which is far more than a client can be behind.
- A scene above Socket.IO's 2 MB message size cannot be seeded live; such a board is still edited and saved, just
  without the live session (rare: text and shapes are small, images are not in the scene).
- Permission changes reach an open live session on the next join, as with docs.
