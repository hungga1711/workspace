import type { Pool } from "pg";
import { AiGateway, DEFAULTS, envGatewayParts, type GatewayConfig, type Route } from "./gateway.js";
import { backendFor, CONNECTION_COLS, decryptSecret, probeTools, VENDOR_LABEL, type ConnectionRow } from "./connections.js";
import type { ModelBackend, ModelProvider, ModelRequest, ModelResponse } from "./providers.js";
import { DeviceBackend, deviceUrl } from "./device-hub.js";
import { personalNow, type PersonalAi } from "./personal-ai.js";

/** A model the assistant's menu offers: one per configured connection (or env vendor). */
export interface MenuModel {
  route: string;
  vendor: string;
  label: string;
  model: string;
}

/**
 * A model a workflow step may pick: each connection's fast and main model, each env vendor's. The step
 * stores `route`; `tier` says which of the connection's two models it is.
 */
export interface CatalogModel extends MenuModel {
  tier: "fast" | "smart";
}
/** The workflow model picker: every model, and what "the company's main / fast model" is today. */
export interface ModelCatalog {
  models: CatalogModel[];
  defaults: { fast: { label: string; model: string; route: string }; smart: { label: string; model: string; route: string } } | null;
}

interface Built {
  gw: AiGateway;
  menu: MenuModel[];
  catalog: ModelCatalog;
  at: number;
  /** Connections it was built from; unchanged rows keep the same gateway (and its failover state). */
  sig: string;
  /** Gateway providers whose model was found not to call tools, or not yet probed (connection test). */
  noTools: Set<string>;
  /** Provider of the default route ("smart" tier), when a stored connection is the default. */
  main: string | null;
}

const ENV_LABELS: Record<string, string> = { openai: "GPT", anthropic: "Claude", gemini: "Gemini" };
const signature = (rows: ConnectionRow[]) => rows.map((r) => `${r.id}@${new Date(r.updated_at).getTime()}:${r.is_default}:${r.tools_ok}`).join(",");

/** The route of a person's own AI in the assistant's menu (personal-ai.ts): "personal:<model or AI id>". */
export const PERSONAL = "personal";
const isPersonal = (route?: string) => !!route && route.startsWith(`${PERSONAL}:`);

/** The models a person's own AI offers, its chosen one first; one entry ("" = the AI's own default) when it lists none. */
export function personalModels(own: PersonalAi): string[] {
  const listed = own.models ?? [];
  return [...new Set([own.model || listed[0] || "", ...listed])];
}

/** A model name as the menu shows it: "opus" → "Opus", "claude-fable-5-2[1m]" → "Fable 5.2 1M", a server's own as it is. */
export function modelLabel(model: string): string {
  const m = /^(?:claude-)?(opus|sonnet|haiku|fable)((?:-\d{1,2})*)(?:-\d{8})?(\[1m\])?$/i.exec(model);
  if (!m) return model;
  const family = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1).toLowerCase();
  const version = m[2] ? ` ${m[2].slice(1).split("-").join(".")}` : "";
  return `${family}${version}${m[3] ? " 1M" : ""}`;
}

/** The model a request picked from a person's own AI ("personal:<model>"), when that AI offers it; else its chosen one. */
export function personalModelOf(own: PersonalAi, route?: string): string {
  const picked = isPersonal(route) ? route!.slice(PERSONAL.length + 1) : "";
  return picked && picked !== own.ai && (own.models ?? []).includes(picked) ? picked : own.model;
}

/** Gateway provider key of a stored connection (no ":" — routes are "provider:model"). */
export const connKey = (id: string) => `c_${id}`;

/**
 * The workspace's AI gateway: the server's env vendors (if any) plus the connections an admin set up in Admin › AI.
 * The default connection, when there is one, takes every feature's route; env AI_ROUTES still apply for vendors
 * that exist. Built once and kept 30 s (or until a setting changes), so a model call costs no extra query.
 */
export class WorkspaceGateway implements ModelProvider {
  private built: Built | undefined;
  private loading: Promise<Built> | undefined;
  private readonly env: ReturnType<typeof envGatewayParts>;

  constructor(
    private readonly pool: Pool,
    env: NodeJS.ProcessEnv = process.env,
    private readonly ttlMs = 30_000,
  ) {
    this.env = envGatewayParts(env);
  }

