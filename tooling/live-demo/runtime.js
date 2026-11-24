/**
 * The live demo's stand-in for the server, run in the browser before the app (build.mjs prepends `D`: the manifest).
 * Reads answer from files recorded at build time; a write is refused with a message. The clock stands at the recording.
 */
(() => {
  const BASE = D.base;
  const FILES = `${BASE}/_demo`;
  const isApp = (p) => /^\/(app|admin)(\/|$)/.test(p);
  const strip = (p) => (p === BASE || p.startsWith(`${BASE}/`) ? p.slice(BASE.length) || "/" : p);
  const withBase = (u) => (typeof u === "string" && /^\/(?!\/)/.test(u) && u !== BASE && !u.startsWith(`${BASE}/`) ? BASE + u : u);
  const keyOf = (u) => {
    const q = new URLSearchParams(u.search);
    q.delete("_rsc");
    q.sort();
    return strip(u.pathname).replace(/(.)\/$/, "$1") + (q.size ? `?${q}` : "");
  };

  // ── a page opened with a query string: static hosting ignores it, so load that variant's document, which puts the
  // address back before the app starts ──
  const variant = /\/_demo\/html\/(\w+)\.html$/.exec(location.pathname)?.[1];
  if (variant) {
    const key = Object.keys(D.pages).find((k) => D.pages[k] === variant);
    history.replaceState(null, "", BASE + key + location.hash);
  } else if (location.search) {
    const key = keyOf(location);
    if (key in D.pages) {
      location.replace(`${FILES}/html/${D.pages[key]}.html${location.hash}`);
      return;
    }
  }

  const Real = Date;
  const offset = D.recordedAt - Real.now();
  window.Date = class Date extends Real {
    constructor(...a) {
      if (a.length) super(...a);
      else super(Real.now() + offset);
    }
    static now() {
      return Real.now() + offset;
    }
  };

  // The server normally writes the chosen theme into the page; here the saved choice is put back before it paints.
  const theme = (document.cookie.match(/wos_theme=(light|dark|system)/) || [])[1];
  if (theme) {
    const el = document.documentElement;
    el.dataset.themePref = theme;
    el.dataset.theme = theme === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : theme;
  }

  const LOCALE = (document.cookie.match(/wos_locale=(\w+)/) || [])[1] || "en";
  const TEXT = {
    en: {
      locked: "This is a UI demo with sample data: changes are not saved.",
      missing: "This screen is not part of the demo.",
      bar: "Live demo: UI only, with sample data. You can look around, but nothing is saved or sent.",
      short: "Live demo: UI only, nothing is saved.",
      get: "Install your own",
      noAnswer:
        "**This is a UI demo, so no AI is connected here.** In your own workspace the AI answers from your tasks, documents, meetings and chat.\n\nThese questions have a sample answer:\n\n",
    },
    vi: {
      locked: "Đây là bản demo giao diện với dữ liệu mẫu: thay đổi không được lưu.",
      missing: "Màn hình này không có trong bản demo.",
      bar: "Live demo: chỉ có giao diện với dữ liệu mẫu. Bạn cứ xem thoải mái, mọi thao tác đều không được lưu.",
      short: "Live demo: chỉ xem giao diện, không lưu.",
      get: "Cài đặt",
      noAnswer:
        "**Đây là bản demo giao diện nên không có AI thật.** Trong workspace của bạn, AI trả lời từ task, tài liệu, cuộc họp và chat của công ty.\n\nCác câu sau có câu trả lời mẫu:\n\n",
    },
  };
  const T = TEXT[LOCALE] || TEXT.en;

  // ── a small notice and a label, outside React's tree ──
  let noticeEl, noticeTimer;
  const style = document.createElement("style");
  // The bar takes its own room: the app's full-height screens end above it (build.mjs rewrites 100dvh), and what is
  // pinned to the top of the window is pinned under it.
  style.textContent =
    ":root{--demo-bar:36px}body{padding-top:var(--demo-bar)}" +
    ".fixed.inset-0,.fixed.inset-y-0,.fixed.top-0{top:var(--demo-bar)}" +
    ".sticky.top-0.z-20,.md\\:sticky.md\\:top-0{top:var(--demo-bar)}" +
    [
      ["top-14", 56],
      ["top-16", 64],
      ["top-32", 128],
      ["top-\\[68px\\]", 68],
    ]
      .map(([c, n]) => `.sticky.${c}{top:calc(${n}px + var(--demo-bar))}`)
      .join("") +
    "@media(min-width:768px){.sticky.md\\:top-12{top:calc(48px + var(--demo-bar))}}" +
    "demo-bar,demo-notice{position:fixed;z-index:2147483000;font:500 13px/1.4 var(--font-geist-sans,system-ui),sans-serif;color:#fafafa;background:#171717}" +
    "demo-bar{inset:0 0 auto;height:36px;box-sizing:border-box;display:flex;align-items:center;justify-content:center;gap:12px;padding:0 16px;white-space:nowrap}" +
    "demo-bar i{width:8px;height:8px;border-radius:9px;background:#fbbf24;flex:none}demo-bar span{overflow:hidden;text-overflow:ellipsis}demo-bar .s{display:none}" +
    "demo-bar a{color:#171717;background:#fff;border-radius:999px;padding:2px 12px;text-decoration:none;font-size:12px}demo-bar a:focus-visible{outline:2px solid #60a5fa;outline-offset:2px}" +
    "demo-notice{left:50%;bottom:64px;transform:translateX(-50%);padding:9px 16px;max-width:calc(100vw - 32px);text-align:center;border:1px solid #404040;border-radius:999px;box-shadow:0 4px 16px #0003}" +
    "@media(max-width:767px){demo-bar{font-size:12px;padding:0 12px}demo-bar .l{display:none}demo-bar .s{display:block}demo-notice{bottom:124px;border-radius:14px;width:max-content}}" +
    "@media print{:root{--demo-bar:0px}demo-bar,demo-notice{display:none}}";
  document.documentElement.append(style);
  const notice = (text) => {
    if (!noticeEl) {
      noticeEl = document.createElement("demo-notice");
      noticeEl.setAttribute("role", "status");
      document.documentElement.append(noticeEl);
    }
    noticeEl.textContent = text;
    noticeEl.hidden = false;
    noticeEl.style.display = "block";
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => (noticeEl.style.display = "none"), 4000);
  };
  // Outside <body>, which belongs to React; from the first paint, on every screen, and it cannot be closed.
  const bar = document.createElement("demo-bar");
  bar.setAttribute("role", "note");
  bar.innerHTML = `<i></i><span class="l">${T.bar}</span><span class="s">${T.short}</span><a href="/docs/quick-start">${T.get}</a>`;
  document.documentElement.append(bar);

  // ── requests ──
  const realFetch = window.fetch.bind(window);
  const json = (body, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const locked = () => {
    notice(T.locked);
    return json({ error: "demo_locked", message: T.locked }, 403);
  };
  // What the app sends by itself (presence, read marks, metrics): accepted silently.
  const SILENT = /\/api\/(rum|client-errors)$|\/api\/proxy\/(realtime\/ticket|.*\/(read|seen|presence|heartbeat|typing|viewed|views|open|opened)$)/;
  // ── the company's AI: recorded answers, typed as the real one types them ──
  const wordsOf = (t) => new Set(t.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []);
  const answerTo = (q) => {
    const mine = wordsOf(q);
    let best = 0;
    let hit = null;
    for (const x of D.ask) {
      const theirs = wordsOf(x.q);
      const both = [...mine].filter((w) => theirs.has(w)).length;
      const score = both / (mine.size + theirs.size - both || 1);
      if (score > best) [best, hit] = [score, x];
    }
    return best >= 0.5 ? hit : null;
  };
  // A conversation that only exists in this page: the app may put its address in, but there is nothing to load.
  const LOCAL = "demo";
  const SUGGEST = ["What needs my attention today?", "Who on my team is overloaded, and who has room?", "Write this week's progress report for my team"];
  function answer(body) {
    const q = String(body.content || "");
    const hit = answerTo(q);
    const a = hit ? hit.a : { content: T.noAnswer + SUGGEST.map((s) => `- ${s}`).join("\n"), followUps: SUGGEST };
    // A question of its own, not the first of a recorded conversation, stays in the page.
    const first = hit && !body.conversationId && D.ask.find((x) => x.id === hit.id) === hit;
    const done = {
      conversationId: body.conversationId || (first ? hit.id : LOCAL),
      answer: a.content,
      model: "qwen3:8b",
      sources: a.sources || [],
      blocks: a.blocks || [],
      steps: a.steps || [],
      followUps: a.followUps || [],
    };
    const enc = new TextEncoder();
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const stream = new window.ReadableStream({
      async start(c) {
        const send = (event, data) => c.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        try {
          send("start", { id: "demo" });
          for (const s of done.steps) {
            send("step", { ...s, state: "running" });
            await wait(450);
            send("step", { ...s, state: "done" });
          }
          await wait(300);
          for (const piece of a.content.match(/[\s\S]{1,24}/g) || []) {
            send("delta", { t: piece });
            await wait(22);
          }
          send("done", done);
          c.close();
        } catch {
          /* the page was left or the answer stopped */
        }
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  }
  function propose(body) {
    const title =
      String(body.text || "")
        .replace(/^\s*(create|make|add)\s+(a\s+)?task[^:]*:\s*/i, "")
        .trim() || "New task";
    return {
      title: title[0].toUpperCase() + title.slice(1),
      description: `${title}\n\n## Done when\n- [ ] It is agreed with the people it touches\n- [ ] The result is written on this task`,
      workflowId: null,
      projectId: D.proposal.projects[0]?.id ?? null,
      ...D.proposal,
    };
  }
  const byPath = {};
  for (const k of Object.keys(D.api)) (byPath[k.split("?")[0]] ??= []).push(k);
  async function apiRead(u) {
    const path = strip(u.pathname).replace("/api/proxy/", "/api/");
    if (path === "/api/chat/search") {
      const words = (u.searchParams.get("q") || "").toLowerCase().split(/\s+/).filter(Boolean);
      const types = u.searchParams.get("types")?.split(",");
      const inChannel = u.searchParams.get("channelId");
      const hits = D.search.filter(
        (h) =>
          (!types || types.includes(h.entity_type)) &&
          (!inChannel || JSON.stringify(h).includes(inChannel)) &&
          words.every((w) => `${h.title} ${h.snippet || ""} ${h.entity_id}`.toLowerCase().includes(w)),
      );
      return json({ hits: hits.slice(0, 20) });
    }
    const raw = path + u.search;
    let k = [raw, decodeURIComponent(raw)].find((x) => x in D.api);
    // Another query on a recorded address: the nearest answer, but never page one again as "the next page".
    if (!k && !/[?&](cursor|before|after|offset|page)=/.test(u.search)) {
      const want = new Set(u.search.slice(1).split("&"));
      let best = -1;
      for (const c of byPath[path] || []) {
        const n = (c.split("?")[1] || "").split("&").filter((x) => want.has(x)).length;
        if (n > best) [best, k] = [n, c];
      }
    }
    if (!k && /\/(files|drive)\/.*(download|url|content)/.test(path)) return locked();
    if (!k) return json({ error: "not_found" }, 404);
    const [id, status, type, ext] = D.api[k];
    const r = await realFetch(`${FILES}/api/${id}.${ext || "json"}`);
    if (!r.ok) return json({ error: "unreachable" }, 503);
    return new Response(status === 204 ? null : await r.arrayBuffer(), { status, headers: { "content-type": type || "application/json" } });
  }
  const rscFrom = async (key, dir, u, redirected) => {
    const r = await realFetch(`${FILES}/${dir}/${D[dir][key]}.txt`);
    const res = new Response(r.body, { status: r.status, headers: { "content-type": "text/x-component", vary: "RSC, Next-Router-State-Tree, Next-Router-Prefetch, Next-Url" } });
    Object.defineProperties(res, { url: { value: u.href }, redirected: { value: !!redirected } });
    return res;
  };
  // Ask, opened with a question: the recorded screen for "__question__", with the visitor's in its place.
  async function asked(question, u) {
    const key = `/app/ai/ask?q=__question__${u.searchParams.get("send") === "1" ? "&send=1" : ""}`;
    if (!(key in D.rsc) || strip(location.pathname).split("/")[1] !== "app") return leave(u);
    const r = await realFetch(`${FILES}/rsc/${D.rsc[key]}.txt`);
    const text = (await r.text()).replaceAll("__question__", JSON.stringify(question.slice(0, 2000)).slice(1, -1));
    const res = new Response(text, { headers: { "content-type": "text/x-component", vary: "RSC, Next-Router-State-Tree, Next-Router-Prefetch, Next-Url" } });
    Object.defineProperty(res, "url", { value: u.href });
    return res;
  }
  const leave = (u) => {
    // Not a flight answer: the router opens the address as a full page load.
    const res = new Response("", { headers: { "content-type": "text/html" } });
    Object.defineProperty(res, "url", { value: u.href });
    return res;
  };
  function screen(u, headers) {
    let key = keyOf(u);
    // A fresh answer lives in the page: its address has no screen to load, and loading one would drop it.
    if (u.pathname.endsWith("/app/ai/ask") && u.searchParams.get("c") === LOCAL) return new Promise(() => {});
    const question = u.pathname.endsWith("/app/ai/ask") && !(key in D.pages) && u.searchParams.get("q");
    if (question) return asked(question, u);
    const path = key.split("?")[0];
    const area = path.split("/")[1];
    const from = strip(location.pathname).split("/")[1];
    if (!(key in D.pages)) {
      // A filter the recording lacks: say so rather than show another list under its address.
      if (key !== path && /[?&](view|tab|scope|project|folder|section|label|days|period|when|year|month)=/.test(key) && !headers.get("next-router-prefetch")) notice(T.missing);
      key = path;
    }
    if (key in D.redirects) {
      const to = new URL(BASE + D.redirects[key], location.origin);
      return to.pathname.split("/")[2] === from ? screenFile(keyOf(to), to, true) : leave(to);
    }
    if (!(key in D.pages)) {
      if (!headers.get("next-router-prefetch")) notice(T.missing);
      return screenFile(keyOf(location) in D.rsc ? keyOf(location) : strip(location.pathname), new URL(location.href), true);
    }
    if (area !== from) return leave(u);
    if (headers.get("next-url") && path in D.peek && path !== strip(location.pathname)) return rscFrom(path, "peek", u);
    return screenFile(key, u);
  }
  const screenFile = (key, u, redirected) => (key in D.rsc ? rscFrom(key, "rsc", u, redirected) : leave(u));

  window.fetch = async (input, init) => {
    const req = input instanceof Request ? input : null;
    const u = new URL(req ? req.url : String(input), location.href);
    const method = (init?.method || req?.method || "GET").toUpperCase();
    const headers = new Headers(init?.headers || req?.headers);
    if (u.origin !== location.origin) return method === "GET" ? realFetch(input, init) : locked();
    const path = strip(u.pathname);
    if (path.startsWith("/api/proxy/") || path.startsWith("/api/")) {
      if (method === "GET") return apiRead(u);
      const sent = typeof init?.body === "string" ? JSON.parse(init.body || "{}") : {};
      if (/\/ai\/assistant\/(messages|conversations\/\w+\/regenerate)\/stream$/.test(path)) {
        const conv = /conversations\/(\w+)\//.exec(path)?.[1];
        return answer(conv ? { conversationId: conv, content: D.ask.filter((x) => x.id === conv).at(-1)?.q } : sent);
      }
      if (path.endsWith("/ai/tasks/propose")) return json(propose(sent));
      const p = D.post[`${method} ${path.replace("/api/proxy/", "/api/")}${u.search}`];
      if (p) return json(JSON.parse(p.b || "{}"), p.s);
      return SILENT.test(path) ? json({}) : locked();
    }
    if (method !== "GET") return locked();
    if (headers.get("rsc")) return screen(u, headers);
    if (path.startsWith("/files/")) return apiRead(new URL(`/api${path}`, location.origin));
    return realFetch(req ? input : new URL(withBase(u.pathname) + u.search, u).href, init);
  };
  navigator.sendBeacon = () => true;
  // No server pushes: a socket that never opens (the app stays quietly "connected").
  window.WebSocket = class extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = 0;
    binaryType = "blob";
    bufferedAmount = 0;
    send() {}
    close() {
      this.readyState = 3;
    }
  };
  if (navigator.serviceWorker) navigator.serviceWorker.register = () => Promise.reject(new Error("demo"));

  // ── addresses written without the base path ──
  const setAttribute = Element.prototype.setAttribute;
  const assets = /^\/(reactions|excalidraw|downloads|api|files)\//;
  const asset = (v) => {
    if (typeof v !== "string" || !assets.test(v)) return v;
    const k = v.replace("/api/proxy/", "/api/");
    if (k in D.api) return `${FILES}/api/${D.api[k][0]}.${D.api[k][3] || "json"}`;
    return BASE + v;
  };
  Element.prototype.setAttribute = function (n, v) {
    return setAttribute.call(this, n, n === "src" || (n === "href" && this.localName === "link") ? asset(v) : v);
  };
  // React sets an image's src twice: the attribute, then the property once it is in the page.
  const src = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
  const setSrc = function (v) {
    src.set.call(this, asset(v));
  };
  Object.defineProperty(HTMLImageElement.prototype, "src", { ...src, set: setSrc });
  let exc;
  const setExc = (v) => {
    exc = withBase(v);
  };
  Object.defineProperty(window, "EXCALIDRAW_ASSET_PATH", { get: () => exc, set: setExc, configurable: true });

  // ── links and forms that would leave the demo ──
  addEventListener(
    "click",
    (e) => {
      const a = e.target?.closest?.("a[href]");
      if (!a || a.origin !== location.origin || a.closest("demo-bar")) return;
      const path = strip(a.pathname);
      if (path === "/" || a.getAttribute("href").startsWith("#")) return;
      const key = keyOf(a);
      const known = isApp(path) && (path === "/app/ai/ask" || key in D.pages || path in D.pages || key in D.redirects || path in D.redirects);
      if (!known && !a.hasAttribute("download")) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return notice(T.missing);
      }
      if (a.hasAttribute("download") && !known && !path.startsWith("/downloads/")) {
        e.preventDefault();
        return notice(T.locked);
      }
      if (!a.pathname.startsWith(`${BASE}/`)) a.setAttribute("href", BASE + path + a.search + a.hash);
    },
    true,
  );
  addEventListener(
    "submit",
    (e) => {
      const f = e.target;
      const action = f.getAttribute?.("action") || "";
      if (!action.startsWith("/")) return;
      e.preventDefault();
      if (/\/auth\/logout/.test(action)) location.assign("/");
      else notice(T.locked);
    },
    true,
  );
  const open = window.open.bind(window);
  window.open = (url, ...rest) => {
    const p = url && strip(new URL(url, location.href).pathname);
    if (!url || url === "about:blank" || (new URL(url, location.href).origin === location.origin && !isApp(p))) {
      notice(T.locked);
      return null;
    }
    return open(withBase(url), ...rest);
  };
  // location.href = "/app/…/export" and the like, where the browser lets us see it.
  window.navigation?.addEventListener("navigate", (e) => {
    if (!e.cancelable || e.hashChange || e.downloadRequest !== null) return;
    const u = new URL(e.destination.url);
    if (u.origin !== location.origin || u.pathname === BASE || u.pathname.startsWith(`${BASE}/`)) return;
    const p = u.pathname;
    if (!/^\/(app|admin|files|meet|login|setup-2fa|change-password|api)(\/|$)/.test(p)) return;
    e.preventDefault();
    if (keyOf(u) in D.pages || p in D.pages) location.assign(BASE + p + u.search);
    else notice(T.locked);
  });
})();
