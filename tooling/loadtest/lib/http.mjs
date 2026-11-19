// Minimal HTTPS client for seeding and sign-in: talks to TARGET_IP while presenting the app's host name
// (SNI + Host), keeps connections alive, and carries a per-user cookie jar. No dependencies.
import https from "node:https";

export const APP_HOST = process.env.APP_HOST ?? "app.wx.test";
export const TARGET_IP = process.env.TARGET_IP ?? "127.0.0.1";
export const PORT = Number(process.env.TARGET_PORT ?? 443);
export const ORIGIN = `https://${APP_HOST}`;

const agent = new https.Agent({ keepAlive: true, maxSockets: 64, rejectUnauthorized: process.env.TLS_VERIFY === "1" });

export class Jar {
  cookies = new Map();
  absorb(setCookie) {
    for (const c of setCookie ?? []) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (/max-age=0/i.test(c) || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

/** One request. `body` is an object (JSON), a string, or a Buffer; `type` overrides the content type. */
export function request(method, path, { jar, body, type, headers = {} } = {}) {
  const payload = body === undefined ? null : Buffer.isBuffer(body) ? body : typeof body === "string" ? Buffer.from(body) : Buffer.from(JSON.stringify(body));
  const h = {
    host: APP_HOST,
    origin: ORIGIN,
    "user-agent": "workspace-loadtest",
    ...(payload ? { "content-type": type ?? "application/json", "content-length": payload.length } : {}),
    ...(jar && jar.cookies.size ? { cookie: jar.header() } : {}),
    ...headers,
  };
  return new Promise((resolve, reject) => {
    const req = https.request({ host: TARGET_IP, port: PORT, servername: APP_HOST, method, path, headers: h, agent }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        jar?.absorb(res.headers["set-cookie"]);
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          /* HTML */
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    req.setTimeout(120_000, () => req.destroy(new Error(`timeout ${method} ${path}`)));
    if (payload) req.write(payload);
    req.end();
  });
}

/** The app's own API, as the browser calls it: /api/proxy/<module>/<path> with the CSRF header. */
export async function api(jar, method, path, body) {
  let r = await request(method, `/api/proxy/${path}`, { jar, body, headers: { "x-wos-csrf": "1" } });
  // The seeding owner hits the per-user limit (600 requests a minute) like any user would: wait and retry.
  for (let wait = 5_000; r.status === 429 && wait <= 80_000; wait *= 2) {
    await new Promise((ok) => setTimeout(ok, wait));
    r = await request(method, `/api/proxy/${path}`, { jar, body, headers: { "x-wos-csrf": "1" } });
  }
  if (r.status >= 400) throw Object.assign(new Error(`${method} ${path} → ${r.status} ${r.text.slice(0, 200)}`), { status: r.status });
  return r.json;
}

/** The server action behind the first form on a page: its id, its hidden inputs and its initial state. */
export async function actionForm(path) {
  const r = await request("GET", path);
  const form = r.text.match(/<form[^>]*method="POST"[^>]*>([\s\S]*?)<\/form>/)?.[1] ?? "";
  const fields = {};
  for (const m of form.matchAll(/<input type="hidden" name="([^"]+)"(?: value="([^"]*)")?/g)) fields[m[1]] = (m[2] ?? "").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  if (!fields.$ACTION_KEY) throw new Error(`no server-action form on ${path}`);
  const id = JSON.parse(fields["$ACTION_1:0"]).id;
  const state = JSON.parse(fields["$ACTION_1:1"])[0];
  return { id, fields, state };
}

/**
 * Submits a server-action form the way the app's JavaScript does (Next.js `Next-Action` request, the form's
 * fields prefixed `1_`, the action's previous state in field `0`). Returns the raw response; a successful
 * sign-in answers 303 with `x-action-redirect` and the session cookie.
 */
export async function submitAction(path, form, values, jar) {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ ...form.fields, ...values })) fd.append(`1_${k}`, v);
  fd.append("0", JSON.stringify([form.state, "$K1"]));
  // Let the platform encode the multipart body exactly as browsers do.
  const encoded = new Request("https://encode.invalid/", { method: "POST", body: fd });
  const body = Buffer.from(await encoded.arrayBuffer());
  return request("POST", path, { jar, body, type: encoded.headers.get("content-type"), headers: { "next-action": form.id, accept: "text/x-component" } });
}

let loginForm = null;
/** Password sign-in through the real /login form; returns the cookie jar holding the session. */
export async function login(email, password) {
  loginForm ??= await actionForm("/login");
  const jar = new Jar();
  const r = await submitAction("/login", loginForm, { next: "/app/home", email, password }, jar);
  if (!jar.cookies.has("wos_session") || !jar.cookies.has("wos_ws")) throw new Error(`login ${email} → ${r.status} ${r.text.slice(0, 160)}`);
  return jar;
}

/** Runs `fn` over `items` with at most `n` in flight. */
export async function pool(items, n, fn) {
  let i = 0;
  const out = new Array(items.length);
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k], k);
      }
    }),
  );
  return out;
}
