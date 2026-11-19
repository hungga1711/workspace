// Single-core speed of a machine, to translate the reference results to another CPU. Run it on the server you
// plan to use and on the machine the reference numbers came from, then scale by the ratio (lower ms = faster).
//
//   node tooling/loadtest/cpu-bench.mjs                    # any machine with Node 22
//   docker run --rm --cpus 1 -v "$PWD/tooling/loadtest:/b" workspace:local node /b/cpu-bench.mjs   # inside the image (adds bcrypt)
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const time = (label, rounds, fn) => {
  fn(); // warm up
  const t = process.hrtime.bigint();
  for (let i = 0; i < rounds; i++) fn();
  const ms = Number(process.hrtime.bigint() - t) / 1e6 / rounds;
  console.log(`${label.padEnd(42)} ${ms.toFixed(2)} ms`);
  return ms;
};

// What the web app does most: serialise and parse JSON (a 1 MB list like a big member directory).
const people = Array.from({ length: 6000 }, (_, i) => ({
  userId: `01M4ZT68B${i}`,
  email: `u${i}@example.com`,
  displayName: `Nhân viên ${i}`,
  status: "active",
  departmentId: null,
  isOwner: false,
  roles: ["Employee"],
}));
const json = JSON.stringify(people);
const results = {
  json_stringify_parse_1mb: time("JSON stringify + parse, 1 MB", 50, () => JSON.parse(JSON.stringify(people))),
  sha256_16mb: time("SHA-256 over 16 MB", 20, () =>
    createHash("sha256")
      .update(Buffer.alloc(16 * 1024 * 1024, 7))
      .digest(),
  ),
  regexp_render: time("String building (render-like), 200k parts", 50, () => people.map((p) => `<li data-id="${p.userId}">${p.displayName}</li>`).join("").length + json.length),
};

// Sign-in cost: bcrypt cost 12, as the identity module uses (only where the native module is installed).
try {
  const require = createRequire(import.meta.url);
  const paths = [process.env.BCRYPT_PATH, "/app/node_modules/.pnpm/bcrypt@6.0.0/node_modules/bcrypt", "bcrypt"].filter(Boolean);
  let bcrypt = null;
  for (const p of paths) {
    try {
      bcrypt = require(p);
      break;
    } catch {
      /* next */
    }
  }
  if (bcrypt) {
    const hash = bcrypt.hashSync("Passw0rd!bench", 12);
    results.bcrypt_cost12 = time("bcrypt compare, cost 12", 5, () => bcrypt.compareSync("Passw0rd!bench", hash));
  }
} catch {
  /* no bcrypt here */
}
console.log(JSON.stringify(results));
