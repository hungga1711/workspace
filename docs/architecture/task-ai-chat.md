# Hỏi AI về task, and Liên quan

A person's own AI chat about one task, grounded in what the workspace already knows about it, plus a "Liên quan" view
that shows the same related material without any model. Added 2026-11-05.

## What people see

- Task detail (page and peek): the activity card has tabs. **Hoạt động** (comments and history, as before), then
  **Hỏi AI** when the company assistant is on (`useAiEnabled()`), or **Liên quan** when it is not. On a phone, Hỏi AI
  opens full screen over the task.
- Hỏi AI: one conversation per person and task (the newest is opened), "Cuộc trò chuyện mới" to start over, the earlier
  ones in a menu (deletable). An empty chat shows four starters (Giải thích task này / Cần làm những bước nào? / Đã có
  ai làm giống vậy chưa? / Tôi đang kẹt ở…, which fill the composer) and a compact Liên quan list.
- Answers cite numbered sources (`[2]` becomes a link; chips under the answer open the task, document, message or
  project). Under each answer: **Tạo việc con từ các bước này** (only when the answer has a list of two or more steps),
  **Thêm vào mô tả**, **Ghi tiến độ**, **Đăng vào bình luận**. Each opens a panel with what will be written (editable,
  steps as checkboxes) and does nothing until "Xác nhận"; the write goes through the normal work endpoints as the
  person. Posting as a comment is the only way teammates see anything from the chat.
- No AI, or no `ai.use`: Liên quan lists related documents (named in the task or its comments, in its project, found
  by its words), similar finished tasks (who did them, when, their last comment as "how") and chat messages that name
  the task's code.

## Privacy

- Chats live in `ai_task_chats` / `ai_task_chat_messages` (ai schema), not in `ai_conversations`: AI Insights and the
  oversight pages list and open `ai_conversations`, and no oversight query reads the task-chat tables. Every read and
  write is `WHERE user_id = <asker>`: a teammate on the same task, a manager and an AI admin get nothing (tested in
  `backend/server/test/ai/task-chat.test.ts`).
- Usage is still metered: each model call is `ai_usage` feature `task_chat` with subject `task:<id>`, so budgets apply,
  AI Insights counts it, and the work module records the task as AI-assisted (`ai.usage.recorded.v1`). The text is
  never part of that.
- An erasure of a person's AI data (`eraseInsights` in `ai/me-insights.ts`) deletes their task chats too.

## Grounding (the task brief)

`backend/server/src/modules/ai/task-brief.ts` builds the brief before each answer, from data read **as the asker**
through the owning modules (the work module checks `canReadTask` / `canReadDoc`, chat checks channel membership):

1. the task: title, status, priority, due, assignee, blocked reason, reported progress, labels, description (its
   checklist included), subtasks, the last 25 comments, status history, attachment names (no attachment text yet);
2. its parent, what it waits on and what waits on it, the project's description and goals (key results linked to it);
3. documents: named in the task or its comments (code or link), the project's latest, then full-text search on the
   task's words;
4. similar finished tasks: full-text match on title and labels (at least two shared words, 40% of a long title), with
   who did them and their last comment;
5. chat messages that name the task's code (chat search, then an exact word match on the code).

Sections are laid out in that order until `AI_TASK_BRIEF_CHARS` (default 12,000 characters, at least 2,000) is spent, so a long thread
never pushes the task out. The brief reaches the model inside `<untrusted_content>` with the latest question only;
earlier turns stay as asked. It is cached 10 minutes (`CACHE_MS` in `task-chat.ts`) per (asker, task version, comment count and last edit, subtask
count, language).

Parts 2–5 come from `GET /work/tasks/:ref/related` (`backend/server/src/modules/work/related.ts`), which is also the
Liên quan view. It needs no model and is served by the work module, so it works when the AI module's routes are
switched off (`work/http/related.controller.ts`). The work module asks chat's `/search` as the caller (a `CHAT`
service client); when chat does not
answer, `partial: true` and the rest still shows.

## Answering

`backend/server/src/modules/ai/task-chat.ts`:

- `GET /ai/tasks/:id/chat[?c=<chatId>]`: my chats about the task and one opened. `POST /ai/tasks/:id/chat`
  `{ content, chatId?, route? }`: one turn. `DELETE /ai/tasks/:id/chat/:chatId`. All need `ai.use` and the task to be
  readable by the asker (404 otherwise).
- The model gets the system rules plus task-chat rules (cite `[n]`, numbered steps, say when the brief does not
  answer). It may call the workspace tools in `TASK_CHAT_TOOLS` (reads: `get_task`, `search_workspace`, `read_item`,
  `get_thread`, `find_people`, `task_history`, `estimate_due_date`, `find_duplicate_tasks`, `workload_balance`;
  changes: `update_task`, `comment_on_task`, `create_task`, `split_task`, `assign_task`, `link_tasks`) and the
  company's MCP tools in one loop (`mcp/loop.ts`). A change, or an MCP tool that asks first, pauses the answer on the
  same confirm card as Hỏi đáp (`POST /ai/assistant/pending/:id` resumes it and saves the answer to the task chat).
- Sources: the brief's sources the answer cites (links like `[text](#3)` are read as `[3]`), plus documents, tasks and
  messages its own tool calls read.
- Without a hosted model (the built-in extractive model), the three starter questions are answered from the brief
  directly (`localTaskAnswer`); others go through the extractive model over the brief's lines.
- Answers are not streamed (Hỏi đáp's are, `stream.ts`); the gateway gives this route 180 s like Hỏi đáp
  (`backend/server/src/modules/gateway/gateway.ts`).

Hỏi đáp: a task code in the question (`@WEB-42`, `T-041`; two at most) attaches that task's brief to the model's input
(not to the stored conversation) and tags the usage with the task.

## Web

- `frontend/web/src/components/work/TaskChat.tsx` and `TaskRelated.tsx` load with their tab (`next/dynamic`), never with
  the task page; helpers in `taskChatText.ts` (tested).
- Per-section failure: Liên quan shows `LoadFailed` (`components/ui/LoadFailed.tsx`) with its own retry; a chat that cannot load says so with a retry; a
  person without `ai.use` gets Liên quan instead of an error.
