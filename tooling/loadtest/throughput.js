// Scenario C — throughput: VUS signed-in users repeat the same action mix as ccu.js with no think time and
// no sockets (closed loop), so the box answers as fast as it can. Run at increasing VUS to find the highest
// request rate whose p95 stays under 500 ms.
//
//   k6 run -e VUS=50 -e DURATION=3m tooling/loadtest/throughput.js
import http from "k6/http";
import exec from "k6/execution";
import { SharedArray } from "k6/data";
import { Rate } from "k6/metrics";

const HOST = __ENV.APP_HOST || "app.wx.test";
const BASE = `https://${HOST}`;
const sessions = new SharedArray("sessions", () => JSON.parse(open("./data/sessions.json")));
const WARMUP_MS = 30_000;
const phase = () => (exec.instance.currentTestRunDuration > WARMUP_MS ? "hold" : "warmup");

export const options = {
  hosts: { [HOST]: __ENV.TARGET_IP || "127.0.0.1" },
  insecureSkipTLSVerify: true,
  summaryTrendStats: ["avg", "p(50)", "p(90)", "p(95)", "p(99)", "max", "count"],
  scenarios: { load: { executor: "constant-vus", vus: Number(__ENV.VUS || 50), duration: __ENV.DURATION || "3m" } },
  thresholds: Object.fromEntries(
    ["home_page", "my_tasks", "channel_history", "chat_send", "task_create", "search"]
      .map((n) => [`http_req_duration{name:${n},phase:hold}`, ["max>=0"]])
      .concat([
        ["http_req_duration{phase:hold}", ["max>=0"]],
        ["http_reqs{phase:hold}", ["count>=0"]],
        ["action_ok{phase:hold}", ["rate>=0"]],
      ]),
  ),
};

const actionOk = new Rate("action_ok");
const WORDS = ["thanh toán", "báo cáo", "kế hoạch", "phát hành", "tiến độ"];
const MIX = [
  ["home_page", 25, "GET", () => "/app/home"],
  ["my_tasks", 20, "GET", () => "/api/proxy/work/tasks?scope=assigned"],
  ["channel_history", 20, "GET", (me) => `/api/proxy/chat/channels/${me.channelId}/messages`],
  ["chat_send", 15, "POST", (me) => `/api/proxy/chat/channels/${me.channelId}/messages`, () => ({ body: `lt:${Date.now()}:${exec.vu.idInTest} thông lượng` })],
  ["task_create", 10, "POST", () => "/api/proxy/work/tasks", (me) => ({ title: `Thông lượng ${exec.vu.idInTest}-${Date.now()}`, assigneeId: me.userId })],
  ["search", 10, "GET", () => `/api/proxy/chat/search?q=${encodeURIComponent(WORDS[Math.floor(Math.random() * WORDS.length)])}`],
];
// ONLY=<name> runs a single action (cost per request of one action type).
const ACTIVE = __ENV.ONLY ? MIX.filter((m) => m[0] === __ENV.ONLY) : MIX;
const TOTAL = ACTIVE.reduce((a, m) => a + m[1], 0);

export default function () {
  // Every request as a different user (round robin): the per-user limit (600/min) is not what is measured.
  const me = sessions[exec.scenario.iterationInTest % sessions.length];
  let r = Math.random() * TOTAL;
  const [name, , method, path, body] = ACTIVE.find((m) => (r -= m[1]) < 0) ?? ACTIVE[0];
  const res = http.request(method, `${BASE}${path(me)}`, body ? JSON.stringify(body(me)) : null, {
    headers: { cookie: me.cookie, origin: BASE, "x-wos-csrf": "1", "content-type": "application/json", "accept-encoding": "gzip" },
    tags: { name, phase: phase() },
    timeout: "30s",
  });
  actionOk.add(res.status >= 200 && res.status < 400, { name, phase: phase() });
}

export function handleSummary(data) {
  const out = JSON.stringify({ vus: __ENV.VUS, metrics: Object.fromEntries(Object.entries(data.metrics).map(([k, v]) => [k, v.values])) }, null, 1);
  return __ENV.SUMMARY ? { [__ENV.SUMMARY]: out, stdout: "" } : { stdout: out };
}
