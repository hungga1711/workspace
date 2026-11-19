# AI viết giúp (task title and description)

Help writing a task: draft its description from the title, or rewrite the title and description the person has in
front of them. Added 2026-11-05. Every proposal is shown next to the current text and applied only by the person.

## What people see

- **Where:** the task page and its peek (the "Mô tả" heading), and the new-task window (its header, which is also the
  global "Tạo mới › Việc" flow). One "AI viết ▾" menu: **Viết mô tả**, **Cải thiện tiêu đề và mô tả**, then, once
  there is a description, **Ngắn gọn hơn**, **Chi tiết hơn**, **Thêm tiêu chí hoàn thành**, **Chia thành checklist**,
  and **Yêu cầu khác…** (a free instruction, up to 500 characters), and **Chèn mẫu mô tả**.
- **Suggestion panel** (loaded on the first pick): a skeleton while the model writes (no streaming: the ai module's
  one-shot `meteredGenerate`), then the title before (struck) → after with **Dùng tiêu đề**, and the description as
  line changes (+ / −) or rendered (**Thay đổi / Xem trước**; a first draft or a near-total rewrite opens rendered),
  **Bỏ**, **Viết lại**, **Dùng mô tả**, **Dùng cả hai** (or **Dùng gợi ý** when only the description changed). Facts
  the answer states that the input did not (two-digit numbers, dates, links, mentions) are listed in an orange note to
  check before using; a description cut for length says so.
- **Applying:** on a task it is the normal `PATCH /api/work/tasks/:id` with `expectedVersion`, so history, search,
  notifications and events see an edit by the person (nothing is marked as AI-written: the codebase has no such flag);
  a toast offers **Hoàn tác**, which patches the previous text back on the newest version. In the new-task window the
  fields are filled (nothing is saved) and undo restores what was typed.
- **Without AI** (`aiEnabled` / `useAiEnabled()` false): the menu is replaced by one quiet **Mẫu mô tả** button that
  inserts the skeleton (Mục tiêu / Việc cần làm / Tiêu chí hoàn thành / Ghi chú) in the UI language: on a task it
  opens the description editor with the skeleton appended, unsaved; in the new-task window it is appended to the field.

## API

`POST /api/ai/tasks/write` (ai module, `task-write.ts`):

```
{ mode: "draft" | "improve" | "shorter" | "longer" | "criteria" | "checklist" | "custom",
  title, description, taskRef?, projectId?, labels?, instruction? }
→ { title?, description, language: "vi" | "en", truncated, added: string[] }
```

- `ai.use` required; 503 `ai_not_configured` without a model (`ai/status.ts` lists the route in `GENERATIVE`); 503
  `ai_unavailable` when only the built-in extractive model answered.
- `taskRef`: the task is read from the work module **as the caller** (403/404 → 404), its subtasks and project join
  the context, and for a draft the titles of related documents and similar finished tasks (`/tasks/:id/related`, at
  most 2.5 s). `projectId` (new-task window): the project's name and the first 500 characters of its description, read
  as the caller, best effort.
- The title and description come from the page (they may be unsaved). Input is capped (title 300, description 20 000;
  the model reads the first 12 000 characters, `MAX_INPUT`, `truncated: true` past that).
- Usage: `ai_usage` feature `task_write`, subject `task:<id>` when a task is given (AI Insights counts the task as
  AI-assisted). Budgets apply (`guardAi`). 20 calls per person per minute (in-memory window, service-kit `kv()`, 429 `rate_limited`). The
  gateway allows 180 s, as for task chat: a description from a small self-hosted model takes a while.
- Safety: the task text goes in `<untrusted_content>` under `SYSTEM_RULES`; the instruction in `<request>`. Mentions
  (`<@id>`) are sent as `@P1…` placeholders and mapped back; one the model invents is dropped. The prompt forbids
  new dates, people, numbers and links; `added` reports the ones that slipped through.
- The answer is JSON `{title, description}`; a plain Markdown answer counts as the description. The title is only
  proposed by `improve` and `custom`, and only when it changed. The language is the text's own (`detectLang`), else
  the interface language.

## Files

- Backend: `backend/server/src/modules/ai/task-write.ts` (+ `task-write.test.ts` for prompt and parsing),
  `backend/server/test/ai/task-write.test.ts` (permission, read-as-caller, usage, rate limit).
- Web (`frontend/web/src/`): `components/work/TaskWrite.tsx` (menu + lazy panel hook), `components/work/TaskWritePanel.tsx`
  (request, diff, apply), `lib/task-write.ts` (template), wired in `components/work/TaskDetailView.tsx` (+
  `TaskDescription.tsx` `prefill`) and `NewTaskDrawer.tsx`. Strings: `work.taskwrite.*`.
