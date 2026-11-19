# ADR-0013: Postgres full-text search instead of Elasticsearch

- Status: Accepted; amended by [ADR-0023](0023-one-workspace-data-model.md) (no workspace filter or row-level security on
  the search tables any more; the two SECURITY DEFINER functions stay so chat's role can use the vocabulary)
- Date: 2026-10-15

## Context

Unified search (messages, channels, files, people, tasks, projects, documents) ran on Elasticsearch, fed by
the search-indexer from domain events. Elasticsearch was the largest process of an installation (≈1 GB heap,
1.3 GB resident), wanted `vm.max_map_count` tuned, and stopped accepting writes when the disk passed 95 %. The
self-hosted edition must run on a small server, and one company's searchable text (tens to hundreds of thousands
of rows) is far below what needs a search cluster.

## Decision

- Search moves to a **Postgres database `search`** owned by the search-indexer
  (`backend/workers/search-indexer/migrations/001_search.sql`, [docs/database/search.md](../database/search.md)).
  One table `search_documents` with the same fields the index had, a generated, weighted `tsvector`
  (title A, body B) with a GIN index, and row-level security by workspace like every table.
- **Vietnamese**: a text search configuration `workspace_search` maps words through `unaccent` then `simple`
  (no stemming; Postgres has no Vietnamese stemmer), so "thanh toan" finds "Thanh toán" and "duong" finds
  "Đường". Excerpts (`ts_headline`) use the same configuration and keep the original text.
- **Typos**: a word the workspace has never used is matched against its vocabulary (`search_terms`) within
  1 edit (2 for words over 5 letters) using `pg_trgm` to find candidates and `levenshtein` to bound them,
  the same tolerance as Elasticsearch's `fuzziness: AUTO`. Known words are never "corrected".
- **Type-ahead**: the last query word matches as a prefix. Words are ANDed; when nothing has them all, the query
  falls back to any word (Elasticsearch's default OR), as a single page.
- **Ranking**: matches are found through the GIN index on the full text; the 1,000 most recent matches are
  ranked with `ts_rank` on a small vector of the title (weight A) and the first 1,000 characters of the body
  (weight B), ties to the most recent; keyset paging. A very common word is therefore ranked among its newest
  matches, which suits a workspace, and every query costs about the same however much text matches it.
- **Permissions** are unchanged (E2): tenant (RLS plus an explicit predicate), the caller's current containers or
  `acl_users`, then chat-service re-checks the top hits against the owning databases.
- **Row-level security and the index**: `@@`, `%` and `LIKE` are not leakproof, so Postgres will not use them
  as index conditions on an RLS table and would read every row. Matching and typo lookup therefore go through
  two narrow `SECURITY DEFINER` functions owned by the maintenance role (`search_candidates`,
  `search_query_words`), which read the workspace from `app.tenant_id` exactly as the policy does and return keys
  and words only; documents are then read under RLS. This is the project's existing pattern for cross-row
  maintenance functions.
- **Ordering**: the event bus no longer orders events per aggregate, so an upsert never replaces a row with an
  older `updated_at`.
- chat-service reads the search database directly (`SEARCH_DATABASE_URL`) as Elasticsearch was read before;
  only the search-indexer writes it. `reindex` rebuilds it from the owning services' search feeds.

## Consequences

- One less JVM and volume: about 1 GB less memory and no `vm.max_map_count`; search data is in the Postgres
  backup (it stays rebuildable with `reindex`).
- Measured on 100k documents in one workspace: see [docs/database/search.md](../database/search.md#performance).
- Less linguistic smartness than Elasticsearch (no synonyms, no BM25 relevance tuning, no per-field
  highlighting; relevance looks at the title and the opening of a body); adequate for finding one company's
  messages, tasks and documents.
- Postgres has a 1 MB `tsvector` limit; bodies are indexed by their first 200,000 characters.
- Phase 2 of the lightweight stack turns every database into a schema of one database; `search` becomes a schema
  then, with the same tables.

## Addendum (2026-11-12): passages for AI retrieval

The AI answers from the workspace's own material, so search needs to return the paragraph, not the page: a question
about one clause of a long contract, a decision in a meeting's minutes, a number in a comment or in a spreadsheet.

- **Still Postgres full-text search.** The shipped image has no pgvector and the lightweight stack stays as it is.
  `search.search_passages` (migration `search/003`) holds each long text cut into overlapping passages of about a
  thousand characters with their nearest heading, the parent's container and ACL, and their own `tsvector`
  (`splitPassages`, `indexPassages` in service-kit `search.ts`). `searchPassages` reuses the same query builder
  (prefix, typo neighbours, OR fallback) and ranks by cover density with title and heading weighted, a mild lift for
  recent text, and at most two passages per thing. A rerank by embeddings can be added later over the candidates it
  returns; nothing in the index would change.
- **More is indexed, and the indexer reads text instead of receiving it.** Tasks with their comments, whole pages,
  meetings (agenda, minutes, action items), calendar entries, requests, and the words of Drive files and attachments
  (read in the background by the work module: text, PDF, Word, Excel, PowerPoint). Events only say that something
  changed (`work.task.*`, `work.document.*`, calendar and approval events, and `work.knowledge.changed.v1` for the
  rest); the indexer then asks the work module for the thing's current text (`POST /internal/knowledge`,
  `work/knowledge.ts`). Long texts stay out of the outbox, and events arriving out of order end in the same index.
- **Permissions as before.** Passages carry `container_id` and `acl_users`; chat's `GET /search/passages` filters
  on the reader's containers and rechecks every hit against the owning module before returning it.
- `reindex` rebuilds passages too (the `knowledge-*` feeds of the work module); an installation upgraded to this
  version runs it once to index what already exists.
