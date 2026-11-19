import { request as httpsRequest } from "node:https";
import { newId, withTransaction, type Principal } from "@workspace/shared";
import { checkPublicUrl, logger, publicOnlyLookup, requestPublic, secretBox } from "@workspace/service-kit";
import type { Pool, PoolClient } from "pg";
import { Invalid, NotFound } from "../errors.js";
import { canReadTask, getTask, type TaskRow } from "../tasks.js";
import { cleanCard, IntegrationError, type Card, type FencedResponse, type Integration, type ProviderContext, type Ref } from "./define.js";
import { linkedEvent, linkedWorkChanged } from "../workflow-triggers.js";
import { INTEGRATIONS, integrationOf } from "./registry.js";

/**
 * The integrations hub: the part every integration shares. A company connects an integration once (a
 * token, encrypted, never returned); from then on an address of that tool on a task, added by hand or written in the
 * task's description or comments, is a live card: a pull request with its state, reviews and checks, a design with
 * its preview. GitHub and GitLab also look through the repositories the admin picked for pull and merge requests
 * that name a task's code. Read-only: the hub never writes to the other tool.
 *
 * Providers (`providers/`, the contract in `define.ts`) only say which addresses are theirs and how to read one.
 */

const box = secretBox("integrations/v1", "INTEGRATIONS_SECRETS_KEY");
/** A card older than this is read again when someone looks at the task. */
export const CARD_FRESH_MS = 5 * 60_000;
/** At most this many cards are read again for one look: the rest wait for the next. */
const REFRESH_AT_ONCE = 12;
const THUMBNAIL_MAX = 180 * 1024;
const LINKS_PER_TASK = 40;

export type Requester = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; allowPrivate?: boolean },
) => Promise<{ status: number; text: string }>;
export interface HubDeps {
  pool: Pool;
  /** One fenced request (tests pass recorded answers). */
  request: Requester;
  /** A small picture from a public address, as a data URL; null when it cannot be had. */
  image: (url: string) => Promise<string | null>;
}

/** Development and tests only (as for webhooks): reach this machine's network too. Never in production. */
const devPrivate = () => process.env.WEBHOOK_ALLOW_PRIVATE === "1" && process.env.NODE_ENV !== "production";

export function hubDeps(pool: Pool): HubDeps {
  return {
    pool,
    request: (url, init = {}) => requestPublic(url, { ...init, allowPrivate: !!init.allowPrivate || devPrivate() }),
    image: fetchImage,
  };
}

/** A preview picture: https, a public address, an image type, a size cap; anything else is no picture. */
function fetchImage(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return resolve(null);
    }
    if (u.protocol !== "https:") return resolve(null);
    const req = httpsRequest(u, { method: "GET", timeout: 8000, lookup: publicOnlyLookup }, (res) => {
      const type = String(res.headers["content-type"] ?? "")
        .split(";")[0]!
        .trim();
      if (res.statusCode !== 200 || !/^image\/(png|jpeg|webp|gif)$/.test(type)) {
        res.resume();
        return resolve(null);
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > THUMBNAIL_MAX) {
          req.destroy();
          resolve(null);
        } else chunks.push(c);
      });
      res.on("end", () => resolve(`data:${type};base64,${Buffer.concat(chunks).toString("base64")}`));
      res.on("error", () => resolve(null));
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
    req.end();
  });
}

// ── Connections ──────────────────────────────────────────────────────────────────────────────────────

export interface ConnectionRow {
  id: string;
  provider: string;
  web_base: string;
  api_base: string;
  private_network: boolean;
  account: string;
  secret_enc: string;
  repos: string[];
  enabled: boolean;
  scan_cursor_at: Date | null;
  last_ok_at: Date | null;
  last_error: string | null;
  created_by: string;
  created_at: Date;
}

const connectionDto = (r: ConnectionRow) => ({
  id: r.id,
  provider: r.provider,
  site: r.web_base,
  selfHosted: r.web_base !== integrationOf(r.provider)?.webBase,
  privateNetwork: r.private_network,
  account: r.account,
  repos: r.repos,
  enabled: r.enabled,
  lastOkAt: r.last_ok_at,
  lastError: r.last_error,
  createdAt: r.created_at,
});

