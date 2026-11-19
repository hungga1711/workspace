# ADR-0014: Own authentication in identity-service (supersedes ADR-0004)

- Status: Accepted
- Date: 2026-10-15
- Supersedes: [ADR-0004](0004-keycloak-identity.md)
- Amended 2026-11-11: company SSO (the OIDC relying party below) and SCIM provisioning were removed. Sign-in is email
  and password, with optional two-step codes; the rest of this decision stands.

## Context

Keycloak gave us password sign-in, lockout, sessions, OIDC brokering for company SSO and token issuance, but it
is the heaviest process in the stack (≈ 0.55–0.8 GB of JVM heap, a minute to start, its own database and admin
console to secure) for a self-hosted, single-workspace product that must run on a 2–4 GB server. We already
owned the sign-in screen, recovery, invitations, authorization and the SSO settings; Keycloak only held the
credentials and minted tokens. The owner asked for "full security, no unusual libraries".

## Decision

identity-service authenticates people itself (`backend/services/identity/src/auth/`), with two well-known
libraries (`bcrypt`, `jose`) and `node:crypto` for the rest.

- **Passwords**: bcrypt, cost 12, async (libuv pool). More than 72 bytes is refused, never truncated. Unknown
  emails are compared against a dummy hash, so timing does not reveal accounts.
- **Lockout**: per email in Redis (known or unknown alike): 5 failures → 30 s, doubling to 15 min; per-IP
  ceilings in the gateway and the BFF. Every success and failure lands in `auth_events` (90 days), which feeds
  Me › Bảo mật and Admin › Bảo mật.
- **Access token**: JWT, EdDSA (Ed25519), 10 minutes, `typ: at+jwt`; claims `sub`, `sid`, `rv` (account
  version), `mfa`, `iss`/`aud` = `workspace`, `jti`. Keys rotate every 30 days; the previous key verifies for
  one more day. Private keys are stored AES-256-GCM-encrypted with a key derived (HKDF) from `AUTH_SECRET`.
  `GET /internal/auth/jwks` publishes the public keys.
- **Refresh token**: 256 random bits, stored as SHA-256, 30 days, replaced on every use. A spent token
  presented again revokes the whole session (theft detection). Sessions end after 90 days regardless.
- **Who verifies what** (the faster safe option): the gateway verifies the access token locally (cached
  JWKS, EdDSA only) and checks the session against a 60-second Redis cache of its state (`authsess:<sid>`),
  filled from identity on a miss. identity *overwrites* that entry the moment a session is revoked or the
  account version changes, so sign-out, "sign out everywhere", password change, refresh-token reuse and
  offboarding apply on the next request; the gateway only fills absent entries (`SET NX`), so it never puts
  stale state back. Services keep verifying the gateway-signed principal token (HMAC, 60 s; now also
  carrying the session id) rather than every service re-verifying the user JWT and re-resolving grants: one
  verification and one grants lookup per request instead of one per hop, with the same trust boundary
  (services accept nothing unsigned).
- **Two-step sign-in**: TOTP (RFC 6238, SHA-1, 6 digits, ±1 step), each time step accepted once (stored
  atomically); ten single-use recovery codes stored hashed; a challenge allows five attempts in five minutes.
  A workspace can require it (`tenant_limits.require_mfa`): sessions without it get 403
  `mfa_setup_required` everywhere except the set-up endpoints. The admin must use it before requiring it.
- **Company SSO**: identity is the OIDC relying party: discovery (issuer must match), authorization code
  with PKCE S256, `state` (hashed, single use, 10 min, also bound to the browser by an httpOnly cookie in the
  BFF), `nonce`, client secret encrypted at rest. The id_token is verified with jose (asymmetric algorithms
  only, issuer, audience/azp, expiry, nonce). The email must be in a domain the workspace proved by DNS.
  Accounts link by IdP subject, else by email in that domain. SSO sessions count as two-step.
- **Web**: tokens stay server-side in the BFF session (Redis); the browser holds only an opaque httpOnly,
  Secure, SameSite=Lax cookie. Mutations need the custom CSRF header and a same-origin `Origin`.

## Consequences

- Keycloak, its database, theme, admin password and the `auth.` subdomain are gone: about 0.6–0.8 GB less RAM
  and one less public surface. SSO needs only `<APP_URL>/auth/sso/callback` registered at the IdP.
- We own security-critical code. It is covered by `backend/gateway/test/auth.test.ts` (timing path, lockout,
  forged/alg-none/HS256/foreign-key/expired tokens, refresh reuse, revocation, password change, TOTP replay,
  recovery codes, policy gate) and `backend/services/identity/test/sso.test.ts` (PKCE, state replay, nonce,
  audience, issuer, alg none, unverified or foreign email), against a local OIDC provider.
- Not provided (Keycloak had them): SAML, social login, WebAuthn/passkeys, an admin console for accounts.
  They can be added in identity-service when a customer needs them.
- Accounts created in the Keycloak era keep their ids (migration 017 copies them from `members`) but have no
  password here: they use "Quên mật khẩu" once.
