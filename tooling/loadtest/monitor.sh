#!/bin/sh
# Samples the server under test every INTERVAL seconds until killed, as CSV lines on stdout:
#   time,kind,name,cpu_percent,mem_mib
# kind = container (docker stats inside the test box), pg (connections, and events waiting in the outboxes, i.e. not
# yet handled by every consumer group), host (the load generator's own CPU and memory on this machine).
#
#   DOCKER="docker exec wxload docker" PROJECT=wxload sh tooling/loadtest/monitor.sh > results/monitor.csv
DOCKER=${DOCKER:-docker}
PROJECT=${PROJECT:-workspace-prod}
INTERVAL=${INTERVAL:-10}
echo "time,kind,name,cpu_percent,mem_mib"
while :; do
  now=$(date +%s)
  $DOCKER stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}}' 2>/dev/null | while IFS=, read -r name cpu mem; do
    used=$(echo "$mem" | awk '{print $1}')
    mib=$(echo "$used" | awk '/GiB/ {sub("GiB",""); printf "%.1f", $1*1024; next} /MiB/ {sub("MiB",""); printf "%.1f", $1; next} /kB|KiB/ {sub("[kK]i?B",""); printf "%.2f", $1/1024; next} {print 0}')
    echo "$now,container,${name#"$PROJECT"-},${cpu%\%},$mib"
  done
  conns=$($DOCKER exec "$PROJECT-postgres-1" psql -U postgres -tAc "SELECT count(*) FROM pg_stat_activity WHERE datname = 'workspace'" 2>/dev/null)
  echo "$now,pg,connections,,$conns"
  waiting_sql=$(for s in identity platform chat work home employee ai; do printf 'SELECT count(*) AS n FROM %s.outbox WHERE published_at IS NULL UNION ALL ' "$s"; done)
  waiting=$($DOCKER exec "$PROJECT-postgres-1" psql -U postgres -d workspace -tAc "SELECT sum(n) FROM (${waiting_sql% UNION ALL }) o" 2>/dev/null)
  echo "$now,pg,events_waiting,,${waiting:-0}"
  ps -Ao pid,%cpu,rss,comm | awk -v t="$now" '$4 ~ /k6$/ {printf "%s,host,k6,%s,%.1f\n", t, $2, $3/1024} $4 ~ /com.docker.backend$|com.docker.vpnkit$|vpnkit-bridge$/ {printf "%s,host,%s,%s,%.1f\n", t, $4, $2, $3/1024}'
  sleep "$INTERVAL"
done
