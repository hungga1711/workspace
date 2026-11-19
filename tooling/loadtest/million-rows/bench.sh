#!/bin/sh
# Runs bench.sql (or the file given) against the benchmark database (BENCH_DATABASE, default workspace_bench) in the
# development Postgres container and prints one line per labelled query: execution time and the scan kinds in the
# plan. Run it twice and read the second run.
cd "$(dirname "$0")" || exit 1
docker exec -i workspace-postgres-1 psql -U postgres -d "${BENCH_DATABASE:-workspace_bench}" -v ON_ERROR_STOP=1 < "${1:-bench.sql}" 2>&1 | awk '
  /^Q[0-9]|^W[0-9]|^C[0-9]|^S[0-9]|^N[0-9]/ { if (label != "") print label " | " time " | " scans; label=$0; time=""; scans="" }
  /Execution Time/ { time = time $3 " ms " }
  /Seq Scan on [a-z_]+/ { match($0, /Seq Scan on [a-z_]+/); s=substr($0, RSTART, RLENGTH); if (index(scans, s)==0) scans = scans s "; " }
  /Index (Only )?Scan using [a-z_]+|Bitmap Index Scan on [a-z_]+/ { match($0, /(Index (Only )?Scan using|Bitmap Index Scan on) [a-z_]+/); s=substr($0, RSTART, RLENGTH); if (index(scans, s)==0) scans = scans s "; " }
  /Rows Removed by Filter/ { match($0, /Rows Removed by Filter: [0-9]+/); s=substr($0, RSTART, RLENGTH); if (index(scans, s)==0) scans = scans s "; " }
  /ERROR/ { scans = scans $0 }
  END { print label " | " time " | " scans }'