/**
 * What a provider is handed. Its requests go only to the API it was connected to: a provider (or an address it was
 * tricked into building) can never send the company's token anywhere else.
 */
export function contextFor(deps: HubDeps, c: Pick<ConnectionRow, "web_base" | "api_base" | "private_network">, token: string): ProviderContext {
  const origin = new URL(c.api_base).origin;
  return {
    token,
    apiBase: c.api_base,
    webBase: c.web_base,
    request: async (url, init) => {
      if (new URL(url).origin !== origin) throw new IntegrationError("an integration may only call the service it is connected to");
      const r = await deps.request(url, { ...init, allowPrivate: c.private_network }).catch((e: unknown) => {
        throw new IntegrationError(`could not reach ${new URL(c.web_base).host}: ${e instanceof Error ? e.message : "no answer"}`);
      });
      const res: FencedResponse = {
        status: r.status,
        text: r.text,
        json: <T>() => {
          try {
            return JSON.parse(r.text) as T;
          } catch {
            return null;
          }
        },
      };
      return res;
    },
  };
}

/** Where an integration lives for this company: the public service, or the address the admin gave. */
async function basesFor(i: Integration, site: string | null | undefined, privateNetwork: boolean): Promise<{ web_base: string; api_base: string }> {
  const given = (site ?? "").trim().replace(/\/+$/, "");
  if (!given || given === i.webBase) return { web_base: i.webBase, api_base: i.apiBase };
  if (!i.selfHosted) throw new Invalid(`${i.name} has one address: leave the site empty`);
  const web = /^https?:\/\//i.test(given) ? given : `https://${given}`;
  let origin: string;
  try {
    origin = new URL(web).origin;
  } catch {
    throw new Invalid("that is not an address");
  }
  const why = await checkPublicUrl(origin, privateNetwork || devPrivate());
  if (why) throw new Invalid(why === "URL resolves to a private address" ? "that address is inside your network: tick “inside our network” to allow it" : why);
  return { web_base: origin, api_base: `${origin}${i.selfHosted.apiPath}` };
}

const requireIntegration = (id: string): Integration => {
  const i = integrationOf(id);
  if (!i) throw new NotFound("no such integration");
  return i;
};

const words = (e: unknown) => (e instanceof IntegrationError || e instanceof Invalid ? e.message : "the service could not be read");

/** The hub's tiles: every integration, and whether the company has connected it. For any member. */
export async function catalog(pool: Pool) {
  const rows = (await pool.query<Pick<ConnectionRow, "provider" | "enabled">>("SELECT provider, enabled FROM integration_connections")).rows;
  return {
    integrations: INTEGRATIONS.map((i) => ({
      id: i.id,
      name: i.name,
      category: i.category,
      summary: i.summary,
      site: i.webBase,
      selfHosted: !!i.selfHosted,
      scansRepos: !!i.recentReviews,
      tokenHelp: i.tokenHelp,
      connected: rows.some((r) => r.provider === i.id && r.enabled),
    })),
  };
}

export async function listConnections(pool: Pool) {
  const rows = (await pool.query<ConnectionRow>("SELECT * FROM integration_connections ORDER BY created_at")).rows;
  const links = (await pool.query<{ provider: string; n: string }>("SELECT provider, count(*) AS n FROM task_work_links WHERE NOT dismissed GROUP BY provider")).rows;
  return { connections: rows.map((r) => ({ ...connectionDto(r), links: Number(links.find((l) => l.provider === r.provider)?.n ?? 0) })) };
}

export interface ConnectInput {
  provider: string;
  token: string;
  site?: string | null | undefined;
  privateNetwork?: boolean | undefined;
}

/** Checks a token before anything is saved: whose it is, and the repositories it sees. */
export async function checkConnection(deps: HubDeps, b: ConnectInput) {
  const i = requireIntegration(b.provider);
  const bases = await basesFor(i, b.site, !!b.privateNetwork);
  const ctx = contextFor(deps, { ...bases, private_network: !!b.privateNetwork }, b.token);
  try {
    const who = await i.check(ctx);
    const repos = i.listRepos ? await i.listRepos(ctx).catch(() => []) : [];
    return { account: who.account.slice(0, 200), site: bases.web_base, repos: repos.slice(0, 500) };
  } catch (e) {
    throw new Invalid(words(e));
  }
}