  /** Loads (or refreshes) the gateway; the request middleware calls it before any sync read. */
  async ready(): Promise<Built> {
    const hit = this.built;
    if (hit && Date.now() - hit.at < this.ttlMs) return hit;
    if (this.loading) return this.loading;
    this.loading = this.pool
      .query<ConnectionRow>(`SELECT ${CONNECTION_COLS} FROM ai_connections WHERE enabled ORDER BY is_default DESC, created_at`)
      .then((r) => {
        const sig = signature(r.rows);
        this.probeUnknown(r.rows);
        return hit && hit.sig === sig ? { ...hit, at: Date.now() } : this.fromRows(r.rows);
      })
      .catch((e) => {
        // Table not migrated yet, or the database blinked: keep the last good gateway, else env only.
        console.log(JSON.stringify({ msg: "ai.gateway.load_failed", error: (e as Error).message }));
        return hit ?? this.fromRows([]);
      })
      .then((b) => (this.built = b))
      .finally(() => (this.loading = undefined));
    return this.loading;
  }

  /** Connections whose tool support is being probed (id@updated_at), so one probe runs per saved version. */
  private probed = new Set<string>();

  /**
   * A connection saved without a test (or saved again, which clears the result) has unknown tool support. Until it
   * is known the assistant fetches workspace data first and asks without tools (a small model offered tools it cannot
   * use answers from nothing); this asks the model once in the background and stores the answer.
   */
  private probeUnknown(rows: ConnectionRow[]) {
    for (const r of rows) {
      const key = `${r.id}@${new Date(r.updated_at).getTime()}`;
      if (r.tools_ok !== null || r.test_ok === false || this.probed.has(key)) continue;
      this.probed.add(key);
      let apiKey = "";
      try {
        apiKey = r.api_key_enc ? decryptSecret(r.api_key_enc) : "";
      } catch {
        continue;
      }
      void probeTools({ mode: r.mode, vendor: r.vendor, baseUrl: r.base_url, apiKey }, r.model_smart, undefined, 60_000)
        .then(async (ok) => {
          if (ok === null) return; // unreachable or timed out: keep "unknown" and try again after the next save
          await this.pool.query("UPDATE ai_connections SET tools_ok = $2 WHERE id = $1 AND tools_ok IS NULL", [r.id, ok]);
          this.invalidate();
          console.log(JSON.stringify({ msg: "ai.connection.tools_probed", id: r.id, tools: ok }));
        })
        .catch(() => undefined);
    }
  }

  /** After an admin saves a connection: the next call rebuilds. */
  invalidate() {
    this.built = undefined;
  }

  private fromRows(rows: ConnectionRow[]): Built {
    const backends: Record<string, ModelBackend> = { ...this.env.backends };
    const menu: MenuModel[] = [];
    const models: CatalogModel[] = [];
    for (const r of rows) {
      let apiKey = "";
      try {
        apiKey = r.api_key_enc ? decryptSecret(r.api_key_enc) : "";
      } catch {
        continue; // key unreadable (secret rotated): the admin page shows it; skip rather than fail every call
      }
      const backend = backendFor({ mode: r.mode, vendor: r.vendor, baseUrl: r.base_url, apiKey });
      // An admin switched this connection's own web tools off: its requests go without them.
      backends[connKey(r.id)] = r.web_tools === false ? { name: backend.name, call: (model, { web: _off, ...req }) => backend.call(model, req) } : backend;
      const label = r.name || VENDOR_LABEL[r.vendor];
      menu.push({ route: `${connKey(r.id)}:${r.model_smart}`, vendor: r.vendor, label, model: r.model_smart });
      models.push({ route: `${connKey(r.id)}:${r.model_smart}`, vendor: r.vendor, label, model: r.model_smart, tier: "smart" });
      if (r.model_fast && r.model_fast !== r.model_smart) models.push({ route: `${connKey(r.id)}:${r.model_fast}`, vendor: r.vendor, label, model: r.model_fast, tier: "fast" });
    }
    for (const v of Object.keys(this.env.backends).filter((x) => x !== "local")) {
      const d = DEFAULTS[v];
      menu.push({ route: `${v}:${d?.smart ?? ""}`, vendor: v, label: ENV_LABELS[v] ?? v, model: d?.smart ?? "" });
      models.push({ route: `${v}:${d?.smart ?? ""}`, vendor: v, label: ENV_LABELS[v] ?? v, model: d?.smart ?? "", tier: "smart" });
      if (d && d.fast !== d.smart) models.push({ route: `${v}:${d.fast}`, vendor: v, label: ENV_LABELS[v] ?? v, model: d.fast, tier: "fast" });
    }
    const def = rows.find((r) => r.is_default && backends[connKey(r.id)]) ?? rows.find((r) => backends[connKey(r.id)]);
    let config: GatewayConfig = this.env.config;
    if (def) {
      const route = (model: string): Route => ({ provider: connKey(def.id), model });
      const features = Object.fromEntries(Object.entries(this.env.config.features ?? {}).filter(([, r]) => !!backends[r.provider]));
      // A hosted or self-hosted model that fails degrades to the local extractive answer, as with env vendors.
      const fallback = (this.env.config.fallback ?? []).filter((r) => !!backends[r.provider] && r.provider !== "local");
      config = { fast: route(def.model_fast), smart: route(def.model_smart), features, fallback: [...fallback, { provider: "local", model: "local-extractive" }] };
    }
    // Unknown counts as "no tools" until the probe answers: fetching data first is safe with any model.
    const noTools = new Set(rows.filter((r) => r.tools_ok !== true).map((r) => connKey(r.id)));
    // What the tiers point at, named as the picker shows it (a connection's name, an env vendor's label).
    const named = (r: Route) => ({
      route: `${r.provider}:${r.model}`,
      model: r.model,
      label: rows.find((x) => connKey(x.id) === r.provider)?.name || ENV_LABELS[r.provider] || r.provider,
    });
    const defaults = config.smart.provider === "local" ? null : { fast: named(config.fast), smart: named(config.smart) };
    return { gw: new AiGateway(backends, config), menu, catalog: { models, defaults }, at: Date.now(), sig: signature(rows), noTools, main: def ? connKey(def.id) : null };
  }

