import { afterEach, describe, expect, it } from "vitest";
import { readLink } from "./workflows/links.js";

/**
 * The page reader behind the assistant's read_webpage (and a workflow's links) is the outside world reaching in: it
 * never opens a private, loopback or link-local address, nor anything but http(s), nor a link with credentials.
 */
describe("reading a linked page safely", () => {
  const before = process.env.WEBHOOK_ALLOW_PRIVATE;
  afterEach(() => {
    if (before === undefined) delete process.env.WEBHOOK_ALLOW_PRIVATE;
    else process.env.WEBHOOK_ALLOW_PRIVATE = before;
  });

  it("refuses local, private and link-local addresses, other schemes and credentials", async () => {
    delete process.env.WEBHOOK_ALLOW_PRIVATE;
    for (const url of [
      "http://127.0.0.1:4000/health",
      "http://10.0.0.5/",
      "http://192.168.1.1/admin",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/",
      "file:///etc/passwd",
      "https://user:pass@example.com/",
    ])
      expect((await readLink(url, true)).ok, url).toBe(false);
    expect(await readLink("http://169.254.169.254/latest/meta-data/", true)).toMatchObject({ ok: false, problem: "refused" });
  });

  it("refuses a name that resolves to this machine", async () => {
    delete process.env.WEBHOOK_ALLOW_PRIVATE;
    const r = await readLink("http://localhost:4000/health", true);
    expect(r).toMatchObject({ ok: false });
    expect(r.ok ? "" : r.problem).toMatch(/refused|unreachable/);
  });
});
