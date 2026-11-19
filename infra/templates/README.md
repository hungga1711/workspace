# One-click templates

For hosting platforms that deploy a compose file or an image on their own. Each folder has the platform's format
and a short README. The full installation (Let's Encrypt, bundled S3, LiveKit, AI) is
[`infra/production/`](../production/README.md) with `install.sh`.

| Folder | Platform format | Status |
|---|---|---|
| [`docker-compose.yml`](docker-compose.yml) | Plain Compose, no bind mounts; any host or platform that takes a compose file | Tested locally (`docker compose up`) |
| [`coolify/`](coolify/) | Coolify service template (compose with `SERVICE_FQDN_*` magic variables) | Not run on Coolify yet |
| [`portainer/`](portainer/) | Portainer App Templates v3 (`templates.json`, type 3 = stack from the repository) | Not run on Portainer yet |
| [`railway.json`](railway.json), [`railway.md`](railway.md) | Railway config-as-code for the `app` service; Postgres and the domains are added in Railway | Not run on Railway yet |
| [`unraid/`](unraid/) | Compose Manager plugin (multi-container apps have no Community Applications XML) | Not run on Unraid yet |
| [`casaos/`](casaos/) | CasaOS app: compose with `x-casaos` metadata | Not run on CasaOS yet |

What they share (from [`docker-compose.yml`](docker-compose.yml)):

- One image (`ghcr.io/hungga1711/workspace`), three containers: Postgres, `app` (the web app and the server, every
  module in one process) and a small Caddy (`proxy`) that routes `/socket.io/`, `/storage/`, `/api/mcp` and
  `/api/docs` to the server and the rest to the web app ([`Caddyfile`](Caddyfile)). The platform's own proxy
  terminates TLS in front of it.
- Nothing to bind-mount: the `init` job generates every secret once (volume `secrets`) and copies the database
  bootstrap and the proxy configuration into volumes.
- Files on local disk (volume `data`). Video meetings are off; add them with `infra/production/`. AI is off until
  an admin connects a provider in Admin › AI.
- Set `APP_URL` to the public address before the first start: links in e-mails, cookies and the security
  policy use it.
- First run: open `APP_URL/setup` and paste the setup token from the app container's log
  (`docker logs <app container> 2>&1 | grep "setup token"`).
- Back up the `pgdata`, `data` and `secrets` volumes (see [docs/runbooks/backup-restore.md](../../docs/runbooks/backup-restore.md)).

Formats follow each platform's documentation; anything a platform might reject is
listed in that folder's README. Reports from real installs are welcome.