export async function createConnection(deps: HubDeps, p: Principal, b: ConnectInput & { repos?: string[] | undefined }) {
  const i = requireIntegration(b.provider);
  const checked = await checkConnection(deps, b);
  const bases = await basesFor(i, b.site, !!b.privateNetwork);
  const id = newId();
  const r = await deps.pool.query(
    `INSERT INTO integration_connections (id, provider, web_base, api_base, private_network, account, secret_enc, repos, created_by, last_ok_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now()) ON CONFLICT (provider, web_base) DO NOTHING`,
    [id, i.id, bases.web_base, bases.api_base, !!b.privateNetwork, checked.account, box.encrypt(b.token), cleanRepos(b.repos), p.id],
  );
  if (!r.rowCount) throw new Invalid(`${i.name} is already connected for ${new URL(bases.web_base).host}`);
  return { id };
}

const cleanRepos = (repos: string[] | undefined) => [...new Set((repos ?? []).map((r) => r.trim()).filter(Boolean))].slice(0, 100);

async function connection(pool: Pool | PoolClient, id: string): Promise<ConnectionRow> {
  const r = (await pool.query<ConnectionRow>("SELECT * FROM integration_connections WHERE id = $1", [id])).rows[0];
  if (!r) throw new NotFound("connection not found");
  return r;
}

export async function updateConnection(deps: HubDeps, id: string, b: { token?: string | undefined; repos?: string[] | undefined; enabled?: boolean | undefined }) {
  const row = await connection(deps.pool, id);
  const i = requireIntegration(row.provider);
  let account: string | null = null;
  if (b.token) {
    // A new token is proven before it replaces the old one.
    try {
      account = (await i.check(contextFor(deps, row, b.token))).account.slice(0, 200);
    } catch (e) {
      throw new Invalid(words(e));
    }
  }
  await deps.pool.query(
    `UPDATE integration_connections
        SET secret_enc = coalesce($2, secret_enc), account = coalesce($3, account), enabled = coalesce($4, enabled),
            -- Repositories added to the list are looked through from the start.
            scan_cursor_at = CASE WHEN $5::text[] IS NOT NULL AND NOT ($5::text[] <@ repos) THEN NULL ELSE scan_cursor_at END,
            repos = coalesce($5, repos), last_error = CASE WHEN $2::text IS NOT NULL THEN NULL ELSE last_error END, updated_at = now()
      WHERE id = $1`,
    [id, b.token ? box.encrypt(b.token) : null, account, b.enabled ?? null, b.repos ? cleanRepos(b.repos) : null],
  );
  return { ok: true };
}

/** The repositories a saved connection's token sees, to change which are looked through. */
export async function connectionRepos(deps: HubDeps, id: string) {
  const row = await connection(deps.pool, id);
  const i = requireIntegration(row.provider);
  if (!i.listRepos) return { repos: [] };
  try {
    return { repos: (await i.listRepos(contextFor(deps, row, box.decrypt(row.secret_enc)))).slice(0, 500) };
  } catch (e) {
    throw new Invalid(words(e));
  }
}

/** Disconnects. Links stay on their tasks as plain links, with the last card they had. */
export async function removeConnection(pool: Pool, id: string) {
  await connection(pool, id);
  await pool.query("DELETE FROM integration_connections WHERE id = $1", [id]);
}

// ── Links ────────────────────────────────────────────────────────────────────────────────────────────

interface LinkRow {
  id: string;
  task_id: string;
  provider: string;
  url: string;
  ref_key: string;
  ref: Ref["data"];
  kind: Ref["kind"];
  source: "manual" | "found" | "scan";
  dismissed: boolean;
  card: Card | null;
  card_at: Date | null;
  error: string | null;
  has_thumbnail?: boolean;
  added_by: string | null;
  created_at: Date;
}
const LINK_COLS = "id, task_id, provider, url, ref_key, ref, kind, source, dismissed, card, card_at, error, (thumbnail IS NOT NULL) AS has_thumbnail, added_by, created_at";

