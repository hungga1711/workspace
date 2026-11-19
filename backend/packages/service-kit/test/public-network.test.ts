import { describe, expect, it } from "vitest";
import { request } from "node:https";
import { checkPublicUrl, isPrivateAddress, publicHttpsAgent, requestPublic } from "../src/public-network.js";

describe("outbound requests to configured URLs", () => {
  it("treats this network's and special-purpose addresses as private", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255"])
      expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["198.18.0.1", "192.0.2.1", "198.51.100.1", "203.0.113.1", "::", "::1", "fd00::1", "fe80::1", "ff02::1", "64:ff9b::a00:1", "2001:db8::1"])
      expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["::ffff:127.0.0.1", "::ffff:7f00:1"]) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it("refuses http, credentials and private hosts before calling", async () => {
    expect(await checkPublicUrl("http://example.com/x", false)).toBe("URL must use https");
    expect(await checkPublicUrl("https://user:pw@example.com/x", false)).toBe("URL must not contain credentials");
    expect(await checkPublicUrl("https://127.0.0.1/x", false)).toBe("URL resolves to a private address");
    expect(await checkPublicUrl("http://127.0.0.1/x", true)).toBeNull();
  });

  it("refuses a private address when connecting, whatever an earlier check saw", async () => {
    await expect(requestPublic("https://localhost:9/x")).rejects.toThrow("private address");
  });

  it("refuses a host written as a private IP, which skips DNS lookup altogether", async () => {
    for (const url of ["https://127.0.0.1:9/x", "https://169.254.169.254/latest", "https://[::1]:9/x", "https://[::ffff:127.0.0.1]:9/x"])
      await expect(requestPublic(url), url).rejects.toThrow("private address");
  });

  it("the shared agent refuses private IP hosts too (remote key sets use it)", async () => {
    const err = await new Promise<Error>((resolve) => {
      const req = request("https://169.254.169.254/keys", { agent: publicHttpsAgent }, () => resolve(new Error("connected")));
      req.on("error", resolve);
      req.end();
    });
    expect(err.message).toContain("private address");
  });
});
