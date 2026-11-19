# ADR-0010: Elastic License 2.0 (source-available)

- Status: Superseded by [ADR-0019](0019-license-mit.md) (2026-10-25)
- Date: 2026-10-15

## Context

The owner wants any company to be able to take workspace, modify it and run it on its own systems for its own
staff, free of charge, but nobody may turn it into a hosted service and sell it. AGPL-3.0, the placeholder used
until now, permits selling it as a service as long as the source is published, so it does not express that intent.
Permissive licences (MIT, Apache-2.0) permit it outright.

## Decision

- License the whole repository under the **Elastic License 2.0** (SPDX `Elastic-2.0`), copyright Hung Tran.
  Every `package.json` declares `"license": "Elastic-2.0"`.
- What it allows: use, copy, modify, redistribute and self-host, including inside a company for its own employees,
  commercially or not. What it forbids: providing the software to third parties as a hosted or managed service
  that exposes a substantial set of its features, and removing licensing or copyright notices.
- workspace has no licence-key functionality, so ELv2's licence-key clause has no effect here.
- Contributions are accepted under the same licence (CONTRIBUTING.md).

## Consequences

- The licence matches the intent with a short, widely known text (also used by Elasticsearch, Airbyte and others).
- workspace is **source-available, not open source** in the OSI sense; the README says so. Some distributions
  and companies with OSI-only policies will not adopt it.
- An IT provider running it on behalf of a client company counts as a managed service and needs the owner's
  permission (a separate commercial licence), which the README invites.
- Bundled third-party components keep their own licences (LiveKit, SeaweedFS, certbot: Apache-2.0; Valkey: BSD-3;
  nginx: BSD-2; PostgreSQL: its own licence; libvips through sharp: LGPL; the rest per their packages). The current
  list is kept in `NOTICE.md` (updated 2026-10-18; Keycloak and Elasticsearch were replaced, ADRs 0013 and 0014).