function linkDto(r: LinkRow, connected: boolean) {
  const i = integrationOf(r.provider);
  // The preview's address is the server's business; a frame's address only when it is on a host the integration names.
  const { thumbnailUrl: _t, embedUrl, ...card } = r.card ?? ({} as Card);
  const embed = embedUrl && i?.embedHosts?.includes(safeHost(embedUrl)) ? embedUrl : undefined;
  return {
    id: r.id,
    taskId: r.task_id,
    provider: r.provider,
    providerName: i?.name ?? r.provider,
    url: r.url,
    kind: r.kind,
    source: r.source,
    card: r.card ? { ...card, ...(embed ? { embedUrl: embed } : {}) } : null,
    cardAt: r.card_at,
    error: r.error,
    hasThumbnail: !!r.has_thumbnail,
    /** false: the company has not connected this integration (or switched it off), so the card cannot be read. */
    connected,
  };
}
const safeHost = (url: string) => {
  try {
    const u = new URL(url);
    return u.protocol === "https:" ? u.hostname : "";
  } catch {
    return "";
  }
};

/** Which integration an address belongs to, given the sites the company connected (its own GitLab included). */
export function matchUrl(raw: string, connections: Pick<ConnectionRow, "provider" | "web_base">[]): { integration: Integration; ref: Ref; webBase: string } | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  for (const i of INTEGRATIONS) {
    const bases = [...new Set([i.webBase, ...connections.filter((c) => c.provider === i.id).map((c) => c.web_base)])];
    for (const webBase of bases) {
      let ref: Ref | null = null;
      try {
        ref = i.match(url, webBase);
      } catch {
        ref = null;
      }
      if (ref?.key) return { integration: i, ref: { ...ref, key: ref.key.slice(0, 300) }, webBase };
    }
  }
  return null;
}

const URLS = /https?:\/\/[^\s<>"'`)\]]+/g;
/** Addresses written in a text, without the punctuation that ends a sentence. */
export const urlsIn = (text: string): string[] => [...new Set((text.match(URLS) ?? []).map((u) => u.replace(/[.,;:!?]+$/, "")))].slice(0, 60);

/** The connection that reads a link: the one for its provider on the site the link is on. */
const connectionFor = (r: Pick<LinkRow, "provider" | "url">, connections: ConnectionRow[]) => {
  const origin = safeOrigin(r.url);
  const mine = connections.filter((c) => c.provider === r.provider && c.enabled);
  return mine.find((c) => c.web_base === origin) ?? mine.find((c) => integrationOf(c.provider)?.webBase === c.web_base && !integrationOf(c.provider)?.selfHosted) ?? null;
};
const safeOrigin = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
};

/** Reads one link's card from its source and keeps it (or why it could not be read). Outside any transaction. */
async function refresh(deps: HubDeps, row: LinkRow, conn: ConnectionRow): Promise<void> {
  const i = integrationOf(row.provider);
  if (!i) return;
  try {
    const card = cleanCard(await i.fetch({ key: row.ref_key, kind: row.kind, data: row.ref }, contextFor(deps, conn, box.decrypt(conn.secret_enc))));
    // The preview is fetched again only when the thing changed (its address often expires, the picture does not).
    const changed = !row.has_thumbnail || card.updatedAt !== row.card?.updatedAt;
    const thumbnail = card.thumbnailUrl && changed ? await deps.image(card.thumbnailUrl).catch(() => null) : undefined;
    await deps.pool.query(
      `UPDATE task_work_links SET card = $2, card_at = now(), error = NULL, kind = $3, thumbnail = CASE WHEN $4::boolean THEN $5 ELSE thumbnail END WHERE id = $1`,
      [row.id, JSON.stringify(card), card.kind, thumbnail !== undefined && thumbnail !== null, thumbnail ?? null],
    );
    await deps.pool.query(
      "UPDATE integration_connections SET last_ok_at = now(), last_error = NULL WHERE id = $1 AND (last_error IS NOT NULL OR last_ok_at < now() - interval '10 minutes')",
      [conn.id],
    );
    // Workflows that start when linked work is opened or merged hear of it here (workflow-triggers.ts).
    const happened = linkedEvent(row.card, card);
    if (happened)
      await linkedWorkChanged(deps.pool, row.task_id, happened, card.title, row.id).catch((err: unknown) => logger.warn({ err }, "linked work could not start workflows"));
  } catch (e) {
    const message = words(e).slice(0, 300);
    if (!(e instanceof IntegrationError)) logger.warn({ err: e, provider: row.provider }, "integration card failed");
    // The last card stays: a card that cannot be read right now still says what it was.
    await deps.pool.query("UPDATE task_work_links SET error = $2, card_at = now() WHERE id = $1", [row.id, message]);
    // A refused token is the connection's problem, shown to the admin; one missing pull request is not.
    if (e instanceof IntegrationError && (e.status === 401 || e.status === 403))
      await deps.pool.query("UPDATE integration_connections SET last_error = $2 WHERE id = $1", [conn.id, message]);
  }
}

