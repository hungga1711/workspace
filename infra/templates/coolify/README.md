# workspace on Coolify

1. In Coolify: **Project › New resource › Docker Compose Empty** and paste [`docker-compose.yml`](docker-compose.yml)
   (or **Public repository** with this repository and the compose path `infra/templates/coolify/docker-compose.yml`).
2. Coolify reads `SERVICE_FQDN_PROXY_80` on the `proxy` service: it generates a domain (edit it under the
   service's settings), routes it to port 80 of `proxy` with its certificate, and passes the address as
   `${SERVICE_URL_PROXY}` (the address with its `https://`) to `APP_URL`.
3. Deploy, then open `https://<domain>/setup` with the setup token from the `app` logs (`setup token`).

Optional: `SMTP_URL` and `MAIL_FROM` in the resource's environment variables.

To check on a real Coolify (not yet run there):

- The `# documentation/slogan/tags/logo/port` header is what Coolify's service catalogue reads; `logo:` points to a
  file in Coolify's own repository (`svgs/workspace.svg`) and only matters when the template is submitted there.
- Coolify may add its own labels and networks; the containers find each other by name (`postgres`, `app`) on the
  compose network, which Coolify keeps.
