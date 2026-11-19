# `search` schema

Owner: `backend/server/src/modules/search`. Unified search (messages, channels, files, people, tasks, projects,
documents) on Postgres full-text search ([ADR 0013](../adr/0013-postgres-full-text-search.md)). A derived copy:
identity, chat and work stay the source of truth, the indexer keeps it in sync from their events, and
`reindex` rebuilds it from them.

Schema `search` of the `workspace` database; the server connects as `workspace_search`. Baseline:
`backend/server/migrations/search/001_baseline.sql`; later files in the same folder (`002_kind_candidates.sql`,
`003_passages.sql`). The baseline also creates the extensions in `public`.

Query and write code: `backend/packages/service-kit/src/search.ts`. It names every object with the schema
(`search.search_documents`, `search.workspace_search`, …), because chat runs it under its own role.

Writers and readers: the search module writes as `workspace_search` (`SEARCH_DATABASE_URL`, pool of 10,
`backend/server/src/modules/search/start.ts`); the chat module's `GET /search` reads as `workspace_chat` through
`workspace_search_reader` (`CHAT_SEARCH_DATABASE_URL`, its own pool of 10: `SELECT` on `search_documents` and
`search_passages` and `EXECUTE` on the two functions below, nothing else), then re-checks its top hits against chat's
and work's own tables.

The schema has no `outbox` and no `processed_events`: search emits no events, and the indexer
(`backend/server/src/modules/search/indexer.ts`, group `search-indexer`) is idempotent by key (a redelivered event
rewrites the same rows), so it needs no dedupe ledger.

Matching and typo lookup go through the two SECURITY DEFINER functions below, so chat's role can use the
vocabulary (`search_terms`) without being granted the table.

## Text processing

Text search configuration `workspace_search`: `simple` with `unaccent` in front, for `asciiword`,
`asciihword`, `hword_asciipart`, `word`, `hword`, `hword_part`. Words are stripped of diacritics, then
lower-cased, never stemmed (number, email, URL, host, file and version tokens map to `simple` only) (Postgres has no Vietnamese stemmer): "Thanh toán" → `thanh`, `toan`; "Đường" →
`duong`; "T-042" → `t`, `-042`. Queries and `ts_headline` excerpts use the same configuration, so excerpts keep
the original text. Extensions: `unaccent`, `pg_trgm`, `fuzzystrmatch` (all trusted; created by the owner role).

## Tables

### `search_documents`
One row per searchable entity.

| Column | Type | Null / default | Meaning |
|---|---|---|---|
| `entity_type` | text | NOT NULL, CHECK `message`/`thread`/`channel`/`task`/`project`/`document`/`file`/`person`/`whiteboard`/`meeting`/`event`/`approval` (the last three added by 003) | |
| `entity_id` | text | NOT NULL | Id in the owning module |
| `container_id` | text | NOT NULL | Channel, project, `user:<id>` (personal tasks), `doc:<id>`, or `people`; a reader must belong to it… |
| `acl_users` | text[] | NOT NULL DEFAULT '{}' | …or be listed here (direct shares, task owner and assignee) |
| `title` | text | NOT NULL DEFAULT '' | Channel name for messages; `<code> <title>` for tasks and projects |
| `body` | text | NOT NULL DEFAULT '' | Message text, description, document text |
| `url` | text | NOT NULL | Deep link |
| `created_at`, `updated_at` | timestamptz | NOT NULL | From the event; an upsert never replaces a newer `updated_at` |
| `tsv` | tsvector | GENERATED STORED | Title (weight A) + first 200,000 characters of the body (B); what queries match |
| `rank_tsv` | tsvector | GENERATED STORED | Title (A) + first 1,000 characters of the body (B); what ranking reads (small, stays inline) |

PK `(entity_type, entity_id)`. Indexes: `search_documents_tsv_idx` GIN `(tsv)`;
`search_documents_tsv_nonmessage_idx` GIN `(tsv) WHERE entity_type <> 'message'` (002);
`search_documents_container_idx (container_id)`; `search_documents_acl_idx` GIN `(acl_users)`;
`search_documents_updated_idx (updated_at DESC)`. `tsv` keeps statistics target 1000.

### `search_terms`
The workspace's vocabulary, for typo correction. Every alphabetic word of 3–40 letters
seen in an indexed `tsv` is added on write; words are never removed (a stale word only costs a candidate that
matches nothing; `reindex --recreate` rebuilds the list).

| Column | Type | Meaning |
|---|---|---|
| `word` | text | Folded word |

PK `(word)`; `search_terms_trgm_idx` GIN `(word gin_trgm_ops)`.

### `dead_events`
Events the indexer gave up on, the same table as in every consuming module (search's `001_baseline.sql`, with
`replay_requested_at`; see [events](../events/README.md)). The app role may only insert; `pnpm ops:dlq` reads them
and requests replays, which the server performs. Search starts no outbox relay, and the dead-letter prune job is
scheduled by the relay (`startEvents`), so search's dead letters are not pruned automatically.

## Functions (SECURITY DEFINER, owned by `workspace_maintenance`)

Both return keys or words only; `EXECUTE` is granted to `workspace_search_rw` and `workspace_search_reader` only.
`workspace_maintenance` has `SELECT` on `search_documents`, `search_terms` and `search_passages` for them.

