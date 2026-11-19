import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

/**
 * The service worker's notifications (public/sw.js), run with a stand-in `self`: what a push shows, and what a press
 * on a notification or on one of its buttons does. A button acts with its token and the page's session; anything but
 * a clear yes opens the app instead.
 */
type Shown = { title: string; options: { body?: string; tag?: string; data?: Record<string, unknown>; actions?: { action: string; title: string }[] } };
function worker(fetchImpl: (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>) {
  const handlers: Record<string, (e: unknown) => void> = {};
  const shown: Shown[] = [];
  const opened: string[] = [];
  const fetched: { url: string; init: RequestInit }[] = [];
  const self = {
    location: { origin: "https://app.example.com" },
    addEventListener: (type: string, fn: (e: unknown) => void) => (handlers[type] = fn),
    registration: { showNotification: async (title: string, options: Shown["options"]) => void shown.push({ title, options }) },
    clients: { matchAll: async () => [], openWindow: async (url: string) => void opened.push(url), claim: async () => undefined },
    skipWaiting: async () => undefined,
  };
  const fetch = (url: string, init: RequestInit) => {
    fetched.push({ url, init });
    return fetchImpl(url, init);
  };
  vm.runInNewContext(readFileSync(fileURLToPath(new URL("../../public/sw.js", import.meta.url)), "utf8"), { self, fetch, caches: {}, URL, Response, console });
  const fire = async (type: string, event: Record<string, unknown>) => {
    let done: Promise<unknown> = Promise.resolve();
    handlers[type]!({ ...event, waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
  };
  const push = (payload: unknown) => fire("push", { data: { json: () => payload } });
  const click = (n: Shown, action = "") => fire("notificationclick", { action, notification: { close: () => undefined, data: n.options.data } });
  return { shown, opened, fetched, push, click };
}

const APPROVAL = {
  title: "An AI result is waiting for your approval",
  body: "T-035 · Final approval",
  url: "/app/chat/ask/RUN1",
  tag: "/app/chat/ask/RUN1",
  done: "Done. The AI carries on.",
  actions: [
    { action: "quick:0", title: "Approve", token: "wqa_secret" },
    { action: "open", title: "Open", token: "" },
  ],
};

describe("service worker notifications", () => {
  it("a plain push shows no buttons and a tap opens its page, held to this origin", async () => {
    const w = worker(async () => ({ ok: true, status: 200 }));
    await w.push({ title: "Something needs your attention", body: "Open workspace to see it", url: "/app/work/approvals/A1", tag: "x" });
    expect(w.shown[0]!.options.actions).toBeUndefined();
    await w.click(w.shown[0]!);
    expect(w.opened).toEqual(["/app/work/approvals/A1"]);
    expect(w.fetched).toEqual([]);
    await w.push({ title: "x", body: "", url: "https://evil.example/app" });
    await w.click(w.shown[1]!);
    expect(w.opened[1]).toBe("/app/home");
  });

  it("a button acts with its token and the session, without opening the app; the token is never in what is shown", async () => {
    const w = worker(async () => ({ ok: true, status: 200 }));
    await w.push(APPROVAL);
    const n = w.shown[0]!;
    expect(n.options.actions).toEqual([
      { action: "quick:0", title: "Approve" },
      { action: "open", title: "Open" },
    ]);
    expect(JSON.stringify([n.title, n.options.body, n.options.actions, n.options.tag])).not.toContain("wqa_");
    await w.click(n, "quick:0");
    expect(w.fetched).toHaveLength(1);
    expect(w.fetched[0]!.url).toBe("/api/proxy/work/quick-actions/redeem");
    expect(w.fetched[0]!.init).toMatchObject({ method: "POST", credentials: "same-origin", body: JSON.stringify({ token: "wqa_secret" }) });
    expect(w.fetched[0]!.init.headers).toMatchObject({ "x-wos-csrf": "1" });
    expect(w.opened).toEqual([]);
    // It says so, quietly, in place of the notification that asked.
    expect(w.shown[1]).toMatchObject({ options: { body: "Done. The AI carries on.", silent: true } });
  });

  it("the Open button and a tap on the notification open the run; neither spends the token", async () => {
    const w = worker(async () => ({ ok: true, status: 200 }));
    await w.push(APPROVAL);
    await w.click(w.shown[0]!, "open");
    await w.click(w.shown[0]!);
    expect(w.opened).toEqual(["/app/chat/ask/RUN1", "/app/chat/ask/RUN1"]);
    expect(w.fetched).toEqual([]);
  });

  it("a button that cannot act (signed out, already decided, expired, offline) opens the run instead", async () => {
    for (const impl of [async () => ({ ok: false, status: 401 }), async () => ({ ok: false, status: 409 }), async () => Promise.reject(new Error("offline"))]) {
      const w = worker(impl);
      await w.push(APPROVAL);
      await w.click(w.shown[0]!, "quick:0");
      expect(w.opened).toEqual(["/app/chat/ask/RUN1"]);
      expect(w.shown).toHaveLength(1);
    }
  });

  it("shows at most two buttons and ignores malformed ones", async () => {
    const w = worker(async () => ({ ok: true, status: 200 }));
    await w.push({
      ...APPROVAL,
      actions: [
        { action: "quick:0", title: "A", token: "t0" },
        { action: "quick:1", title: "B", token: "t1" },
        { action: "quick:2", title: "C", token: "t2" },
      ],
    });
    expect(w.shown[0]!.options.actions!.map((a) => a.title)).toEqual(["A", "B"]);
    await w.push({ ...APPROVAL, actions: "nope" });
    expect(w.shown[1]!.options.actions).toBeUndefined();
  });
});
