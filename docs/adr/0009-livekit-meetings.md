# ADR-0009: LiveKit SFU for video meetings

- Status: Accepted (amended by [ADR-0021](0021-one-server-no-valkey.md): Caddy is the reverse proxy)
- Date: 2026-10-15

## Context

Meetings (scheduled, ad-hoc, guest links, screen share, optional recording) are part of the work suite and must be self-hostable. Peer-to-peer WebRTC does not scale beyond a few participants; proprietary meeting APIs conflict with self-hosting; routing media through Node services is infeasible.

## Decision

- Use **LiveKit** (open-source WebRTC SFU, Apache-2.0). work-service (`backend/services/work/src/rooms.ts`) owns rooms, the guest lobby and recordings, and signs short-lived join tokens with `LIVEKIT_API_KEY/SECRET`; it uses the LiveKit server API for room control. Media flows browser ⇄ SFU only.
- Guests join via unguessable codes (`abc-defg-hij`) on public, per-IP rate-limited gateway routes (`/api/meet/:code`, `/join`, `/status`).
- Recording uses **LiveKit Egress** uploading straight to object storage (`MEET_RECORDING=on`, retention sweep `MEET_RECORDING_RETENTION_DAYS`, default 365); available in local compose (`--profile recording`), not in the production compose yet.
- Production: optional `--profile meet`, `LIVEKIT_URL=wss://meet.<domain>` behind Caddy, TCP 7881 + UDP 50000–50100 open; CSP allows the LiveKit origin. Web client uses `@livekit/components-react`, loaded only on meeting routes.

## Consequences

- Scalable, standard SFU with mature clients; no media load on application services.
- Extra public ports and UDP firewall rules; users behind strict firewalls may need a TURN server (not bundled).
- Meetings are disabled cleanly when `LIVEKIT_*` is unset.
- Recording needs extra CPU and is not yet packaged for production.
