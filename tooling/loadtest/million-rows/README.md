# Million-row benchmark

How the request and job queries behave when one workspace holds about a million rows in its big tables. The
concurrency test in [../README.md](../README.md) measures people online at once on a small dataset; this one measures
the dataset. Synthetic rows go into a database of their own, `workspace_bench`: an installation holds one workspace
([ADR-0023](../../../docs/adr/0023-one-workspace-data-model.md)), so in the development database they could not be told apart
from real rows. Dropping the database removes them.

```bash
pnpm infra:db && pnpm build:packages
TEST_DATABASE=workspace_bench node tooling/scripts/test-db.mjs                                                     # create and migrate it
docker exec -i workspace-postgres-1 psql -U postgres -d workspace_bench < tooling/loadtest/million-rows/load.sql   # ~15 min, ~3 GB
tooling/loadtest/million-rows/bench.sh; tooling/loadtest/million-rows/bench.sh                                    # read the second run
tooling/loadtest/million-rows/bench.sh fixes.sql                                                                   # the candidate fixes
docker exec workspace-postgres-1 psql -U postgres -c "DROP DATABASE workspace_bench WITH (FORCE)"
```

The queries are copied from the modules in the shape they run them. Q7b runs the prompt library search a second
time as the module role (`workspace_ai`), as the server does.

## Results

Measured on 0.2.0, before [ADR-0023](../../../docs/adr/0023-one-workspace-data-model.md) gave the data model one workspace
(the queries then carried a workspace filter under row-level security, and the search documents were spread over
three workspaces); run it again for current numbers. Measured on Apple M3, Postgres 16.4 in Docker with default settings (`shared_buffers` 128 MB, `work_mem` 4 MB), warm cache.
Rows: 1,000,000 `ai_messages` in 200,000 conversations over 180 days, 1,000,000 `ai_usage`, 50,000 shared prompts,
600,000 tasks in 50 projects (70 % done), 300,000 chat messages in 100 channels, 150,000 search documents over
three workspaces. Count on 1.5–2× these times on a 2 vCPU cloud server.

| Query (as the module runs it) | Time | Plan | After the fix in `fixes.sql` |
|---|---|---|---|
| Work › Insights, 8 weekly buckets (16 correlated counts) | 943 ms | 16 sequential scans of `tasks` | 54 ms (one pass, two index-only scans) |
| Work › AI overview, weekly trend (8 weeks) | 476 ms | seq scan of `ai_messages` | needs a daily rollup, see below |
| Admin › AI budgets (`listBudgets`, also `spend/me` on every assistant call) | 286 ms | month of `ai_usage_costed` with a per-row price lookup, twice per budget | 0.02 ms from `ai_spend_month` |
| Work › AI overview, daily prompts (90 days) | 199 ms | seq scan of `ai_messages` | 195 ms with a partial index (the planner still prefers the scan: 90 days is half the table); 126 ms from `ai_conversations`; a rollup table gives milliseconds |
| Task suggestion by full text (one person) | 121 ms | `to_tsvector(title)` computed on 200,000 rows | expression GIN index, or restrict by `assignee_id` first |
| Work › Insights, workload per person | 68 ms | seq scan of `tasks` | acceptable; grows linearly |
| Search, common word (then across three workspaces) | 56 ms | container and ACL indexes, sort of all matches | acceptable |
| Work › Insights totals | 52 ms | seq scan of `tasks` | acceptable; grows linearly |
| `ai_prune_expired` candidate select (hourly) | 51 ms | seq scan of `ai_conversations` | index on `last_at` |
| My tasks page (sort by due) | 39 ms | bitmap on assignee + owner, 10,000 rows sorted | index on `(assignee_id, due_at)` for open tasks |
| check-in prompts (every 30 min) | 35 ms | seq scan of `tasks` | partial index on open tasks by `checkin_at` |
| Kanban move to the end of a column | 32 ms | seq scan of `tasks` (the partial index needs `parent_id IS NULL`) | 0.01 ms once the predicate is added |
| Purge all extension data (ids loaded into Node) | 23 ms for the select | seq scan, then `DELETE … = ANY(200,000 ids)` | delete in batches by `source` |
| Me › AI export (one person, all messages) | 18 ms | indexes | fine; stream the JSON instead of building it in memory |
| Prompt library search under RLS (then) | 9 ms | seq scan (GIN was unusable under FORCE RLS) at 50,000 prompts | without RLS the GIN index is usable again |
| topic batch due check (hourly; then `ai_insights_due('topics')`) | 10 ms | seq scan | fine |
| Board column page, project list page, agent budget check, chat history, mentions, channel mention count, search of a rare word, badge count | 0.1–12 ms | indexes | fine |

What this says: at a million rows the normal screens (my tasks, board, chat, search) stay fast because they are
paged by index. The manager dashboards (Work › Insights, Work › AI) and the budget list are the ones that read the
whole window, and three of them are a fix of one query each. Nothing here needs a different database.

Not measured here: `GET /chat/channels` (four correlated subqueries per channel, known in TODOS.md), the home
badge count at scale (the demo inbox is small), and write throughput under the `tasks_project_counts` trigger
(loading 600,000 tasks through it took about 10 minutes, roughly 1,000 rows a second).
