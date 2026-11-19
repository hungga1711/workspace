# tooling/loadtest/

Capacity tests for a production install: how many people can use one server at the same time.
Results for the reference box (2 CPU, 4 GB) are in [infra/production/README.md §10](../../infra/production/README.md#10-capacity)
and [docs/runbooks/operations.md §8](../../docs/runbooks/operations.md#8-capacity-notes); they were measured before the backend
became one process ([ADR-0021](../../docs/adr/0021-one-server-no-valkey.md)) and have not been re-run since.

| File | What it does |
|---|---|
| `million-rows/` | **Dataset size, not concurrency:** a million rows in one workspace, EXPLAIN ANALYZE of the flagged queries, results and ranked fixes in its [README](million-rows/README.md). |
| `seed.mjs` | First-run setup, then N employees (with passwords), teams of 20 with a channel (30 messages of history) and a project each. Idempotent; rerun with a larger `--users` to grow. |
| `login.mjs` | Signs every seeded user in through the real `/login` form and saves their session cookies to `data/sessions.json`; `--tasks N` gives each new user N tasks of their own. |
| `ccu.js` | **Scenario A, the headline number.** Each virtual user keeps the realtime socket open (Socket.IO over WebSocket, presence heartbeat every 30 s) and every 30–60 s does one action: open Home (25 %), list my tasks (20 %), read their team channel (20 %), post in it (15 %), create or update a task (10 %), search (10 %). Chat delivery latency is measured on the receivers' sockets. |
| `idle-ws.js` | Scenario B: realtime connections only (ticket, socket, heartbeat). |
| `throughput.js` | Scenario C: the same action mix with no think time and no sockets (closed loop); every request as a different user. |
| `monitor.sh` | Samples per-container CPU and memory, Postgres connections and events waiting in the outboxes, and the load generator's own CPU every 10 s (CSV). |
| `run-step.sh` | One measured step: monitor + k6 + `report.py`. |
| `report.py` | Pass/fail of a step (hold window only) and resource peaks; appends to `results/summary.csv`. |

## Pass rules (per step, after the ramp)

- HTTP p95 under 500 ms over every request (Home is a full server-rendered page);
- under 1 % failed actions;
- chat delivery p95 under 1 s;
- no container restarted or killed (out of memory).

The headline CCU is the largest step that passes; between the last pass and the first fail the search is
narrowed to about 10 %.

## Running it

The server under test must be a real production stack (`infra/production`). To reproduce the reference box on
a bigger machine, run the whole stack inside one Docker-in-Docker container limited to 2 CPU and 4 GB, and run
k6 outside it:

```bash
docker run -d --name wxload --privileged --cpuset-cpus=2,3 --cpus=2 --memory=4g --memory-swap=4g \
  --ulimit nofile=1048576:1048576 -v wxload-docker:/var/lib/docker \
  -v "$PWD":"$PWD" -v /path/to/env-and-certs:/path/to/env-and-certs -p 443:443 -p 80:80 \
  -e DOCKER_TLS_CERTDIR= docker:27.5.1-dind
for i in workspace:local postgres:16.4-alpine caddy:2.8.4-alpine; do   # + chrislusf/seaweedfs:3.80 with --profile s3
  docker save "$i" | docker exec -i wxload docker load
done
docker exec -w "$PWD/infra/production" wxload docker compose -p wxload --env-file <env> -f docker-compose.yml -f <override> up -d
```

The env file is a normal production `.env` (APP_DOMAIN `app.wx.test`, a TLS certificate for it) plus two
test-only settings, because every virtual user comes from the same IP address:

```
RATE_RECOVERY_PER_HOUR=5000     # per-IP sign-in (30×) and token refresh (600×) ceilings
LOGIN_MAX_FAILS_PER_IP=100000
```

Per-user limits (600 requests a minute) stay at their production defaults.

```bash
node tooling/loadtest/seed.mjs --users 6000                 # ~20 min (bcrypt per invite, owner rate limit)
node tooling/loadtest/login.mjs --tasks 3                   # ~5 sign-ins per second on 2 CPU
sh tooling/loadtest/run-step.sh ccu 1000 -e STAGES=1000:3 -e RAMP=2m
sh tooling/loadtest/run-step.sh idle 8000 -e TARGET=8000 -e RAMP=10m
sh tooling/loadtest/run-step.sh throughput 64 -e VUS=64
cat tooling/loadtest/results/summary.csv
```

`APP_HOST` (default `app.wx.test`) and `TARGET_IP` (default `127.0.0.1`) point the scripts at the server; k6
maps the host name itself, so no `/etc/hosts` change is needed. Keep the generator off the server under test
and check its own CPU in the monitor output (`host,k6`).