async function loadLinks(c: Pool | PoolClient, where: string, args: unknown[]): Promise<LinkRow[]> {
  return (await c.query<LinkRow>(`SELECT ${LINK_COLS} FROM task_work_links WHERE ${where} ORDER BY created_at`, args)).rows;
}

/**
 * A task's linked work, for whoever may read the task. Addresses of connected tools written in the description or
 * the comments become links here (once: one that was removed stays removed), and cards older than a few minutes are
 * read again before the answer.
 */
export async function taskLinks(deps: HubDeps, p: Principal, taskId: string) {
  const { task, connections } = await withTransaction(deps.pool, async (c) => {
    const task = await getTask(c, p, taskId);
    const connections = (await c.query<ConnectionRow>("SELECT * FROM integration_connections")).rows;
    const comments = (await c.query<{ body: string }>("SELECT body FROM task_comments WHERE task_id = $1 ORDER BY created_at DESC LIMIT 200", [task.id])).rows;
    const known = new Set(
      (await c.query<{ provider: string; ref_key: string }>("SELECT provider, ref_key FROM task_work_links WHERE task_id = $1", [task.id])).rows.map(
        (r) => `${r.provider}:${r.ref_key}`,
      ),
    );
    for (const url of urlsIn([task.description ?? "", ...comments.map((x) => x.body)].join("\n"))) {
      if (known.size >= LINKS_PER_TASK) break;
      const m = matchUrl(url, connections);
      if (!m || known.has(`${m.integration.id}:${m.ref.key}`)) continue;
      known.add(`${m.integration.id}:${m.ref.key}`);
      await insertLink(c, task.id, url, m, "found", null);
    }
    return { task, connections };
  });
  let rows = await loadLinks(deps.pool, "task_id = $1 AND NOT dismissed", [task.id]);
  const stale = rows.filter((r) => connectionFor(r, connections) && (!r.card_at || Date.now() - r.card_at.getTime() > CARD_FRESH_MS)).slice(0, REFRESH_AT_ONCE);
  if (stale.length) {
    await Promise.all(stale.map((r) => refresh(deps, r, connectionFor(r, connections)!)));
    rows = await loadLinks(deps.pool, "task_id = $1 AND NOT dismissed", [task.id]);
  }
  // Which tools a link can be pasted for: the task page offers its field only when there is one.
  const connected = INTEGRATIONS.filter((i) => connections.some((c) => c.provider === i.id && c.enabled)).map((i) => ({ id: i.id, name: i.name }));
  return { links: rows.map((r) => linkDto(r, !!connectionFor(r, connections))), connected };
}

async function insertLink(c: Pool | PoolClient, taskId: string, url: string, m: NonNullable<ReturnType<typeof matchUrl>>, source: LinkRow["source"], by: string | null) {
  const r = await c.query<{ id: string }>(
    `INSERT INTO task_work_links (id, task_id, provider, url, ref_key, ref, kind, source, added_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (task_id, provider, ref_key) DO NOTHING RETURNING id`,
    [newId(), taskId, m.integration.id, url.slice(0, 2000), m.ref.key, JSON.stringify(m.ref.data), m.ref.kind, source, by],
  );
  return r.rows[0]?.id ?? null;
}

