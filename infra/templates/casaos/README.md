# workspace on CasaOS

1. CasaOS › App Store › **Custom Install** › Import (top right) and paste [`docker-compose.yml`](docker-compose.yml).
2. In the app's settings set `APP_URL` on every workspace service to the address you will open, e.g.
   `http://casaos.local:8080` (it defaults to `http://localhost:8080`; links, cookies and the security policy use it).
3. Install, open the app (it lands on `/setup`) and paste the setup token from the `app` container's log
   (`docker logs workspace-app-1 2>&1 | grep "setup token"`).

Data stays in Docker volumes (`workspace_pgdata`, `workspace_data`, `workspace_secrets`…). The `x-casaos` block
follows the CasaOS app format (title, tagline, description per language, `main`, `port_map`, `index`); it was written
from the CasaOS AppStore documentation and has not been imported on a real CasaOS yet. The icon URL points to the
repository once it is published.