  private envOnly?: Built;
  /** Before the first load completes: the env vendors alone. */
  private current(): Built {
    return this.built ?? (this.envOnly ??= this.fromRows([]));
  }

  /**
   * "local" when only the extractive fallback exists (runtime.ts then answers retrieval-first). In a request of
   * someone whose own AI answers, "device": an AI is there for them even when the company has none.
   */
  get name(): string {
    return personalNow() ? "device" : this.current().gw.name;
  }

  /**
   * Configured models for the assistant's menu, and what aiStatus counts as "configured". A person's own AI comes
   * first in their own requests, so it is what the composer picks unless they choose a company model.
   */
  menu(): MenuModel[] {
    const own = personalNow()?.ai;
    const menu = this.current().menu;
    if (!own) return menu;
    // One entry per model the AI offers on that computer (Claude Code: Opus, Sonnet, Haiku…), so it can be switched.
    const mine = personalModels(own).map((m) => ({
      route: `${PERSONAL}:${m || own.ai}`,
      vendor: "device",
      label: m && own.models?.length ? `${own.name ?? own.ai} · ${modelLabel(m)}` : own.label,
      model: m || own.ai,
    }));
    return [...mine, ...menu];
  }

  /**
   * In a request of someone whose own AI answers, "the default" is that AI (generate below asks it first for every
   * call without a company model picked), so the catalog names it: a workflow's step shows the model it will run on.
   */
  catalog(): ModelCatalog {
    const catalog = this.current().catalog;
    const own = personalNow()?.ai;
    if (!own) return catalog;
    const model = own.model || own.ai;
    const mine = { route: `${PERSONAL}:${model}`, model, label: own.label };
    return { models: catalog.models, defaults: { fast: mine, smart: mine } };
  }

  providers(): string[] {
    return this.current().gw.providers();
  }

  /**
   * Whether a call (on `route`, or the default) should offer tools: false when that connection's model was found
   * not to call them, so the assistant fetches data first and asks without tools.
   */
  toolsFor(route?: string): boolean {
    // A computer's AI answers with text only (DeviceBackend).
    if (personalNow() && (!route || isPersonal(route))) return false;
    if (isPersonal(route)) route = undefined;
    const b = this.current();
    const provider = route?.split(":")[0] ?? b.main;
    return !provider || !b.noTools.has(provider);
  }

  status() {
    return this.current().gw.status();
  }

  /**
   * The person's own AI first when the call is theirs, in their own request, and they did not pick a company model;
   * the company's AI when that computer does not answer (asleep, the AI closed, too slow).
   */
  async generate(req: ModelRequest): Promise<ModelResponse> {
    const own = personalNow();
    if (own && req.person === own.userId && (!req.route || isPersonal(req.route))) {
      try {
        const r = await new DeviceBackend(deviceUrl(own.userId, own.ai.device, own.ai.ai)).call(personalModelOf(own.ai, req.route), req);
        return { ...r, provider: "device" };
      } catch (e) {
        if (req.stream?.signal.aborted) throw e;
        req.stream?.reset();
        console.log(JSON.stringify({ msg: "ai.personal.fallback", feature: req.feature, error: (e as Error).message }));
      }
    }
    const { route, ...rest } = req;
    return (await this.ready()).gw.generate(isPersonal(route) ? rest : req);
  }
}
