# ADR-0004: Keycloak for identity, sessions and SSO; authorization stays in the app

- Status: Superseded by [ADR-0014](0014-own-authentication.md) (2026-10-15)
- Date: 2026-10-15

## Context

The product needs password sign-in, password policies and brute-force protection, account recovery, company SSO (OIDC brokering per workspace), SCIM provisioning and session revocation on offboarding. Building credential storage in-house is high-risk; SaaS identity providers conflict with self-hosting.

## Decision

- Bundle **Keycloak 26** (`--features=organization`), one realm `workspace`, client `workspace-web`, one Keycloak **Organization** per workspace (E5). identity-service creates and reconciles the realm, client, theme and organizations at start (`backend/services/identity/src/keycloak.ts`); operators never click through the Keycloak console.
- The sign-in UI is ours: the BFF calls Keycloak's token endpoint server-side (direct access grant) or runs the code + PKCE flow for SSO with `kc_idp_hint`; the browser never sees Keycloak pages unless brokering to a company IdP. Keycloak brute-force protection is on; the BFF and gateway add per-IP/per-email limits.
- Activation and password-reset tokens are one-time hashed tokens in identity, mailed by SMTP.
- **Authorization is not delegated to Keycloak**: roles, grants, scopes and agents live in identity's database and `backend/packages/shared/src/authz` ([ADR-0003](0003-bff-gateway-internal-principal-token.md)).
- In production Keycloak runs on the private network over HTTP; it is published (`KEYCLOAK_PUBLIC_URL`, `auth.` Caddy block) only for company SSO.

## Consequences

- Mature credential handling, SSO brokering and session management for free; SCIM and offboarding end Keycloak sessions through its admin API.
- Keycloak is the heaviest JVM in the stack (~0.8 GB) and a hard dependency for sign-in and token refresh; its database lives in the same Postgres cluster (`keycloak` DB) and is covered by the same backup.
- Upgrading Keycloak needs care (pinned `26.0.7`); realm config drift is corrected by identity on start.
- `KEYCLOAK_ADMIN_PASSWORD` must be kept: identity uses the admin API continuously.