/** Someone adds an address to a task: it must be one an integration knows. Anyone who may read the task (as for a comment). */
export async function addLink(deps: HubDeps, p: Principal, taskId: string, url: string) {
  const connections = (await deps.pool.query<ConnectionRow>("SELECT * FROM integration_connections")).rows;
  const m = matchUrl(url.trim(), connections);
  if (!m) throw new Invalid(`no integration knows this address: paste a link to ${INTEGRATIONS.map((i) => i.name).join(", ")}`);
  const id = await withTransaction(deps.pool, async (c) => {
    const task = await getTask(c, p, taskId);
    const n = (await c.query<{ n: string }>("SELECT count(*) AS n FROM task_work_links WHERE task_id = $1 AND NOT dismissed", [task.id])).rows[0]!;
    if (Number(n.n) >= LINKS_PER_TASK) throw new Invalid(`a task holds at most ${LINKS_PER_TASK} links`);
    // One it already had (found, or removed before) becomes a link someone chose.
    const back = await c.query<{ id: string }>(
      "UPDATE task_work_links SET dismissed = false, source = 'manual', added_by = $4, url = $5 WHERE task_id = $1 AND provider = $2 AND ref_key = $3 RETURNING id",
      [task.id, m.integration.id, m.ref.key, p.id, url.trim().slice(0, 2000)],
    );
    return back.rows[0]?.id ?? (await insertLink(c, task.id, url.trim(), m, "manual", p.id))!;
  });
  const row = (await loadLinks(deps.pool, "id = $1", [id]))[0]!;
  const conn = connectionFor(row, connections);
  if (conn) await refresh(deps, row, conn);
  return linkDto((await loadLinks(deps.pool, "id = $1", [id]))[0]!, !!conn);
}

async function linkOf(c: PoolClient, p: Principal, taskId: string, linkId: string): Promise<{ task: TaskRow; row: LinkRow }> {
  const task = await getTask(c, p, taskId);
  const row = (await loadLinks(c, "id = $1 AND task_id = $2", [linkId, task.id]))[0];
  if (!row) throw new NotFound("link not found");
  return { task, row };
}

/** Takes a link off a task. One the hub found by itself is only hidden, so it does not come back. */
export async function removeLink(deps: HubDeps, p: Principal, taskId: string, linkId: string) {
  await withTransaction(deps.pool, async (c) => {
    const { row } = await linkOf(c, p, taskId, linkId);
    if (row.source === "manual") await c.query("DELETE FROM task_work_links WHERE id = $1", [row.id]);
    else await c.query("UPDATE task_work_links SET dismissed = true WHERE id = $1", [row.id]);
  });
}

/** Reads one card again now ("Refresh" on the card). */
export async function refreshLink(deps: HubDeps, p: Principal, taskId: string, linkId: string) {
  const { row } = await withTransaction(deps.pool, (c) => linkOf(c, p, taskId, linkId));
  const connections = (await deps.pool.query<ConnectionRow>("SELECT * FROM integration_connections")).rows;
  const conn = connectionFor(row, connections);
  if (!conn) throw new Invalid(`${integrationOf(row.provider)?.name ?? "this integration"} is not connected`);
  await refresh(deps, row, conn);
  return linkDto((await loadLinks(deps.pool, "id = $1", [row.id]))[0]!, true);
}

/** A design's preview picture, asked for apart from the list so the list stays small. */
export async function linkThumbnail(deps: HubDeps, p: Principal, taskId: string, linkId: string) {
  return withTransaction(deps.pool, async (c) => {
    const { row } = await linkOf(c, p, taskId, linkId);
    const r = (await c.query<{ thumbnail: string | null }>("SELECT thumbnail FROM task_work_links WHERE id = $1", [row.id])).rows[0];
    if (!r?.thumbnail) throw new NotFound("no preview");
    return { dataUrl: r.thumbnail };
  });
}

/**
 * A project's pull and merge requests: every review linked to one of its tasks, open ones first, with the task each
 * belongs to. Only tasks the reader may open; cards as last read (a task's own page reads them again).
 */
