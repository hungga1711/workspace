# ADR-0003: Next.js BFF and API gateway with signed internal principal tokens

- Status: Accepted
- Date: 2026-10-15

## Context

Browser JavaScript should never hold OAuth tokens (XSS exfiltration), cookies cannot hold three Keycloak JWTs (4 KB limit), and services should not each re-implement token validation, membership lookup and rate limiting. Services also must never trust a client-supplied tenant id.

## Decision

- **BFF**: the Next.js server (`frontend/web`) keeps Keycloak tokens in Redis-backed server sessions (`src/lib/session.ts`; httpOnly SameSite=Lax cookie with an opaque id; store key = hash of secret + id). Client components call the same-origin proxy `src/app/api/proxy/[...path]/route.ts`, which attaches the bearer token and requires `x-wos-csrf: 1` on non-GET requests.
- **Gateway** (`backend/gateway/src/gateway.ts`): verifies the Keycloak JWT (JWKS, issuer, `azp`), or resolves a `wos_` API key; resolves the installation's one workspace itself (ADR 0005; until 2026-10-28 clients sent an `x-workspace-id` selector); resolves the principal from identity (Redis cache 60 s, evicted on member/role/team changes); applies Redis fixed-window rate limits; routes `/api/<service>/*`.
- Gateway signs an **internal principal token** (`backend/packages/service-kit/src/internal-token.ts`): HS256 with `INTERNAL_TOKEN_SECRET`, issuer `workspace-gateway`, audience `workspace-services`, 60 s, carrying the full principal (grants, teams, department) and request id, sent as `x-workspace-principal`. Services verify it in `principalMiddleware` and trust nothing else. The same token format is the Socket.IO ticket.

## Consequences

- Services are simple and uniform: no Keycloak dependency, no membership queries, authorization from the token's grants.
- Revocation latency: role/member changes apply at once through cache eviction; API-key revocation within 30 s; an issued internal token lives ≤ 60 s.
- `INTERNAL_TOKEN_SECRET` is a crown-jewel symmetric secret shared by all services; rotating it signs everyone out and, unless `AI_SECRETS_KEY` is set, invalidates stored AI keys ([ADR-0006](0006-optional-ai-company-gateway.md)). Asymmetric signing would allow verify-only services; not needed on one host.
- Two hops (web → gateway → service) add latency (single-digit ms on one host) in exchange for one enforcement point.
