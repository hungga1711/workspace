# ADR-0019: MIT licence

- Status: Accepted (supersedes [ADR-0010](0010-license-elastic-2.md))
- Date: 2026-10-25

## Context

ADR 0010 chose the Elastic License 2.0 so that nobody could sell workspace as a hosted service. Ahead of the public
release the owner weighed that protection against what the project needs most now: people who try it, deploy it,
package it and contribute to it.

- ELv2 is not an OSI licence. Some companies, Linux distributions, app catalogues and curated lists of self-hosted
  software accept only OSI licences, and many developers skip a repository that is "source-available".
- The restriction targets a risk that matters only once there is a market to protect. Today the larger risk is that
  nobody uses it.
- IT providers who run software for small companies are a natural way for workspace to reach the companies it is
  built for. Under ELv2 each of them needed a separate permission.
- A commercial-licence process adds work (requests, terms, enforcement) the project has no reason to carry.

## Decision

- License the whole repository under the **MIT License**, copyright Hung Tran. Every `package.json` declares
  `"license": "MIT"`.
- Anyone may use, copy, modify, merge, publish, distribute, sublicense and sell it, including as a hosted service,
  as long as the copyright and licence notice stay with the copies.
- There is no commercial licence and no dual licensing. `LICENSING.md` is removed; the README and `NOTICE.md` state
  the licence.
- Contributions are accepted under the same licence (inbound = outbound). No CLA and no DCO sign-off: opening a pull
  request is enough (CONTRIBUTING.md).

## Consequences

- workspace is open source in the OSI sense; it can be listed in catalogues and curated lists that require it, and
  packaged by anyone.
- Someone may offer workspace as a paid hosted service without giving anything back. The owner accepts that.
- Bundled third-party components keep their own licences, listed in `NOTICE.md`; none of them is incompatible with
  distributing workspace under MIT.
- Earlier copies distributed under ELv2 stay under ELv2 for whoever received them; the code is the same, so in
  practice everyone can take the MIT version.
