# workspace on Unraid

workspace is several containers (Postgres, the app, a proxy). Community Applications XML templates
describe one container each, so there is no CA template; use the **Docker Compose Manager** plugin instead:

1. Apps › install **Docker Compose Manager**.
2. Docker › Compose › **Add new stack** `workspace`, open **Edit stack › Compose file** and paste
   [`../docker-compose.yml`](../docker-compose.yml).
3. **Edit stack › Env file**:

   ```ini
   APP_URL=http://tower.local:8080
   WORKSPACE_PORT=8080
   # SMTP_URL=smtp://user:pass@host:587
   # MAIL_FROM=workspace <no-reply@example.com>
   ```

4. **Compose up**, then open `APP_URL/setup` with the setup token from the log of the `app` container
   (Docker tab › workspace-app-1 › Logs, line "setup token").

Data lives in Docker volumes (`workspace_pgdata`, `workspace_data`, `workspace_secrets`…) on the Docker image
disk. To keep it under `/mnt/user/appdata/workspace`, replace the volume names with paths, e.g.
`- /mnt/user/appdata/workspace/pgdata:/var/lib/postgresql/data`; the `data` and `secrets` folders must then be
owned by uid 1000 (`chown -R 1000:1000 /mnt/user/appdata/workspace/{data,secrets,proxy}`).

For HTTPS, put Unraid's reverse proxy (Nginx Proxy Manager, SWAG) in front of port 8080 and set `APP_URL` to the
`https://` address. Not yet run on a real Unraid server.
