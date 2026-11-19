// Scenario B — idle realtime capacity: each virtual user only holds the app's Socket.IO connection (ticket,
// WebSocket, ping/pong, the 30 s presence heartbeat) and does nothing else. Ramps until connections fail.
//
//   k6 run -e TARGET=5000 -e RAMP=10m -e HOLD=3m tooling/loadtest/idle-ws.js
import http from "k6/http";
import exec from "k6/execution";
import { SharedArray } from "k6/data";
import { Counter, Trend } from "k6/metrics";
import { WebSocket } from "k6/websockets";
import { setInterval, clearInterval } from "k6/timers";

const HOST = __ENV.APP_HOST || "app.wx.test";
const BASE = `https://${HOST}`;
const sessions = new SharedArray("sessions", () => JSON.parse(open("./data/sessions.json")));

export const options = {
  hosts: { [HOST]: __ENV.TARGET_IP || "127.0.0.1" },
  insecureSkipTLSVerify: true,
  // The ticket request's connection is closed afterwards: one TCP port per user on the generator, not two.
  noConnectionReuse: true,
  summaryTrendStats: ["avg", "p(50)", "p(95)", "p(99)", "max", "count"],
  scenarios: {
    idle: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { target: Number(__ENV.TARGET || 2000), duration: __ENV.RAMP || "5m" },
        { target: Number(__ENV.TARGET || 2000), duration: __ENV.HOLD || "3m" },
      ],
      gracefulRampDown: "5s",
      gracefulStop: "5s",
    },
  },
};

const open_ = new Counter("ws_connected");
const closed = new Counter("ws_closed_early");
const failed = new Counter("ws_connect_failed");
const connectMs = new Trend("ws_connect_ms", true);

export default async function () {
  const me = sessions[(exec.vu.idInTest - 1) % sessions.length];
  const started = Date.now();
  const t = await http.asyncRequest("POST", `${BASE}/api/proxy/realtime/ticket`, null, {
    headers: { cookie: me.cookie, origin: BASE, "x-wos-csrf": "1" },
    tags: { name: "realtime_ticket" },
    timeout: "30s",
  });
  const ticket = t.status < 300 ? t.json("ticket") : null;
  if (!ticket) {
    failed.add(1);
    return;
  }
  const ws = new WebSocket(`wss://${HOST}/socket.io/?EIO=4&transport=websocket`, null, { headers: { origin: BASE } });
  let hb = null;
  let up = false;
  ws.onmessage = (e) => {
    const m = e.data;
    if (m === "2") return ws.send("3");
    if (m[0] === "0") return ws.send(`40${JSON.stringify({ ticket })}`);
    if (m.startsWith("40")) {
      up = true;
      open_.add(1);
      connectMs.add(Date.now() - started);
      hb = setInterval(() => ws.send('42["heartbeat"]'), 30_000);
    }
    if (m.startsWith("44")) {
      failed.add(1);
      ws.close();
    }
  };
  ws.onerror = () => (up ? closed.add(1) : failed.add(1));
  ws.onclose = () => {
    if (hb) clearInterval(hb);
  };
}

export function handleSummary(data) {
  const out = JSON.stringify({ target: __ENV.TARGET, metrics: Object.fromEntries(Object.entries(data.metrics).map(([k, v]) => [k, v.values])) }, null, 1);
  return __ENV.SUMMARY ? { [__ENV.SUMMARY]: out, stdout: "" } : { stdout: out };
}