export async function projectReviews(deps: HubDeps, p: Principal, projectId: string) {
  const rows = (
    await deps.pool.query<
      LinkRow & { code: string; title: string; status: string; owner_id: string; assignee_id: string | null; team_id: string | null; project_id: string | null }
    >(
      `SELECT l.id, l.task_id, l.provider, l.url, l.ref_key, l.ref, l.kind, l.source, l.dismissed, l.card, l.card_at, l.error, (l.thumbnail IS NOT NULL) AS has_thumbnail,
              l.added_by, l.created_at, t.code, t.title, t.status, t.owner_id, t.assignee_id, t.team_id, t.project_id
         FROM task_work_links l JOIN tasks t ON t.id = l.task_id
        WHERE t.project_id = $1 AND l.kind = 'review' AND NOT l.dismissed
        ORDER BY l.card_at DESC NULLS LAST LIMIT 300`,
      [projectId],
    )
  ).rows.filter((r) => canReadTask(p, r));
  if (!rows.length && !(await deps.pool.query("SELECT 1 FROM projects WHERE id = $1", [projectId])).rowCount) throw new NotFound("project not found");
  const connections = (await deps.pool.query<ConnectionRow>("SELECT * FROM integration_connections")).rows;
  const order: Record<string, number> = { open: 0, draft: 1, merged: 2, closed: 3 };
  return {
    reviews: rows
      .map((r) => ({ ...linkDto(r, !!connectionFor(r, connections)), task: { id: r.task_id, code: r.code, title: r.title, status: r.status } }))
      // One never read (its tool is not connected) may be anything: after the open ones, before what is over.
      .sort((a, b) => (a.card ? (order[a.card.state] ?? 4) : 1.5) - (b.card ? (order[b.card.state] ?? 4) : 1.5)),
  };
}

// ── Looking through repositories for task codes ──────────────────────────────────────────────────────

/** Codes as the workspace writes them (T-077, WEB-42), in a title or a branch name ("feature/web-42-login"). */
const CODE = /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]{0,9}-\d{1,6})(?![A-Za-z0-9])/g;
export const codesIn = (text: string): string[] => [...new Set([...text.matchAll(CODE)].map((m) => m[1]!.toUpperCase()))].slice(0, 10);

/**
 * Every connected GitHub and GitLab: the pull and merge requests changed since the last look, in the repositories
 * the admin picked, that name a task's code in their title or branch are linked to that task. Never throws: a
 * connection that fails keeps its error for the admin and the others go on.
 */
export async function scanRepos(deps: HubDeps): Promise<{ linked: number }> {
  const rows = (await deps.pool.query<ConnectionRow>("SELECT * FROM integration_connections WHERE enabled AND cardinality(repos) > 0")).rows;
  let linked = 0;
  for (const conn of rows) {
    const i = integrationOf(conn.provider);
    if (!i?.recentReviews) continue;
    const started = new Date();
    try {
      const ctx = contextFor(deps, conn, box.decrypt(conn.secret_enc));
      for (const repo of conn.repos) {
        for (const seen of await i.recentReviews(repo, conn.scan_cursor_at, ctx)) {
          const codes = codesIn(`${seen.title} ${seen.branch}`);
          if (!codes.length) continue;
          const m = matchUrl(seen.url, [conn]);
          if (!m || m.integration.id !== i.id) continue;
          // Codes are matched as written, upper or lower (each spelling can use the unique index).
          const tasks = (await deps.pool.query<{ id: string }>("SELECT id FROM tasks WHERE code = ANY($1) LIMIT 10", [[...codes, ...codes.map((x) => x.toLowerCase())]])).rows;
          for (const t of tasks) {
            const id = await insertLink(deps.pool, t.id, seen.url, m, "scan", null);
            if (!id) continue;
            linked++;
            await refresh(deps, (await loadLinks(deps.pool, "id = $1", [id]))[0]!, conn);
          }
        }
      }
      await deps.pool.query("UPDATE integration_connections SET scan_cursor_at = $2, last_ok_at = now(), last_error = NULL WHERE id = $1", [conn.id, started]);
    } catch (e) {
      if (!(e instanceof IntegrationError)) logger.warn({ err: e, provider: conn.provider }, "integration scan failed");
      await deps.pool.query("UPDATE integration_connections SET last_error = $2 WHERE id = $1", [conn.id, words(e).slice(0, 300)]);
    }
  }
  return { linked };
}
