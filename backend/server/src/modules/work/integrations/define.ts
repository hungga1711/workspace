/**
 * The integrations hub: what one integration is. An integration is one file in `providers/`, built with
 * `defineIntegration`, contributed by pull request (docs/integrations/hub.md). It tells the hub which links are its
 * own (`match`) and how to read one as a card (`fetch`); the hub does the rest: the company's connection and its
 * encrypted token, the links on tasks, caching, permissions, the pages.
 *
 * A provider never touches the database or the network by itself. It gets a `ctx` whose `request` is fenced (https,
 * public addresses, no redirects, a size cap, a timeout) and returns plain data. That is what makes a contributed
 * provider safe to review: everything it can do is in its one file.
 */

/** What a card shows. Few and fixed on purpose: the web draws a card by its kind, so a provider needs no frontend. */
export type CardKind = "review" | "issue" | "design" | "generic";
export const CARD_KINDS: readonly CardKind[] = ["review", "issue", "design", "generic"];
export type CardState = "open" | "draft" | "merged" | "closed" | "done" | "none";
export const CARD_STATES: readonly CardState[] = ["open", "draft", "merged", "closed", "done", "none"];

export interface Card {
  kind: CardKind;
  /** The thing's own title: a pull request's, an issue's, a design file's. */
  title: string;
  /** How people name it in a sentence: "acme/web#128", "Checkout flow › Cart". */
  ref: string;
  state: CardState;
  /** Who made it, by the name the source shows. */
  author?: string | undefined;
  /** ISO time of its last change at the source. */
  updatedAt?: string | undefined;
  labels?: string[] | undefined;
  /** review: the branch it comes from and the one it goes into. */
  branch?: string | undefined;
  target?: string | undefined;
  additions?: number | undefined;
  deletions?: number | undefined;
  comments?: number | undefined;
  /** review: its automatic checks as a whole; absent when the source reports none. */
  checks?: "passing" | "failing" | "pending" | undefined;
  reviewers?: { name: string; state: "approved" | "changes" | "pending" }[] | undefined;
  /** design: an address the hub may load a small preview image from (fetched by the server, never by the browser). */
  thumbnailUrl?: string | undefined;
  /** design: an address that shows it inside a frame, opened only when someone asks. Must be on `embedHosts`. */
  embedUrl?: string | undefined;
}

/** A link the provider recognised: `key` names the thing for good (two addresses of one pull request share it). */
export interface Ref {
  key: string;
  kind: CardKind;
  /** What `fetch` needs to find it again; kept with the link. */
  data: Record<string, string>;
}

export interface FencedResponse {
  status: number;
  text: string;
  /** The body as JSON, or null when it is not. */
  json: <T = unknown>() => T | null;
}
export interface ProviderContext {
  /** The company's token for this integration. Send it only to `apiBase`. */
  token: string;
  /** The API's address: the provider's own, or the company's self-hosted host. */
  apiBase: string;
  /** The site people open (https://github.com, https://gitlab.example.com). */
  webBase: string;
  request: (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<FencedResponse>;
}

/** A pull or merge request seen while looking through a repository for task codes. */
export interface SeenReview {
  url: string;
  title: string;
  branch: string;
  updatedAt: string;
}

export interface Integration {
  /** Lower-case, stable: it is stored with every connection and link. */
  id: string;
  name: string;
  category: "development" | "design" | "other";
  /** One sentence for the hub's tile, in English (the web translates the ones it ships with). */
  summary: string;
  /** The site and its API when the company uses the public service. */
  webBase: string;
  apiBase: string;
  /** The company may run its own (GitLab self-managed): the API's address under the host the admin gives. */
  selfHosted?: { apiPath: string } | undefined;
  /** Where the vendor explains how to make a token, and the least access it needs, in words. */
  tokenHelp: { url: string; needs: string };
  /** Hosts a card's `embedUrl` may be on; the web's frame policy allows exactly the hosts of shipped integrations. */
  embedHosts?: string[] | undefined;
  /** Is this address one of ours? `webBase` is the connection's site (a self-hosted one included). */
  match(url: URL, webBase: string): Ref | null;
  /** Reads the thing as a card. Throw `IntegrationError` with words an office manager can act on. */
  fetch(ref: Ref, ctx: ProviderContext): Promise<Card>;
  /** Proves the token works and says whose it is. */
  check(ctx: ProviderContext): Promise<{ account: string }>;
  /** Optional: repositories the token sees, for the admin to pick which are looked through for task codes. */
  listRepos?(ctx: ProviderContext): Promise<{ id: string; name: string }[]>;
  /** Optional: pull or merge requests of one repository changed since `since`, newest first, at most a hundred. */
  recentReviews?(repo: string, since: Date | null, ctx: ProviderContext): Promise<SeenReview[]>;
}

/** Why the source could not be read, in words for the card or the connect dialog. */
export class IntegrationError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
    this.name = "IntegrationError";
  }
}

