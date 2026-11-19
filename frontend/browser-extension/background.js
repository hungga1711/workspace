// workspace AI Insights: the background worker queues what the pages captured and sends it in small batches
// to the company's workspace (POST <server>/api/ai-monitor/events, Bearer <connection code>).
// Nothing is sent until the person has pasted the connection code from workspace › Của tôi › AI.

const QUEUE_KEY = "queue";
const MAX_QUEUE = 500;
const HINT_SCRIPT = "workspace-hint";

async function settings() {
  const s = await chrome.storage.local.get(["server", "token"]);
  return s.server && s.token ? s : null;
}

// Every change to the stored queue goes through this chain, one at a time: a capture that arrives while a batch
// is on its way to the server must not be overwritten by that batch's "sent, remove them" write.
let queueLock = Promise.resolve();
const withQueue = (fn) => {
  const run = queueLock.then(async () => {
    const { [QUEUE_KEY]: q = [] } = await chrome.storage.local.get(QUEUE_KEY);
    const next = await fn(q);
    if (next) await chrome.storage.local.set({ [QUEUE_KEY]: next });
  });
  queueLock = run.catch(() => undefined);
  return run;
};

async function enqueue(event) {
  await withQueue((q) => [...q, event].slice(-MAX_QUEUE));
  flush();
}

let flushing = false;
async function flush(ping = false) {
  if (flushing) return;
  flushing = true;
  try {
    const s = await settings();
    if (!s) return;
    for (;;) {
      const { [QUEUE_KEY]: q = [] } = await chrome.storage.local.get(QUEUE_KEY);
      // Nothing queued: only a ping (on connect / startup) asks, to check the code and learn the policy.
      if (!q.length && !ping) return;
      ping = false;
      const batch = q.slice(0, 20);
      const res = await fetch(`${s.server.replace(/\/$/, "")}/api/ai-monitor/events`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${s.token}` },
        body: JSON.stringify({ events: batch }),
      }).catch(() => null);
      if (!res) return; // offline: the queue goes with the next capture or browser start
      if (res.status === 401 || res.status === 404) {
        await chrome.storage.local.set({ status: "disconnected" });
        return;
      }
      // The company switched AI Insights off (Admin › AI): nothing is recorded, and what waited is dropped. The
      // pages show "not recording"; the next browser start or page load asks again.
      if (res.status === 403) {
        await withQueue(() => []);
        await chrome.storage.local.set({ status: "paused", pausedAt: Date.now() });
        return;
      }
      if (!res.ok && res.status !== 400) return;
      const body = await res.json().catch(() => ({}));
      // Every answer carries the policy: whether answers are kept, what to do with sensitive data, the
      // company's own keywords. A 400 (a malformed batch) keeps what we knew and drops the batch.
      const policy = res.ok
        ? {
            captureResponses: !!body.captureResponses,
            sensitiveMode: ["warn", "redact", "block"].includes(body.sensitiveMode) ? body.sensitiveMode : "warn",
            keywords: Array.isArray(body.keywords) ? body.keywords.filter((k) => typeof k === "string").slice(0, 500) : [],
          }
        : {};
      // Remove exactly what was sent (the queue only grows at its end; MAX_QUEUE may have dropped the oldest).
      const sent = new Set(batch.map((e) => JSON.stringify(e)));
      await withQueue((now) => {
        let i = 0;
        while (i < batch.length && i < now.length && sent.has(JSON.stringify(now[i]))) i++;
        return now.slice(i);
      });
      await chrome.storage.local.set({ status: "connected", lastSentAt: new Date().toISOString(), ...policy });
    }
  } finally {
    flushing = false;
  }
}

/** "http://localhost:3000" → "http://localhost/*" (match patterns ignore the port). */
const originPattern = (server) => {
  const u = new URL(server);
  return `${u.protocol}//${u.hostname}/*`;
};

/**
 * The hint script runs on the company's workspace only, and only when the person allowed it (options page,
 * which asks the browser for that one origin). It reads the id of the task opened last, nothing else.
 */
async function syncHintScript() {
  const { server, token, hintsEnabled } = await chrome.storage.local.get(["server", "token", "hintsEnabled"]);
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [HINT_SCRIPT] }).catch(() => []);
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [HINT_SCRIPT] }).catch(() => undefined);
  if (!server || !token || !hintsEnabled) return;
  const origin = originPattern(server);
  if (!(await chrome.permissions.contains({ origins: [origin] }))) return;
  await chrome.scripting.registerContentScripts([{ id: HINT_SCRIPT, matches: [origin], js: ["hint.js"], runAt: "document_idle" }]).catch(() => undefined);
}

chrome.storage.onChanged.addListener((c, area) => {
  if (area === "local" && (c.server || c.token || c.hintsEnabled)) syncHintScript();
});

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === "capture" && msg.event) {
    enqueue(msg.event).then(() => reply({ ok: true }));
    return true;
  }
  if (msg?.type === "state") {
    chrome.storage.local.get(["server", "token", "status", "pausedAt", "captureResponses", "sensitiveMode", "keywords"]).then((s) => {
      // Paused by the company: ask again now and then, so recording resumes when it is switched back on.
      if (s.status === "paused" && Date.now() - (s.pausedAt ?? 0) > 10 * 60_000) flush(true);
      reply({
        connected: !!(s.server && s.token) && s.status !== "paused" && s.status !== "disconnected",
        captureResponses: !!s.captureResponses,
        sensitiveMode: s.sensitiveMode ?? "warn",
        keywords: s.keywords ?? [],
        server: s.server ?? null,
      });
    });
    return true;
  }
  if (msg?.type === "flush") {
    flush(true).then(() => chrome.storage.local.get(["status"]).then((st) => reply({ ok: st.status !== "disconnected" })));
    return true;
  }
  return false;
});

chrome.runtime.onStartup.addListener(() => {
  flush(true);
  syncHintScript();
});
chrome.runtime.onInstalled.addListener((d) => {
  syncHintScript();
  if (d.reason === "install") chrome.runtime.openOptionsPage();
});
