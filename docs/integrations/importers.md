# Importing from other tools

Everything is read in the browser and shown before anything is created; nothing is uploaded to a third party. Each
importer states its scope in the dialog.

## Tasks: Work › a project › Import tasks

One dialog (`frontend/web/src/components/work/ImportTasksDialog.tsx`) takes:

| Source | File | What comes over |
|---|---|---|
| Jira | CSV export | Summary, status, priority, assignee, due date, labels, issue key |
| Trello | CSV, or the board's JSON (Menu › Print and export › Export as JSON) | Cards with their list as status, labels, first member, due date; archived cards as done |
| Asana | CSV export | Name, section as status, assignee, due date, tags |
| ClickUp | CSV export, or the tasks of a list as JSON (`{ "tasks": [...] }`, the shape the ClickUp API returns) | Name, content, status (a "closed" status type is done), priority, first assignee, due date, tags, task id (custom id when set) and **subtasks**; the list can become a project |
| Notion | Markdown & CSV export (.zip, also a zip of zips) | A database becomes tasks (pick which one when there are several); its pages become documents |
| Any spreadsheet | CSV (comma or semicolon, UTF-8) | Columns guessed from their names (Vietnamese included) |

Common rules:

- Up to 1,000 tasks per run, into the project the dialog was opened from (`POST /api/work/projects/:id/import`).
- People are matched by email, then by display name, against the directory. Unmatched people are listed; their tasks
  are imported without an assignee. Someone who may not assign others imports those tasks unassigned.
- For CSV files, **Pick columns** lets the person point each field (title, status, assignee, due, priority, labels,
  description) at a column, or drop one, when the guess is wrong.
- Statuses map to To do / In progress / Review / Done by their wording (Notion's "Not started" is To do). Dates are
  read as ISO, `dd/mm/yyyy` (Vietnamese order; ClickUp's `mm/dd/yyyy`), epoch milliseconds, Jira's `15/Oct/26`, long
  English dates, and Notion ranges (the end of the range is the due date).
- Not imported: comments, attachments, time tracking, sprints, custom fields.

### ClickUp

- Export: in a Space, Folder or List, "…" › Export, choose CSV. Subtasks keep their parent through the "Parent ID"
  column; workspace subtasks are one level deep, so a sub-subtask hangs from its top-level ancestor, and a subtask
  whose parent is not in the file stays at the top level.
- When the file holds several lists, the dialog offers **one project per list**: a project is created for each list
  and its tasks go there.

### Notion

- Export: Settings › Export all workspace content (or "…" › Export on a page), format **Markdown & CSV**, include
  subpages.
- Databases: the `<name>_all.csv` file is used when present (it has every row). Properties map like CSV columns:
  Name → title, Status, Assign / Assignee / Person, Date / Due, Tags. The rows of a database are also exported as
  pages; those are skipped because they arrive as tasks.
- Pages become documents in a new document space ("Notion", key `NOTION`, `NOTION2`… if taken), nested as in Notion.
  The first `# heading` becomes the title, Notion's 32-character ids are removed from names, links between exported
  pages keep their text, and images or attachments are dropped (the dialog says how many). Someone who may not create
  a space gets the pages as flat documents in the project.

Parsing lives in pure functions with unit tests on fixture exports: `importTasks.ts` (CSV, Trello, ClickUp),
`notionExport.ts` (Notion zip), fixtures in `frontend/web/src/components/work/__fixtures__/`.

## Chat history: Admin › Integrations › Move from Slack

A Slack workspace export (.zip) becomes channels with their history (`frontend/web/src/components/admin/slackExport.ts`).
