/**
 * Loaded into `next start` while build.mjs renders the demo: the clock stands at the moment the fixtures were
 * recorded (so "today", "2 hours ago" and the week's numbers agree with them), and the session store answers with one
 * signed-in person instead of reaching Postgres.
 */
const Module = process.getBuiltinModule("node:module");
const demo = JSON.parse(process.env.LIVE_DEMO ?? "{}");

const RealDate = Date;
const offset = RealDate.parse(demo.recordedAt) - RealDate.now();
// Own statics: Next wraps Date by copying its own properties.
globalThis.Date = class Date extends RealDate {
  constructor(...a) {
    if (a.length) super(...a);
    else super(RealDate.now() + offset);
  }
  static UTC = RealDate.UTC;
  static parse = RealDate.parse;
  static now() {
    return RealDate.now() + offset;
  }
};

const session = { accessToken: "demo", refreshToken: "demo", expiresAt: 8e15, userId: demo.user.id, name: demo.user.name, givenName: demo.user.givenName, email: demo.user.email };
// On the class itself, which `import` and `require` share: newer Node does not call a patched loader for an import.
const pg = Module.createRequire(`${process.cwd()}/package.json`)("pg");
pg.Pool.prototype.query = async (sql) =>
  /SELECT data FROM sessions/.test(typeof sql === "string" ? sql : sql?.text) ? { rows: [{ data: session }], rowCount: 1 } : { rows: [], rowCount: 0 };
pg.Pool.prototype.connect = async () => ({ query: pg.Pool.prototype.query, release() {} });
