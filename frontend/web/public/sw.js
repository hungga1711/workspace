/*
 * workspace service worker.
 * - Push: payloads carry counts or the kind of item only, never message content. For a person who turned quick
 *   actions on, a push about an agent run that waits for them also names the task and carries buttons to act on it.
 * - Offline: hashed build assets (/_next/static, file names with a content hash) are cache-first, since they never
 *   change. Unhashed files (the dev server's chunks) always go to the network, or a browser that once registered
 *   the production worker on the same origin would keep running stale dev code. Page navigations are
 *   network-first and fall back to /offline.html. API calls and page HTML are never cached, so no private data is
 *   stored on the device.
 */
// Bump when SHELL_FILES change: activate drops every other workspace cache.
const VERSION = "v7";
const STATIC = `workspace-static-${VERSION}`;
const SHELL = `workspace-shell-${VERSION}`;
const SHELL_FILES = ["/offline.html", "/pwa-icon/192"];
// A production asset name carries a content hash ("1316.9365f9423b516e64.js", "f3b58ff172dddad9.css").
const HASHED = /(^|[/.-])[0-9a-f]{8,}(\.p)?\.(js|css|woff2?|png|jpg|svg)$/;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll(SHELL_FILES))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("workspace-") && k !== STATIC && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith("/_next/static/") && HASHED.test(url.pathname)) {
    event.respondWith(
      caches.open(STATIC).then(async (c) => {
        const hit = await c.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) c.put(req, res.clone());
        return res;
      }),
    );
    return;
  }

  if (req.mode === "navigate") {
    event.respondWith(fetch(req).catch(() => caches.match("/offline.html", { cacheName: SHELL }).then((r) => r ?? Response.error())));
  }
});

self.addEventListener("push", (event) => {
  let data = { title: "workspace", body: "", url: "/app/home" };
  try {
    if (event.data) data = event.data.json();
  } catch {
    // A payload that is not JSON still shows the generic notification.
  }
  // Buttons, for a person who turned quick actions on: "Approve" on a run that waits for their approval, or the two
  // options of an either/or question. Each holds a token for that one action (kept in the notification's data, never
  // in its text); a button without one ("Open") opens the app like a tap on the notification.
  const quick = Array.isArray(data.actions) ? data.actions.slice(0, 2).filter((a) => a && typeof a.action === "string" && a.title) : [];
  const tokens = {};
  for (const a of quick) if (typeof a.token === "string" && a.token) tokens[a.action] = a.token;
  // One notification per item (tag), so a second push about the same thing replaces the first.
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      data: { url: data.url, tokens, done: data.done, title: data.title },
      tag: data.tag ?? "daily-brief",
      icon: "/pwa-icon/192",
      ...(quick.length ? { actions: quick.map((a) => ({ action: a.action, title: String(a.title).slice(0, 40) })) } : {}),
    }),
  );
});

/** Opens the app at `url` (held to this origin): an open workspace tab when there is one, else a new window. */
function openApp(url) {
  // Resolved, then held to this origin: "/\\evil.example" passes a "/" prefix check but browsers read it as "//evil.example".
  let target = "/app/home";
  try {
    const u = typeof url === "string" ? new URL(url, self.location.origin) : null;
    if (u && u.origin === self.location.origin) target = u.pathname + u.search + u.hash;
  } catch {
    // Not a URL: the home screen.
  }
  return self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    const tab = list.find((c) => new URL(c.url).origin === self.location.origin);
    // navigate() rejects for a tab this worker does not control (e.g. opened before it was installed).
    return tab
      ? tab
          .focus()
          .then((c) => c.navigate(target))
          .catch(() => self.clients.openWindow(target))
      : self.clients.openWindow(target);
  });
}

/**
 * A notification's button was pressed: the action is done without opening the app. The request carries the person's
 * session (same origin) and the button's token, which works once and only for the wait the push was about. Anything
 * but a clear yes (signed out, already decided, expired, offline) opens the app on the run instead, where the person
 * sees how things stand.
 */
function quickAct(token, n) {
  return fetch("/api/proxy/work/quick-actions/redeem", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", "x-wos-csrf": "1" },
    body: JSON.stringify({ token }),
  })
    .then((r) => {
      if (!r.ok) throw new Error(String(r.status));
      // Said in place of the notification that asked, quietly.
      return n.done
        ? self.registration.showNotification(n.title || "workspace", { body: n.done, tag: `done:${n.url}`, icon: "/pwa-icon/192", silent: true, data: { url: n.url } })
        : undefined;
    })
    .catch(() => openApp(n.url));
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const d = event.notification.data ?? {};
  const token = event.action && d.tokens ? d.tokens[event.action] : "";
  event.waitUntil(token ? quickAct(token, d) : openApp(d.url));
});
