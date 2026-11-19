// demo-seed, step 1: first-run setup of the demo workspace through the gateway (the same call /setup makes), with
// AI Insights on. Does nothing when the workspace exists already.
//
// DEMO_LOCALE (`en` default, `vi`) is the workspace language: the UI visitors land in (they can switch in the menu)
// (seed-demo.mjs seeds its company in English either way).

const GW = process.env.GATEWAY_URL ?? "http://app:4000";
const LOCALE = process.env.DEMO_LOCALE === "vi" ? "vi" : "en";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (let i = 0; ; i++) {
  const r = await fetch(`${GW}/api/setup`).catch(() => null);
  if (r?.ok) {
    const s = await r.json();
    if (s.setUp) {
      console.log("demo: workspace exists");
      process.exit(0);
    }
    break;
  }
  if (i > 60) throw new Error("gateway did not answer /api/setup");
  await sleep(2000);
}

const res = await fetch(`${GW}/api/signup`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    companyName: process.env.DEMO_COMPANY || (LOCALE === "en" ? "Sunrise Software (demo)" : "Công ty Ánh Dương (demo)"),
    ownerEmail: process.env.SEED_OWNER_EMAIL ?? "admin@example.com",
    ownerName: "Nguyễn Hải An",
    password: process.env.SEED_OWNER_PASSWORD,
    teamType: "product",
    locale: LOCALE,
    timezone: LOCALE === "en" ? "UTC" : "Asia/Ho_Chi_Minh",
    setupToken: process.env.SETUP_TOKEN,
    aiAssistant: false,
    aiMonitoring: true,
  }),
});
// 409: someone (a previous run) finished setup already; the seed checks the rest.
if (!res.ok && res.status !== 409) throw new Error(`setup failed: ${res.status} ${await res.text()}`);
console.log(`demo: workspace created (${LOCALE})`);
