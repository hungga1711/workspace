import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CARD_KINDS, cleanCard, defineIntegration, IntegrationError, type Card, type Integration } from "./define.js";
import { codesIn, contextFor, matchUrl, urlsIn, type Requester } from "./hub.js";
import { githubChecks, githubReviewers } from "./providers/github.js";
import { gitlabChecks } from "./providers/gitlab.js";
import { template } from "./providers/_template.js";
import { INTEGRATIONS } from "./registry.js";

/**
 * The contract every integration keeps, checked against answers recorded from the real services
 * (`fixtures/<id>.json`): no network here. A new provider passes by adding its fixture; nothing in this file names it.
 */
type Routes = Record<string, unknown>;
interface Fixture {
  check: { routes: Routes; account: string };
  noMatch: string[];
  cases: { url: string; key: string; routes: Routes; card: Card }[];
  repos?: { routes: Routes; list: { id: string; name: string }[] };
  reviews?: { repo: string; since: string; routes: Routes; seen: unknown[] };
}
const fixtureOf = (id: string) => JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", `${id}.json`), "utf8")) as Fixture;

/** Answers recorded payloads by address (a regular expression each); every request is kept. */
function recorded(routes: Routes) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const request: Requester = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} });
    const hit = Object.entries(routes).find(([re]) => new RegExp(re).test(url));
    return hit ? { status: 200, text: JSON.stringify(hit[1]) } : { status: 404, text: "{}" };
  };
  return { request, calls };
}
const ctxOf = (i: Integration, routes: Routes, token = "tok_secret_123") => {
  const r = recorded(routes);
  const ctx = contextFor({ pool: null as never, request: r.request, image: async () => null }, { web_base: i.webBase, api_base: i.apiBase, private_network: false }, token);
  return { ctx, calls: r.calls };
};

describe.each(INTEGRATIONS.map((i) => [i.id, i] as const))("integration %s", (id, i) => {
  it("has recorded answers", () => {
    expect(existsSync(join(import.meta.dirname, "fixtures", `${id}.json`)), `add fixtures/${id}.json`).toBe(true);
    expect(fixtureOf(id).cases.length).toBeGreaterThan(0);
  });

  it("knows its own addresses and no others, and names one thing the same way every time", () => {
    const f = fixtureOf(id);
    for (const c of f.cases) {
      const url = new URL(c.url);
      const ref = i.match(url, i.webBase);
      expect(ref, c.url).not.toBeNull();
      expect(ref!.key).toBe(c.key);
      expect(CARD_KINDS).toContain(ref!.kind);
      // The same thing with a different tail (a tab, a tracking parameter) is still that thing.
      url.searchParams.set("utm_source", "x");
      url.hash = "#note";
      expect(i.match(url, i.webBase)?.key).toBe(c.key);
      expect(matchUrl(c.url, [])?.integration.id).toBe(id);
    }
    for (const no of f.noMatch) expect(i.match(new URL(no), i.webBase), no).toBeNull();
  });

  it("reads each thing as a clean card, sending the token only to its own API", async () => {
    for (const c of fixtureOf(id).cases) {
      const { ctx, calls } = ctxOf(i, c.routes);
      const card = await i.fetch(i.match(new URL(c.url), i.webBase)!, ctx);
      expect(cleanCard(card)).toEqual(c.card);
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) expect(new URL(call.url).origin).toBe(new URL(i.apiBase).origin);
      expect(calls.every((call) => Object.values(call.headers).some((v) => v.includes("tok_secret_123")))).toBe(true);
      if (card.embedUrl) expect(i.embedHosts).toContain(new URL(card.embedUrl).hostname);
    }
  });

  it("says why in words when the service refuses or does not know the thing", async () => {
    const first = fixtureOf(id).cases[0]!;
    const ref = i.match(new URL(first.url), i.webBase)!;
    for (const status of [401, 404, 500]) {
      const ctx = contextFor(
        { pool: null as never, request: async () => ({ status, text: "{}" }), image: async () => null },
        { web_base: i.webBase, api_base: i.apiBase, private_network: false },
        "t",
      );
      const err = await i.fetch(ref, ctx).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(IntegrationError);
      expect((err as IntegrationError).message).toContain(i.name);
    }
  });

  it("proves a token and says whose it is", async () => {
    const f = fixtureOf(id);
    expect(await i.check(ctxOf(i, f.check.routes).ctx)).toEqual({ account: f.check.account });
    await expect(i.check(ctxOf(i, {}).ctx)).rejects.toBeInstanceOf(IntegrationError);
  });

  it("lists repositories and their recent reviews when it offers to", async () => {
    const f = fixtureOf(id);
    expect(!!i.listRepos).toBe(!!f.repos);
    expect(!!i.recentReviews).toBe(!!f.reviews);
    if (i.listRepos && f.repos) expect(await i.listRepos(ctxOf(i, f.repos.routes).ctx)).toEqual(f.repos.list);
    if (i.recentReviews && f.reviews) {
      expect(await i.recentReviews(f.reviews.repo, new Date(f.reviews.since), ctxOf(i, f.reviews.routes).ctx)).toEqual(f.reviews.seen);
      await expect(i.recentReviews("../../etc", null, ctxOf(i, {}).ctx)).rejects.toBeInstanceOf(IntegrationError);
    }
  });
});

