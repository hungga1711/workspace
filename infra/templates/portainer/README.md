# workspace on Portainer

Two ways:

- **Stack from the repository**: Stacks › Add stack › Repository, URL `https://github.com/hungga1711/workspace`,
  compose path `infra/templates/docker-compose.yml`. Set `APP_URL` (and optionally `WORKSPACE_PORT`, `SMTP_URL`,
  `MAIL_FROM`) under Environment variables, then Deploy.
- **App Template**: Settings › App Templates › URL `https://raw.githubusercontent.com/hungga1711/workspace/main/infra/templates/portainer/templates.json`.
  workspace then appears under App Templates with the same variables.

The stack publishes plain HTTP on `WORKSPACE_PORT` (8080). Put your TLS proxy in front of it (Nginx Proxy Manager,
Traefik, a load balancer) and set `APP_URL` to the address people open. First run: `APP_URL/setup` with the setup
token from the `app` container's logs.

To check on a real Portainer (not yet run there): the template uses format version 3 with `type: 3` (a stack from a
Git repository); older Portainer CE releases accept only version 2, where the same entry works with
`"version": "2"`.
