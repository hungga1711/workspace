// The connection code from workspace is "<server>#<token>", e.g. https://workspace.example.com#aim_…
const $ = (id) => document.getElementById(id);
const msg = (key, ...subs) => chrome.i18n.getMessage(key, subs);
// Texts come from _locales (the browser's language: vi or en), so the page holds no language of its own.
document.documentElement.lang = chrome.i18n.getUILanguage();
// The list of sites comes from the registry (sites.js), so it never falls behind the code.
const SITE_NAMES = [...new Set(WORKSPACE_AI_SITES.map((s) => s.name))].join(", ");
for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = el.dataset.i18n === "optNote1" ? msg("optNote1", SITE_NAMES) : msg(el.dataset.i18n);
for (const el of document.querySelectorAll("[data-i18n-placeholder]")) el.placeholder = msg(el.dataset.i18nPlaceholder);
const show = (text, ok) => {
  $("status").textContent = text;
  $("status").className = `status ${ok ? "ok" : "err"}`;
};

async function refresh() {
  const s = await chrome.storage.local.get(["server", "token", "status", "lastSentAt", "hintsEnabled"]);
  const on = !!(s.server && s.token);
  $("hint-row").hidden = !on;
  $("hint-note").hidden = !on;
  $("hints").checked = on && !!s.hintsEnabled;
  if (s.server && s.token) {
    show(
      s.status === "disconnected"
        ? msg("statusExpired")
        : s.status === "paused"
          ? msg("statusPaused")
          : msg("statusConnected", new URL(s.server).host) + (s.lastSentAt ? msg("statusLastSent", new Date(s.lastSentAt).toLocaleString(chrome.i18n.getUILanguage())) : ""),
      s.status !== "disconnected" && s.status !== "paused",
    );
  } else show(msg("statusNone"), false);
}

$("save").addEventListener("click", async () => {
  const raw = $("code").value.trim();
  const m = /^(https?:\/\/[^#\s]+)#(aim_[A-Za-z0-9_-]{20,64})$/.exec(raw);
  if (!m) return show(msg("statusBadCode"), false);
  const server = m[1].replace(/\/$/, "");
  await chrome.storage.local.set({ server, token: m[2], status: "connected" });
  $("code").value = "";
  // Check the code with the server right away (and learn whether answers are kept).
  const r = await chrome.runtime.sendMessage({ type: "flush" }).catch(() => null);
  if (r && !r.ok) return show(msg("statusExpired"), false);
  if ((await chrome.storage.local.get("status")).status === "paused") return show(msg("statusPaused"), false);
  await refresh();
});

$("off").addEventListener("click", async () => {
  await chrome.storage.local.remove(["server", "token", "status", "pausedAt", "queue", "hintsEnabled", "lastTaskSeen", "sensitiveMode", "keywords", "captureResponses"]);
  await refresh();
});

// The task hint: reading the company's workspace page needs the browser's permission for that one origin,
// asked here (it needs a click), and given back when the box is cleared.
$("hints").addEventListener("change", async (e) => {
  const { server } = await chrome.storage.local.get("server");
  if (!server) return;
  const u = new URL(server);
  const origins = [u.protocol + "//" + u.hostname + "/*"];
  if (e.target.checked) {
    const granted = await chrome.permissions.request({ origins }).catch(() => false);
    if (!granted) {
      e.target.checked = false;
      return show(msg("optHintDenied"), false);
    }
    await chrome.storage.local.set({ hintsEnabled: true });
  } else {
    await chrome.storage.local.remove(["hintsEnabled", "lastTaskSeen"]);
    await chrome.permissions.remove({ origins }).catch(() => false);
  }
});

refresh();