- `search_candidates(q tsquery, containers text[], reader text, types text[], lim int)`: the
  `(entity_type, entity_id)` of documents matching `q` that the reader may see (container or `acl_users`),
  optionally of some types, most recent first, at most `lim` (capped at 5,000). When only non-message types are
  asked, it answers from the partial index `search_documents_tsv_nonmessage_idx` alone (002). Otherwise a probe on
  the tsv index decides how: a word with fewer than 5,000 matches is read from the tsv index and sorted; a common one walks the
  newest 20,000 documents by `updated_at` when they already hold `lim` matches (the same rows, without reading every
  match), else the tsv index. Measured on a million-message channel: 10–100 ms for any query.
- `search_query_words(query text)`: the query's words in order, whether each is the last (matched as a
  prefix), and up to 3 vocabulary words it may be a typo of: only for a word of 3+ letters that the workspace
  has never used (for the last word: that no vocabulary word starts with), within 1 edit, 2 for words over 5
  letters (`%` to find, `levenshtein` to bound).

## How a query runs

`search()` in `service-kit/src/search.ts`, on the search pool:

1. `search_query_words(text)` → tsquery: each word OR its corrections, the last word as a prefix (`word:*`);
   words ANDed. No words → no hits.
2. `search_candidates(...)` with the caller's containers → the 1,000 most recent permitted matches
   (`RANK_WINDOW`).
3. Those rows are read and ranked by `ts_rank(rank_tsv, q, 1)`, then `updated_at`, then id; one page
   (`size` ≤ 50) after the keyset cursor `[score, updated_at, entity_id]`. Messages and bodies ≤ 300 characters
   come back whole; longer bodies as a `ts_headline` excerpt of about 15–35 words from their first 20,000
   characters.
4. If the AND query found nothing, the OR query runs once (a single page), over the content words only: English
   and Vietnamese function words (`the`, `what`, `của`, `là`…, `STOP_WORDS`) are left out, so a question about
   something absent finds nothing instead of every text containing "the".

## Passages (AI retrieval)

`search_passages` (migration 003): PK `(entity_type, entity_id, seq)`, `entity_type` CHECK
`task`/`document`/`meeting`/`event`/`file`/`approval`. Each row is one passage of a task (description and
comments), a page, a meeting (agenda, minutes, action items), a calendar entry, a file (the words of a Drive file or
an attachment) or a request, with `heading` (the headings above it, "Refunds › After 30 days"), `body` (about 1,000
characters, overlapping the next by a sentence), the parent's `container_id`, `acl_users`, `title`, `url` and
`updated_at`, and `tsv` (GENERATED STORED: title A, heading B, body C). Indexes `search_passages_tsv_idx` GIN `(tsv)`,
`search_passages_acl_idx` GIN `(acl_users)`, `search_passages_container_idx (container_id)`. At most 400 passages per
thing (`PASSAGES_MAX`). Messages, projects and
whiteboards have no passages: `searchPassages` reads them from `search_documents`, each row as one passage.

| Kind | Text | Container · readers (`acl_users`) | `url` | Re-indexed when |
|---|---|---|---|---|
| `task` | status, description, comments | the project, or `user:<owner>` · owner, assignee | `/app/work/tasks/<id>` | the task or a comment changes |
| `document` | the whole page | the project, `workspace`, or `doc:<id>` · people it is shared with | `/app/work/docs/<id>` | the page is saved, shared or moved |
| `meeting` | time, place, agenda, minutes, action items | `event:<id>` · organizer and attendees | `/app/work/meetings/<id>` | it is scheduled, edited, or its agenda or minutes are saved |
| `event` | title, time, place | `event:<id>` · organizer and attendees | `/app/work/calendar?event=<id>` | it is created or moved |
| `file` | the file's words | Drive: `workspace` when it or a folder above is shared with everyone, else `file:<id>` · owners, viewers and editors up the folders. Attachment: its task's or page's | `/app/files/<id>` | its text is read; a Drive item is renamed, moved, shared, trashed or restored |
| `approval` | what was asked, fields, decision, discussion | `approval:<id>` · requester, approver, who it was delegated from | `/app/work/approvals/<id>` | it is requested, forwarded, decided or commented |

Cancelling a calendar entry, deleting a task, page or file removes its passages. The four kinds that exist only as
knowledge (`meeting`, `event`, `approval`, and `file` for work files) also get a `search_documents` row from the same
text. The work module's `file_texts` table keeps what its background job read from each file ([work.md](work.md)).

Querying: `searchPassages(c, { userId, containerIds, text, types?, size, since? })` and
`passagesAround(c, type, id, seq, radius)` in service-kit; over HTTP, chat's `GET /search/passages?q=&types=&limit=&since=`
and `GET /search/passages/around?type=&id=&seq=&radius=`, both as the reader, both rechecking every hit against the
owning module.

## Performance

Measured 2026-10-15 on the dev stack (Postgres 16.4 in Docker Desktop on macOS, then through PgBouncer, end-to-end
`search()` including round trips): one workspace of 100,000 documents (60 % messages of 5–35 words, 10 %
documents of 300–1,000 words, the rest tasks, files and channels; 6,121 distinct words with a Zipf-like
distribution; 200 containers, the reader in 30), 16 query shapes (common and rare words, 1–5 words, typos,
prefixes, no match), 320 searches:

| p50 | p95 | p99 | max |
|---|---|---|---|
| 19.2 ms | 28.9 ms | 30.6 ms | 37.0 ms |

What it took (measured while the tables still had row-level security):
matching through the GIN index (the SECURITY DEFINER functions; a sequential scan under RLS cost ≈70 ms), ranking a bounded window on the small `rank_tsv` with `ts_rank` (`ts_rank_cd` on the full `tsv` cost
≈35–45 ms per 1,000 candidates), one round trip for words and corrections. Writing 100,000 documents in batches
of 1,000 took 14.6 s.