const ID = /^[a-z][a-z0-9-]{1,30}$/;

/** Checks a provider's shape once, at start, so a mistake fails the contributor's first run and not a customer's page. */
export function defineIntegration(i: Integration): Integration {
  if (!ID.test(i.id)) throw new Error(`integration id "${i.id}" must be lower-case letters, digits and dashes`);
  for (const [what, url] of [
    ["webBase", i.webBase],
    ["apiBase", i.apiBase],
    ["tokenHelp.url", i.tokenHelp.url],
  ] as const)
    if (!/^https:\/\/[^/]+/.test(url)) throw new Error(`integration ${i.id}: ${what} must be an https address`);
  if (i.selfHosted && !i.selfHosted.apiPath.startsWith("/")) throw new Error(`integration ${i.id}: selfHosted.apiPath must start with /`);
  if (!i.name.trim() || !i.summary.trim() || !i.tokenHelp.needs.trim()) throw new Error(`integration ${i.id}: name, summary and tokenHelp.needs are required`);
  return Object.freeze(i);
}

/** Reads an answer as JSON or says why not, in the integration's name. */
export function okJson<T>(name: string, r: FencedResponse): T {
  if (r.status === 401 || r.status === 403) throw new IntegrationError(`${name} refused the token (HTTP ${r.status}): check it and what it may read`, r.status);
  if (r.status === 404) throw new IntegrationError(`${name} could not find that, or the token may not read it`, 404);
  if (r.status === 429) throw new IntegrationError(`${name} is rate limiting: it will be read again shortly`, 429);
  if (r.status < 200 || r.status >= 300) throw new IntegrationError(`${name} answered HTTP ${r.status}`, r.status);
  const j = r.json<T>();
  if (j === null) throw new IntegrationError(`${name} answered with something that is not JSON`, r.status);
  return j;
}

/** Trims a card to what the hub stores and shows: every text has a length, every list an end. */
export function cleanCard(c: Card): Card {
  const s = (v: string | undefined, n: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : undefined);
  const n = (v: number | undefined) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined);
  const out: Card = {
    kind: CARD_KINDS.includes(c.kind) ? c.kind : "generic",
    title: s(c.title, 300) ?? "(untitled)",
    ref: s(c.ref, 200) ?? "",
    state: CARD_STATES.includes(c.state) ? c.state : "none",
    author: s(c.author, 120),
    updatedAt: c.updatedAt && !Number.isNaN(Date.parse(c.updatedAt)) ? new Date(c.updatedAt).toISOString() : undefined,
    labels: c.labels
      ?.map((l) => s(l, 60))
      .filter((l): l is string => !!l)
      .slice(0, 8),
    branch: s(c.branch, 200),
    target: s(c.target, 200),
    additions: n(c.additions),
    deletions: n(c.deletions),
    comments: n(c.comments),
    checks: c.checks === "passing" || c.checks === "failing" || c.checks === "pending" ? c.checks : undefined,
    reviewers: c.reviewers
      ?.filter((r) => r && typeof r.name === "string" && r.name.trim())
      .slice(0, 12)
      .map((r) => ({ name: r.name.trim().slice(0, 80), state: r.state === "approved" || r.state === "changes" ? r.state : ("pending" as const) })),
    thumbnailUrl: s(c.thumbnailUrl, 2000),
    embedUrl: s(c.embedUrl, 2000),
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length))) as unknown as Card;
}
