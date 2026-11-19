# The assistant in the workspace: retrieval, tools, @AI

Built 2026-11-12. One assistant, three places: Hỏi đáp (`/app/ai/ask`), `@AI` in a chat channel, `@AI` in a task's
comments. It answers from the workspace's own data, read with the asker's access, and can change tasks, the calendar,
pages and workflows after the person says yes on a card. Without an AI connection none of it shows (non-negotiable 1);
with a model that takes no tools (the built-in one, small self-hosted ones) it still answers from a search, read-only.

Code: `backend/server/src/modules/ai/workspace-tools.ts` (the first set of tools; the rest one file per area,
`tools-*.ts`, registered through `tools-extra.ts`), `ai/mcp/loop.ts` (the loop and its pause), `ai/mcp/chat.ts`
(cards), `ai/mention.ts` (`POST ai/mention`), `ai/activity.ts` (Hỏi đáp), the passages in
`backend/packages/service-kit/src/search.ts` (`splitPassages`, [database/search.md](../database/search.md)), and in the
web app `frontend/web/src/components/ai/*`, `components/chat/Conversation.tsx`, `components/work/TaskActivity.tsx`.

## Retrieval

Postgres full-text search over **passages** (ADR 0013 stands: no vector store). Everything a company keeps is indexed
as overlapping passages of about a thousand characters (`PASSAGE_TARGET`), each with its parent's permissions: pages in full, tasks with
their comments, meetings (agenda, minutes), calendar events, files whose text can be read (PDF, Word, Excel,
PowerPoint, text), requests, chat messages, projects, people. The model writes the search queries itself
(`search_workspace`), may search again with other words, and opens an item in full or around one passage
(`read_item`). That loop is the retrieval-augmented part: what reaches the model is only what the search returned for
this asker, wrapped as untrusted content, and the answer names its sources (`sources` on the response, kept with the
message).

Why not embeddings: the shipped Postgres image has no pgvector and the product's stack is deliberately small. The
passage table is where an embedding column and a rerank would go, should a company connect an embedding model.

## Tools

| Reads (run at once) | Changes (wait for a yes) |
|---|---|
| `search_workspace`, `read_item`, `list_calendar`, `list_workflows`, `list_my_tasks`, `find_people`, `team_status`, `project_status`, `goals_status`, `delegated_status`, `who_is_out`, `my_leave_balance`, `recent_channel_messages`, `get_thread`, `get_task` | `create_task`, `update_task`, `comment_on_task`, `schedule_event`, `update_event` (move, rename, cancel), `write_meeting_notes`, `create_document`, `edit_document` (append, replace one exact passage, rewrite), `run_workflow`, `send_message` (a channel the asker is in, or a direct message to one colleague), `request_approval` |

That is the first set (`workspace-tools.ts`). The area files add more under the same rules: task reports and bulk
changes, chat summaries and polls, people and leave, reports, document tools, office files, web pages.

Rules that hold for every tool (`tools.ts executeTool`):

1. It runs **as the asker**: the tool's permission is checked, then the owning module is called with the asker's
   principal and authorizes again. The AI never reads or changes what the person could not.
2. A tool that changes something never runs on the model's word. The loop stops and returns a card
   (`pending.preview`: a title and the fields that matter, in the answer's language); `POST ai/assistant/pending/:id
   { approve }` (`mcp/controller.ts`) runs it or tells the model the person declined. One hour to decide (`CARD_OPEN_MS`); a card is taken atomically, so a
   double click cannot run it twice.
3. Where no card can be shown (a regenerated answer, a workflow's AI step) the write tools are not offered.
4. Names are resolved, never guessed: "Minh" with two Minhs comes back to the model as "ask which one". A module's
   refusal (not the organizer, the page changed meanwhile) comes back with its reason.
5. Every call is in `ai_audit`; refusals also reach the audit trail (ADR 0025).

Outside tools (MCP) join the same loop; a name clash keeps the workspace's own tool.

## @AI

| Where | Who sees the answer | What the AI is given |
|---|---|---|
| Hỏi đáp | the asker; kept as a conversation | the conversation, what was pointed at with `@` (tasks, pages, projects, meetings, files, workflows), attachments |
| A chat channel | the asker only (what it read may be more than the channel may see) | the channel's latest messages (asked in a thread: that thread) |
| A task's comments | everyone on the task: posted as a comment marked "AI", in the asker's name | the task's brief |

A change asked for in a comment still waits for the asker's yes; the answer is posted once they decide
(`mcp_pending.context`).

## Streaming

An answer is written as it comes even when tools are offered: a turn that ends in tool calls voids what it wrote
(`ModelStream.reset`), the turn that answers is the one the person reads.
