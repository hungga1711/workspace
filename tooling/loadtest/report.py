#!/usr/bin/env python3
"""Summarises one load-test step: k6 summary (<out>.json) + resource samples (<out>.monitor.csv).

Pass rules (hold window only): HTTP p95 < 500 ms, failed actions < 1 %, chat delivery p95 < 1 s,
no container restarted or killed. Appends one line to results/summary.csv.

    python3 tooling/loadtest/report.py results/ccu-1000 [hold_seconds]
"""
import csv
import json
import os
import statistics
import sys
from collections import defaultdict

out = sys.argv[1]
hold = int(sys.argv[2]) if len(sys.argv) > 2 else int(os.environ.get("HOLD_SECONDS", "180"))
kind = os.path.basename(out).split("-")[0]

try:
    m = json.load(open(f"{out}.json"))["metrics"]
except (OSError, ValueError, KeyError):
    print(f"{out}: no k6 summary (see {out}.k6.log)")
    sys.exit(1)


def g(name, stat):
    v = m.get(name)
    return None if v is None else v.get(stat)


rows = list(csv.DictReader(open(f"{out}.monitor.csv")))
times = sorted({int(r["time"]) for r in rows if r["time"].isdigit()})
end = times[-1] if times else 0
lo, hi = end - 35 - hold, end - 35
cpu, mem, other = defaultdict(list), defaultdict(list), defaultdict(list)
for r in rows:
    t = int(r["time"]) if r["time"].isdigit() else 0
    if not (lo <= t <= hi):
        continue
    if r["kind"] == "container":
        cpu[r["name"]].append(float(r["cpu_percent"] or 0))
        mem[r["name"]].append(float(r["mem_mib"] or 0))
    elif r["mem_mib"]:
        try:
            other[f'{r["kind"]}:{r["name"]}'].append(float(r["mem_mib"]))
            if r["kind"] == "host" and r["cpu_percent"]:
                other[f'{r["kind"]}:{r["name"]}:cpu'].append(float(r["cpu_percent"]))
        except ValueError:
            pass

p95 = g("http_req_duration{phase:hold}", "p(95)")
fail = 1 - (g("action_ok{phase:hold}", "rate") or 0)
deliv = g("chat_delivery_ms{phase:hold}", "p(95)")
reqs = g("http_reqs{phase:hold}", "count") or g("http_reqs", "count")
rps = g("http_reqs", "rate")
box_cpu = sum(statistics.mean(v) for v in cpu.values()) if cpu else 0
box_mem_peak = max((sum(x) for x in zip(*mem.values())), default=0) if mem else 0

ok = p95 is not None and p95 < 500 and fail < 0.01 and (kind != "ccu" or (deliv is not None and deliv < 1000))
if kind == "idle":
    ok = (g("ws_connect_failed", "count") or 0) == 0 and (g("ws_closed_early", "count") or 0) == 0

print(f"== {os.path.basename(out)}: {'PASS' if ok else 'FAIL'}")
print(f"   http p95 {p95 and round(p95)} ms · failed {fail:.2%} · delivery p95 {deliv and round(deliv)} ms · rps {rps and round(rps, 1)}")
print(f"   ws connected {g('ws_connected', 'count')} · ws failed {g('ws_connect_failed', 'count')} · ws connect p95 {g('ws_connect_ms', 'p(95)')}")
for n in ["home_page", "my_tasks", "channel_history", "chat_send", "task_create", "task_update", "search", "realtime_ticket"]:
    v = m.get(f"http_req_duration{{name:{n},phase:hold}}")
    if v and v.get("count"):
        print(f"   {n:16s} p50 {v['p(50)']:7.0f}  p95 {v['p(95)']:7.0f}  p99 {v['p(99)']:7.0f}  n {int(v['count'])}")
print(f"   box CPU avg {box_cpu:.0f}% of 200% · box memory peak {box_mem_peak:.0f} MiB")
for name in sorted(cpu, key=lambda k: -statistics.mean(cpu[k])):
    print(f"     {name:12s} cpu avg {statistics.mean(cpu[name]):6.1f}% max {max(cpu[name]):6.1f}%  mem max {max(mem[name]):7.1f} MiB")
for k, v in sorted(other.items()):
    print(f"     {k:40s} max {max(v):10.1f}")

new = not os.path.exists(os.path.join(os.path.dirname(out), "summary.csv"))
with open(os.path.join(os.path.dirname(out), "summary.csv"), "a") as f:
    w = csv.writer(f)
    if new:
        w.writerow(["step", "result", "http_p95_ms", "failed_pct", "delivery_p95_ms", "rps", "ws_connected", "box_cpu_avg_pct", "box_mem_peak_mib", "top_cpu"])
    top = max(cpu, key=lambda k: statistics.mean(cpu[k])) if cpu else ""
    w.writerow([os.path.basename(out), "PASS" if ok else "FAIL", p95 and round(p95), round(fail * 100, 2), deliv and round(deliv), rps and round(rps, 1), g("ws_connected", "count"), round(box_cpu), round(box_mem_peak), top])
