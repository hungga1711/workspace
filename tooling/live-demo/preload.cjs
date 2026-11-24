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
class Pool {
  on() {}
  async query(sql) {
    return /SELECT data FROM sessions/.test(sql) ? { rows: [{ data: session }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
}
const load = Module._load;
Module._load = function (id, ...rest) {
  return id === "pg" ? { default: { Pool }, Pool } : load.call(this, id, ...rest);
};
