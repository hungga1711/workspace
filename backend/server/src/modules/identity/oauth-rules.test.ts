import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pkceOk, presetPermissions, redirectLabel, redirectMatches, redirectWith, scopeOf, validRedirectUri } from "./oauth-rules.js";

describe("MCP OAuth rules", () => {
  it("accepts https, loopback http and app schemes as redirect URIs; refuses the rest", () => {
    for (const ok of [
      "https://claude.ai/api/mcp/auth_callback",
      "http://localhost:33418/callback",
      "http://127.0.0.1:5555/cb",
      "http://[::1]:8080/",
      "cursor://anysphere.cursor-mcp/oauth/callback",
      "vscode://vscode.github-authentication/did-authenticate",
    ])
      expect(validRedirectUri(ok), ok).toBe(true);
    for (const bad of ["http://evil.example/cb", "javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "https://x.example/cb#frag", "not a url", "ftp://x/"])
      expect(validRedirectUri(bad), bad).toBe(false);
  });

  it("matches redirect URIs exactly, except a loopback port", () => {
    const reg = ["http://127.0.0.1:33418/callback", "https://vscode.dev/redirect"];
    expect(redirectMatches(reg, "https://vscode.dev/redirect")).toBe(true);
    expect(redirectMatches(reg, "https://vscode.dev/redirect?x=1")).toBe(false);
    expect(redirectMatches(reg, "http://127.0.0.1:40001/callback")).toBe(true);
    expect(redirectMatches(reg, "http://127.0.0.1:40001/other")).toBe(false);
    expect(redirectMatches(reg, "http://localhost:33418/callback")).toBe(false);
    expect(redirectMatches(reg, "https://127.0.0.1:33418/callback")).toBe(false);
  });

  it("checks PKCE S256 only, in constant time", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    expect(pkceOk(verifier, challenge)).toBe(true);
    expect(pkceOk(verifier + "x", challenge)).toBe(false);
    expect(pkceOk("short", challenge)).toBe(false);
    // plain (verifier === challenge) is not accepted.
    expect(pkceOk(verifier, verifier)).toBe(false);
  });

  it("presets offer only what the person may give, and the scope follows the permissions", () => {
    const grantable = ["task.read", "task.edit", "message.post", "role.manage", "project.read"];
    expect(presetPermissions("read", grantable)).toEqual(["task.read", "project.read"]);
    expect(presetPermissions("write", grantable)).toEqual(["task.read", "task.edit", "message.post", "project.read"]);
    expect(scopeOf(["task.read"])).toBe("mcp:read");
    expect(scopeOf(["task.read", "task.edit"])).toBe("mcp:read mcp:write");
  });

  it("builds the redirect back with the code and state, and labels it for the consent page", () => {
    expect(redirectWith("http://127.0.0.1:1/cb?keep=1", { code: "c", state: "s&t", error: undefined })).toBe("http://127.0.0.1:1/cb?keep=1&code=c&state=s%26t");
    expect(redirectLabel("https://claude.ai/api/mcp/auth_callback")).toBe("claude.ai");
    expect(redirectLabel("cursor://anysphere.cursor-mcp/oauth/callback")).toBe("anysphere.cursor-mcp");
  });
});
