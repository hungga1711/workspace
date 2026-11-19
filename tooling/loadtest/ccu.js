// Scenario A — realistic concurrent users. Each virtual user is one signed-in employee (cookies from
// data/sessions.json) who keeps the app's realtime connection open (Socket.IO over WebSocket, as the browser
// does) and every THINK_MIN–THINK_MAX seconds does one thing from a weighted mix: open Home, list my tasks,
// read their team channel, post in it, create or update a task, search. Chat delivery latency is measured
// on the receivers' sockets (sender and receivers share this machine's clock).
//
//   k6 run -e STAGES=250:3,500:3,1000:3 tooling/loadtest/ccu.js     (users:minutes held, 1 min ramps)
import http from "k6/http";
import exec from "k6/execution";
import { SharedArray } from "k6/data";
import { Counter, Rate, Trend } from "k6/metrics";
import { WebSocket } from "k6/websockets";
import { setInterval, setTimeout, clearInterval, clearTimeout } from "k6/timers";

const HOST = __ENV.APP_HOST || "app.wx.test";
const BASE = `https://${HOST}`;
const THINK_MIN = Number(__ENV.THINK_MIN || 30);
const THINK_MAX = Number(__ENV.THINK_MAX || 60);
const RAMP = __ENV.RAMP || "1m";
const rampMs = (() => {
  const m = RAMP.match(/^(\d+)(s|m)$/);
  return m ? Number(m[1]) * (m[2] === "m" ? 60_000 : 1000) : 60_000;
})();
// Requests and deliveries are tagged "ramp" or "hold"; pass/fail is judged on the hold window only.
const phase = () => (exec.instance.currentTestRunDuration > rampMs + 15_000 ? "hold" : "ramp");

const sessions = new SharedArray("sessions", () => JSON.parse(open("./data/sessions.json")));

function stages() {
  const out = [];
  for (const s of (__ENV.STAGES || "250:3").split(",")) {
    const [users, minutes] = s.split(":");
    out.push({ target: Number(users), duration: RAMP }, { target: Number(users), duration: `${minutes}m` });
  }
  out.push({ target: 0, duration: "30s" });
  return out;
}

export const options = {
  hosts: { [HOST]: __ENV.TARGET_IP || "127.0.0.1" },
  insecureSkipTLSVerify: true,
  discardResponseBodies: false,
  summaryTrendStats: ["avg", "p(50)", "p(90)", "p(95)", "p(99)", "max", "count"],
  // Thresholds only expose per-tag sub-metrics in the summary; the real pass/fail rules are applied in report.py.
  thresholds: Object.fromEntries(
    ["home_page", "my_tasks", "channel_history", "chat_send", "task_create", "task_update", "search", "realtime_ticket"]
      .map((n) => [`http_req_duration{name:${n},phase:hold}`, ["max>=0"]])
      .concat([
        ["http_req_duration{phase:hold}", ["max>=0"]],
        ["http_req_failed{phase:hold}", ["rate>=0"]],
        ["action_ok{phase:hold}", ["rate>=0"]],
        ["chat_delivery_ms{phase:hold}", ["max>=0"]],
      ]),
  ),
  scenarios: {
    ccu: { executor: "ramping-vus", startVUs: 0, stages: stages(), gracefulRampDown: "10s", gracefulStop: "10s" },
  },
};

const delivery = new Trend("chat_delivery_ms", true);
const wsConnect = new Trend("ws_connect_ms", true);
const wsFail = new Counter("ws_connect_failed");
const wsOpen = new Counter("ws_connected");
const actionOk = new Rate("action_ok");

const WORDS = ["thanh toán", "báo cáo", "kế hoạch", "phát hành", "tiến độ", "nhom", "bao cao tuan"];
const MIX = [
  ["home", 25],
  ["tasks", 20],
  ["channel", 20],
  ["send", 15],
  ["task_write", 10],
  ["search", 10],
];
const TOTAL = MIX.reduce((a, [, w]) => a + w, 0);
const pick = () => {
  let r = Math.random() * TOTAL;
  for (const [name, w] of MIX) if ((r -= w) < 0) return name;
  return "home";
};

function params(me, name, extra = {}) {
  return {
    headers: { cookie: me.cookie, origin: BASE, "x-wos-csrf": "1", "content-type": "application/json", "accept-encoding": "gzip", ...extra },
    tags: { name, phase: phase() },
    timeout: "30s",
  };
}

