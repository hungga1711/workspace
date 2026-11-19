#!/bin/sh
# One measured step: starts the sampler, runs a k6 scenario, stops the sampler. Results land in results/.
#   sh tooling/loadtest/run-step.sh ccu 1000 -e STAGES=1000:3 -e RAMP=2m
#   sh tooling/loadtest/run-step.sh idle 5000 -e TARGET=5000 -e RAMP=10m
#   sh tooling/loadtest/run-step.sh throughput 100 -e VUS=100
set -e
cd "$(dirname "$0")"
kind=$1; label=$2; shift 2
mkdir -p results
out="results/$kind-$label"
DOCKER=${DOCKER:-"docker exec wxload docker"} PROJECT=${PROJECT:-wxload} sh monitor.sh > "$out.monitor.csv" &
mon=$!
trap 'kill $mon 2>/dev/null' EXIT
script=ccu.js
[ "$kind" = idle ] && script=idle-ws.js
[ "$kind" = throughput ] && script=throughput.js
k6 run -q --no-color -e SUMMARY="$out.json" "$@" "$script" > "$out.k6.log" 2>&1 || true
kill $mon 2>/dev/null || true
python3 report.py "$out"