describe("the hub around the providers", () => {
  it("refuses a request to anywhere but the connected service", async () => {
    const i = INTEGRATIONS[0]!;
    const { ctx, calls } = ctxOf(i, {});
    await expect(ctx.request("https://evil.example.com/steal")).rejects.toBeInstanceOf(IntegrationError);
    expect(calls).toHaveLength(0);
  });

  it("matches a self-hosted GitLab only when the company connected that site", () => {
    const url = "https://git.acme.example/team/app/-/merge_requests/9";
    expect(matchUrl(url, [])).toBeNull();
    expect(matchUrl(url, [{ provider: "gitlab", web_base: "https://git.acme.example" }])).toMatchObject({
      integration: { id: "gitlab" },
      ref: { key: "team/app!9", kind: "review" },
    });
    expect(matchUrl("javascript:alert(1)", [])).toBeNull();
    expect(matchUrl("not an address", [])).toBeNull();
  });

  it("finds addresses and task codes in what people write", () => {
    expect(
      urlsIn("See https://github.com/acme/web/pull/128. And (https://www.figma.com/design/AbCdEfGhIjKlMnOp/x?node-id=1-2), twice https://github.com/acme/web/pull/128"),
    ).toEqual(["https://github.com/acme/web/pull/128", "https://www.figma.com/design/AbCdEfGhIjKlMnOp/x?node-id=1-2"]);
    expect(codesIn("WEB-42 Button states feature/web-42-button-states and t-077_fix, not v1.2-3 or ABCDEFGHIJKL-1")).toEqual(["WEB-42", "T-077"]);
  });

  it("puts reviews and checks in the card's words", () => {
    expect(
      githubReviewers(
        [
          { user: { login: "a" }, state: "APPROVED" },
          { user: { login: "a" }, state: "DISMISSED" },
        ],
        [],
      ),
    ).toEqual([{ name: "a", state: "pending" }]);
    expect(githubChecks([])).toBeUndefined();
    expect(
      githubChecks([
        { status: "completed", conclusion: "success" },
        { status: "completed", conclusion: "failure" },
      ]),
    ).toBe("failing");
    expect(
      githubChecks([
        { status: "completed", conclusion: "success" },
        { status: "completed", conclusion: "skipped" },
      ]),
    ).toBe("passing");
    expect(gitlabChecks("running")).toBe("pending");
    expect(gitlabChecks("skipped")).toBeUndefined();
  });

  it("trims a card to what is stored and shown", () => {
    const card = cleanCard({
      kind: "nope" as never,
      title: "  ",
      ref: "x".repeat(500),
      state: "weird" as never,
      additions: -1,
      labels: ["", "a"],
      reviewers: [{ name: " ", state: "approved" }],
      updatedAt: "not a date",
    });
    expect(card).toEqual({ kind: "generic", title: "(untitled)", ref: "x".repeat(200), state: "none", labels: ["a"] });
  });

  it("the template is a valid integration, and a malformed one is refused at start", () => {
    expect(template.id).toBe("example-tracker");
    expect(template.match(new URL("https://tracker.example.com/shop/issues/7"), template.webBase)).toMatchObject({ key: "shop#7" });
    expect(() => defineIntegration({ ...template, id: "Bad Id" })).toThrow(/lower-case/);
    expect(() => defineIntegration({ ...template, apiBase: "http://plain.example.com" })).toThrow(/https/);
  });
});