async function call(me, name, method, path, body) {
  const res = await http.asyncRequest(method, `${BASE}${path}`, body === undefined ? null : JSON.stringify(body), params(me, name));
  const ok = res.status >= 200 && res.status < 400;
  actionOk.add(ok, { name, phase: phase() });
  return res;
}

async function act(me, state) {
  const what = pick();
  switch (what) {
    case "home":
      await call(me, "home_page", "GET", "/app/home");
      break;
    case "tasks":
      await call(me, "my_tasks", "GET", "/api/proxy/work/tasks?scope=assigned");
      break;
    case "channel":
      await call(me, "channel_history", "GET", `/api/proxy/chat/channels/${me.channelId}/messages`);
      break;
    case "send":
      await call(me, "chat_send", "POST", `/api/proxy/chat/channels/${me.channelId}/messages`, { body: `lt:${Date.now()}:${exec.vu.idInTest} cập nhật tiến độ` });
      break;
    case "task_write":
      if (state.task && Math.random() < 0.5) {
        const r = await call(me, "task_update", "PATCH", `/api/proxy/work/tasks/${state.task.id}`, {
          expectedVersion: state.task.version,
          priority: Math.random() < 0.5 ? "high" : "medium",
        });
        if (r.status === 200) state.task = r.json("task") ?? r.json();
        else state.task = null;
      } else {
        const r = await call(me, "task_create", "POST", "/api/proxy/work/tasks", { title: `Việc tải thử ${exec.vu.idInTest}-${Date.now()}`, assigneeId: me.userId });
        if (r.status === 201 || r.status === 200) state.task = r.json();
      }
      break;
    case "search":
      await call(me, "search", "GET", `/api/proxy/chat/search?q=${encodeURIComponent(WORDS[Math.floor(Math.random() * WORDS.length)])}`);
      break;
  }
}

const think = () => (THINK_MIN + Math.random() * (THINK_MAX - THINK_MIN)) * 1000;

export default async function () {
  const me = sessions[(exec.vu.idInTest - 1) % sessions.length];
  const state = { task: null };

  // Realtime ticket, then the socket (Engine.IO v4 framing, Socket.IO default namespace).
  const t = await call(me, "realtime_ticket", "POST", "/api/proxy/realtime/ticket");
  const ticket = t.status < 300 ? t.json("ticket") : null;
  if (!ticket) {
    wsFail.add(1);
    return;
  }
  const started = Date.now();
  const ws = new WebSocket(`wss://${HOST}/socket.io/?EIO=4&transport=websocket`, null, { headers: { origin: BASE } });
  let timer = null;
  let heartbeat = null;
  let connected = false;

  const loop = () => {
    timer = setTimeout(async () => {
      try {
        await act(me, state);
      } catch {
        actionOk.add(false, { name: "exception" });
      }
      loop();
    }, think());
  };

  ws.onmessage = (e) => {
    const m = e.data;
    if (m === "2") return ws.send("3");
    if (m[0] === "0") return ws.send(`40${JSON.stringify({ ticket })}`);
    if (m.startsWith("40")) {
      connected = true;
      wsOpen.add(1);
      wsConnect.add(Date.now() - started);
      heartbeat = setInterval(() => ws.send('42["heartbeat"]'), 30_000);
      // First action soon after arriving, spread out so a ramp doesn't fire in lockstep.
      timer = setTimeout(loop, Math.random() * THINK_MAX * 1000);
      return;
    }
    if (m.startsWith("44")) {
      wsFail.add(1);
      return ws.close();
    }
    if (m.startsWith('42["message.created"')) {
      const at = m.match(/lt:(\d+):(\d+)/);
      if (at && Number(at[2]) !== exec.vu.idInTest) delivery.add(Date.now() - Number(at[1]), { phase: phase() });
    }
  };
  ws.onerror = () => {
    if (!connected) wsFail.add(1);
  };
  ws.onclose = () => {
    clearTimeout(timer);
    if (heartbeat) clearInterval(heartbeat);
  };
}

export function handleSummary(data) {
  const out = JSON.stringify(
    { stages: __ENV.STAGES, think: [THINK_MIN, THINK_MAX], metrics: Object.fromEntries(Object.entries(data.metrics).map(([k, v]) => [k, v.values])) },
    null,
    1,
  );
  return __ENV.SUMMARY ? { [__ENV.SUMMARY]: out, stdout: "" } : { stdout: out };
}
