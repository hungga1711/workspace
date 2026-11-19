# ADR-0022: No OpenTelemetry; logs with request ids and the audit log. SMTP only, no local mail catcher

- Status: Accepted
- Date: 2026-10-27
- Amends: [ADR-0017](0017-nginx-and-lean-image.md) (no OpenTelemetry preload in the image) and
  [ADR-0021](0021-one-server-no-valkey.md) (the local stack loses Mailpit and Grafana).

## Context

workspace is an internal app: one company, one installation, usually one small server run by someone who is not an
SRE. OpenTelemetry (traces, metrics and logs over OTLP, a Grafana stack locally) cost a preload in every process,
thirteen backend packages and two in the web app, a container in development, and was off in production by default.
What owners actually ask is "who did what", which the audit log answers, and "why did this request fail", which one
log line with its request id answers.

Mailpit caught every email in development, so nothing proved that a real SMTP server worked until production.

## Decision

- **No OpenTelemetry**: no SDK, no instrumentation, no metrics, no `traceparent` in the event envelope (older stored
  events still parse; the field is dropped). The server starts with plain `node dist/main.js`.
- **What remains**: pino JSON logs on stdout with `requestId`, `tenantId` and `actorId`; the request id in every
  error body and the `x-request-id` header, carried through events; the audit log in Admin › Nhật ký; `/health`;
  dead letters (`dlq list`); the web app's server errors and web vitals as JSON log lines.
- **Email is SMTP everywhere**: `SMTP_URL` points at the company's mail server in development as in production.
  Without it nothing is sent and invites and resets hand back a link. Manual checks use a yopmail.com address.
- **Automated tests** never send email: with `MAIL_OUTBOX_DIR` (ignored in production) each email is written there
  as a JSON file, which the integration and end-to-end suites read. The demo seed invites members with a temporary
  password that each one changes, so it needs no email at all.

## Consequences

- Fewer dependencies and a smaller image; no instrumentation hooks at startup.
- No latency histograms or dashboards. Slow requests and failures are found in the logs; a company that wants
  central logging ships Docker's JSON logs with its own log driver.
- Delivery problems with the company's SMTP server show up in development, not after launch.
