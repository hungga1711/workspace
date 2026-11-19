import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Param, Post, Put, Req } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { appendToOutbox, authorize, newId, recordAudit, withTransaction, type Principal } from "@workspace/shared";
import { assertAllowed, parse, requirePrincipal } from "@workspace/service-kit";
import { DEPS } from "./ai.controller.js";
import { policyOf } from "./activity.js";
import { CONNECTION_COLS, connectionDto, isPrivateHost, type ConnectionRow } from "./connections.js";
import { claimJob, deviceKey, deviceOnline, deviceUrl, finishJob, parseDeviceUrl, partJob, touchDevice } from "./device-hub.js";
import { detectSensitive, redactWithCounts, type Sensitive } from "./insight.js";
import { keywordsOf } from "./monitor-intake.js";
import { choiceOf, forgetPersonal, usable } from "./personal-ai.js";
import type { Deps } from "./runtime.js";
import { aiFlags } from "./status.js";
import { PERSONAL, WorkspaceGateway } from "./workspace-gateway.js";

/**
 * The AI on people's own computers, in one place (AI › Connect, Admin › AI). workspace-connect.mjs runs there, finds
 * the AI that is installed (command-line agents such as Claude Code or Codex, local model servers such as Ollama or
 * LM Studio) and reports here; from then on that computer
 *
 *   1. runs the person's agent workflows            (work module: runner/claim, unchanged)
 *   2. answers questions for the assistant          (its owner's own questions when they chose its AI: personal-ai.ts;
 *                                                    everyone's when an admin chose it: a "device" connection)
 *   3. sends token counts                           (local-usage.ts, unchanged)
 *   4. checks text against the company's rules      (`local/guard` below) before it goes to an AI outside the computer
 *
 * Nothing here needs a model: the rules are the same patterns the browser extension applies (insight.ts).
 */

/** Where model servers usually listen, seen from the workspace server: its own machine, and the Docker host. */
export const LOCAL_SERVERS = [
  { id: "ollama", name: "Ollama", port: 11434 },
  { id: "lmstudio", name: "LM Studio", port: 1234 },
  { id: "jan", name: "Jan", port: 1337 },
  { id: "llamacpp", name: "llama.cpp / LocalAI", port: 8080 },
  { id: "gpt4all", name: "GPT4All", port: 4891 },
  { id: "vllm", name: "vLLM", port: 8000 },
] as const;
const LOCAL_HOSTS = ["127.0.0.1", "host.docker.internal"];

const Found = z.object({
  id: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(60),
  kind: z.enum(["agent", "server"]),
  cloud: z.boolean().default(false),
  hook: z.boolean().optional(),
  logs: z.boolean().optional(),
  models: z.array(z.string().max(120)).max(40).optional(),
});
type Found = z.infer<typeof Found>;
const device = z.string().trim().min(1).max(80);

/** Words for the kinds, in English: the connect program prints them in a terminal. */
const KIND_WORDS: Record<Sensitive, string> = {
  personal_id: "an ID or passport number",
  card: "a card number",
  secret: "a password or API key",
  contacts: "a contact list",
  bank_account: "bank details",
  keyword: "a word your company protects",
};

interface DeviceRow {
  user_id: string;
  device: string;
  os: string;
  version: string;
  found: Found[];
  state: Record<string, unknown>;
  prefer: string;
  key_prefix: string;
  first_at: Date;
  last_seen_at: Date | null;
  last_sync_at: Date;
}
const DEVICE_COLS = "user_id, device, os, version, found, state, prefer, key_prefix, first_at, last_seen_at, last_sync_at";
/** A computer counts as connected while its program said so in the last three minutes (it does every minute). */
const online = (r: DeviceRow) => deviceOnline(deviceKey(r.user_id, r.device)) || (!!r.last_seen_at && Date.now() - new Date(r.last_seen_at).getTime() < 180_000);
const deviceDto = (r: DeviceRow) => ({
  device: r.device,
  os: r.os,
  online: online(r),
  lastSeenAt: r.last_seen_at,
  firstAt: r.first_at,
  found: r.found ?? [],
  state: { workflow: r.state?.workflow === true, usage: r.state?.usage === true, guard: r.state?.guard === true },
  prefer: r.prefer,
  keyPrefix: r.key_prefix,
});

/** The company's own connections by name, without my own AI (which the gateway lists first in my requests). */
const companyAi = (d: Deps) =>
  ((d.provider as { menu?: () => { route: string; label: string }[] }).menu?.() ?? []).filter((m) => !m.route.startsWith(`${PERSONAL}:`)).map((m) => m.label);

function person(req: Request): Principal {
  const p = requirePrincipal(req);
  if (p.type !== "user") throw new ForbiddenException("people only");
  return p;
}

@Controller()
export class LocalConnectController {
  constructor(@Inject(DEPS) private readonly d: Deps) {}

  /** The connect program, every minute: "I am here, this is what I found". Answers what its owner chose for it. */
  @Post("local/connect/heartbeat")
  @HttpCode(200)
  async heartbeat(@Req() req: Request, @Body() body: unknown) {
    const p = person(req);
    const b = parse(
      z.object({
        device,
        os: z.string().max(20).default(""),
        version: z.string().max(20).default(""),
        found: z.array(Found).max(30).default([]),
        state: z.object({ workflow: z.boolean().optional(), usage: z.boolean().optional(), guard: z.boolean().optional() }).passthrough().default({}),
        // "wos_<prefix>_…": the prefix is public (shown in the key list) and names the key this computer signs in with.
        keyPrefix: z
          .string()
          .regex(/^[a-f0-9]{8}$/)
          .optional(),
        /** `--status`: only checks the code, changes nothing. */
        probe: z.boolean().optional(),
      }),
      body,
    );
    // Both AI switches off (Admin › AI): there is nothing for a computer to connect to.
    const flags = await aiFlags(this.d);
    if (!flags.assistant && !flags.monitoring) throw new ForbiddenException({ error: "ai_off", message: "AI is switched off for this workspace." });
    if (b.probe) return { ok: true };
    touchDevice(deviceKey(p.id, b.device));
    const prefix = b.keyPrefix ?? "";
    const row = await withTransaction(this.d.pool, async (c) => {
      const r = await c.query<{ prefer: string }>(
        `INSERT INTO ai_local_devices (user_id, device, os, version, found, state, key_prefix, last_seen_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, now())
         ON CONFLICT (user_id, device) DO UPDATE SET os = EXCLUDED.os, version = EXCLUDED.version, found = EXCLUDED.found, state = EXCLUDED.state,
           key_prefix = CASE WHEN EXCLUDED.key_prefix <> '' THEN EXCLUDED.key_prefix ELSE ai_local_devices.key_prefix END, last_seen_at = now()
         RETURNING prefer`,
        [p.id, b.device, b.os, b.version, JSON.stringify(b.found), JSON.stringify({ workflow: !!b.state.workflow, usage: !!b.state.usage, guard: !!b.state.guard }), prefix],
      );
      return { prefer: r.rows[0]?.prefer ?? "", policy: await policyOf(c) };
    });
    return { ok: true, prefer: row.prefer, sensitiveMode: row.policy.sensitiveMode, monitoring: flags.monitoring };
  }

  /** The connect program's open request: the next question for this computer's AI, or nothing after 25 seconds. */
  @Post("local/connect/jobs/claim")
  @HttpCode(200)
  async claim(@Req() req: Request, @Body() body: unknown) {
    const p = person(req);
    const b = parse(z.object({ device }), body);
    return { job: await claimJob(deviceKey(p.id, b.device), 25_000) };
  }

  /** The answer so far, while the computer's AI writes it (a job with `stream`). `stop`: the person pressed stop. */
  @Post("local/connect/jobs/:id/part")
  @HttpCode(200)
  part(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    person(req);
    const b = parse(z.object({ text: z.string().max(200_000) }), body);
    return partJob(id, b.text);
  }

  @Post("local/connect/jobs/:id")
  @HttpCode(200)
  async result(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    person(req);
    const b = parse(
      z.object({
        text: z.string().max(200_000).optional(),
        error: z.string().max(1000).optional(),
        model: z.string().max(120).optional(),
        usage: z.object({ input: z.number().int().min(0).max(1e9), output: z.number().int().min(0).max(1e9) }).nullish(),
        // The agent's own web tools it used (newer connect programs report them), shown as the answer's steps.
        tools: z
          .array(z.object({ name: z.string().max(40), input: z.record(z.unknown()).default({}) }))
          .max(50)
          .optional(),
        // The pages its web tools found or read, cited with the answer (web addresses only).
        pages: z
          .array(
            z.object({
              url: z
                .string()
                .max(2000)
                .regex(/^https?:\/\//i),
              title: z.string().max(300),
            }),
          )
          .max(20)
          .optional(),
      }),
      body,
    );
    // The id is unguessable and known only to the computer that claimed the job.
    return { ok: finishJob(id, b) };
  }

  /** AI › Connect: my computers and what each found, the company's rule for sensitive data, my extension. */
  @Get("local/connect")
  async mine(@Req() req: Request) {
    const p = person(req);
    const flags = await aiFlags(this.d);
    return withTransaction(this.d.pool, async (c) => {
      const devices = (await c.query<DeviceRow>(`SELECT ${DEVICE_COLS} FROM ai_local_devices WHERE user_id = $1 AND last_seen_at IS NOT NULL ORDER BY last_seen_at DESC`, [p.id]))
        .rows;
      const ext = (await c.query<{ created_at: Date; last_seen_at: Date | null }>("SELECT created_at, last_seen_at FROM ai_monitor_tokens WHERE user_id = $1", [p.id])).rows[0];
      const usage = (await c.query<{ at: Date | null }>("SELECT max(updated_at) AS at FROM ai_local_usage WHERE user_id = $1", [p.id])).rows[0];
      const answers = (await c.query<ConnectionRow>(`SELECT ${CONNECTION_COLS} FROM ai_connections WHERE enabled AND mode = 'device'`)).rows
        .map((r) => parseDeviceUrl(r.base_url))
        .filter((x) => x?.userId === p.id)
        .map((x) => ({ device: x!.device, ai: x!.ai }));
      const policy = await policyOf(c);
      const chosen = (await c.query<{ device: string; ai: string; model: string }>("SELECT device, ai, model FROM ai_personal_choice WHERE user_id = $1", [p.id])).rows[0];
      const choice = await choiceOf(this.d.pool, p.id);
      return {
        devices: devices.map(deviceDto),
        sensitiveMode: policy.sensitiveMode,
        monitoring: flags.monitoring,
        assistant: flags.assistant,
        extension: ext ? { createdAt: ext.created_at, lastSeenAt: ext.last_seen_at } : null,
        usageAt: usage?.at ?? null,
        /** My computers whose AI answers for the company's assistant. */
        answers,
        /** May choose a computer's AI for the assistant (Admin › AI). */
        canManage: authorize(p, "ai.agent.manage").allowed,
        /**
         * My own AI for my own questions: what I chose (null: the company's), whether the company allows it, and
         * whether it answers right now (the computer is on and the AI still there); otherwise the company's AI does.
         */
        personal: { allowed: policy.allowPersonalAi, choice: chosen ?? null, active: usable(p.id, choice), company: companyAi(this.d) },
      };
    });
  }

  /** My own AI: one found on one of my connected computers answers my own questions instead of the company's. */
  @Put("local/connect/personal")
  async choose(@Req() req: Request, @Body() body: unknown) {
    const p = person(req);
    const b = parse(z.object({ device, ai: z.string().trim().min(1).max(40), model: z.string().trim().max(120).optional() }), body);
    return withTransaction(this.d.pool, async (c) => {
      if (!(await policyOf(c)).allowPersonalAi) throw new ForbiddenException({ error: "personal_ai_off", message: "The company keeps everyone on its own AI." });
      const dev = (await c.query<DeviceRow>(`SELECT ${DEVICE_COLS} FROM ai_local_devices WHERE user_id = $1 AND device = $2 AND last_seen_at IS NOT NULL`, [p.id, b.device]))
        .rows[0];
      const found = dev?.found?.find((f) => f.id === b.ai);
      if (!dev || !found) throw new NotFoundException("that AI is not on one of your connected computers");
      // A model server answers with one of its models; a command-line agent with its own.
      const model = found.kind === "server" ? b.model || found.models?.[0] || "" : "";
      if (found.kind === "server" && (!model || !found.models?.includes(model)))
        throw new BadRequestException({ error: "invalid", issues: [{ path: "model", message: model ? "unknown model" : `${found.name} has no model loaded` }] });
      await c.query(
        `INSERT INTO ai_personal_choice (user_id, device, ai, model) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id) DO UPDATE SET device = EXCLUDED.device, ai = EXCLUDED.ai, model = EXCLUDED.model, updated_at = now()`,
        [p.id, b.device, b.ai, model],
      );
      forgetPersonal(p.id);
      return { choice: { device: b.device, ai: b.ai, model } };
    });
  }

  /** Back to the company's AI. */
  @Delete("local/connect/personal")
  @HttpCode(204)
  async unchoose(@Req() req: Request) {
    const p = person(req);
    await this.d.pool.query("DELETE FROM ai_personal_choice WHERE user_id = $1", [p.id]);
    forgetPersonal(p.id);
  }

  /** Which AI workflows use on one of my computers ("" = the first one found). */
  @Put("local/connect/devices/:device")
  async prefer(@Req() req: Request, @Param("device") name: string, @Body() body: unknown) {
    const p = person(req);
    const b = parse(z.object({ prefer: z.string().trim().max(160) }), body);
    const r = await this.d.pool.query("UPDATE ai_local_devices SET prefer = $3 WHERE user_id = $1 AND device = $2", [p.id, name, b.prefer]);
    if (!r.rowCount) throw new NotFoundException("computer not found");
    return { ok: true };
  }

  /**
   * Forgets one of my computers as a connected one (its token counts stay; Usage removes those). The web revokes
   * the key it signed in with, which is what actually stops the program there.
   */
  @Delete("local/connect/devices/:device")
  @HttpCode(204)
  async forget(@Req() req: Request, @Param("device") name: string) {
    const p = person(req);
    await withTransaction(this.d.pool, async (c) => {
      await c.query("UPDATE ai_local_devices SET last_seen_at = NULL, found = '[]'::jsonb, state = '{}'::jsonb, prefer = '' WHERE user_id = $1 AND device = $2", [p.id, name]);
      // Its AI can no longer answer for the assistant, nor for me.
      await c.query("DELETE FROM ai_connections WHERE mode = 'device' AND left(base_url, length($1)) = $1", [deviceUrl(p.id, name, "x").slice(0, -1)]);
      await c.query("DELETE FROM ai_personal_choice WHERE user_id = $1 AND device = $2", [p.id, name]);
    });
    forgetPersonal(p.id);
    if (this.d.provider instanceof WorkspaceGateway) this.d.provider.invalidate();
  }

  /**
   * The safety net for AI that is not in a browser: what to do with a text before it goes to an AI outside the
   * computer (a prompt typed in Claude Code, a workflow step handed to a cloud agent). The same rules and the same
   * company setting as the extension (warn, redact, block), counted the same way; the text itself is never stored.
   */
  @Post("local/guard")
  @HttpCode(200)
  async guard(@Req() req: Request, @Body() body: unknown) {
    const p = person(req);
    const b = parse(z.object({ tool: z.string().trim().max(40).default("local"), text: z.string().max(60_000) }), body);
    // AI Insights switched off: the company records and checks nothing.
    if (!(await aiFlags(this.d)).monitoring) return { action: "allow" as const, kinds: [] };
    return withTransaction(this.d.pool, async (c) => {
      const keywords = await keywordsOf(c);
      const kinds = detectSensitive(b.text, keywords);
      if (!kinds.length) return { action: "allow" as const, kinds };
      const mode = (await policyOf(c)).sensitiveMode;
      const redacted = mode === "redact" ? redactWithCounts(b.text, keywords) : null;
      const count = redacted
        ? Math.max(
            1,
            Object.values(redacted.counts).reduce((s, n) => s + (n ?? 0), 0),
          )
        : 1;
      await c.query("INSERT INTO ai_safety_events (id, user_id, source, action, kinds, count, at) VALUES ($1, $2, 'local', $3, $4, $5, now())", [
        newId(),
        p.id,
        mode,
        kinds,
        count,
      ]);
      return {
        // "warn" in a browser asks "send anyway?"; a terminal hook cannot ask, so the text goes and the warning is counted.
        action: mode === "warn" ? ("allow" as const) : mode,
        warned: mode === "warn",
        kinds,
        names: kinds.map((k) => KIND_WORDS[k]).join(", "),
        ...(redacted ? { text: redacted.text } : {}),
      };
    });
  }

  // ---------------------------------------------------------------- admins

  private admin(req: Request): Principal {
    const p = person(req);
    assertAllowed(p, "ai.agent.manage");
    return p;
  }

  /** Admin › AI: how many people connected a computer, what was found across them, and my own computers' AI. */
  @Get("local/connect/overview")
  async overview(@Req() req: Request) {
    const p = this.admin(req);
    return withTransaction(this.d.pool, async (c) => {
      const rows = (await c.query<DeviceRow>(`SELECT ${DEVICE_COLS} FROM ai_local_devices WHERE last_seen_at IS NOT NULL`)).rows;
      const live = rows.filter(online);
      const kinds = new Map<string, { id: string; name: string; kind: string; computers: number }>();
      for (const r of live)
        for (const f of r.found ?? []) {
          const k = kinds.get(f.id) ?? { id: f.id, name: f.name, kind: f.kind, computers: 0 };
          k.computers++;
          kinds.set(f.id, k);
        }
      const ext = (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM ai_monitor_tokens WHERE last_seen_at > now() - interval '14 days'")).rows[0]?.n ?? 0;
      const usage = (await c.query<{ n: number }>("SELECT count(DISTINCT user_id)::int AS n FROM ai_local_usage WHERE updated_at > now() - interval '14 days'")).rows[0]?.n ?? 0;
      const answering = (await c.query<ConnectionRow>(`SELECT ${CONNECTION_COLS} FROM ai_connections WHERE mode = 'device'`)).rows.map((r) => ({
        ...connectionDto(r),
        at: parseDeviceUrl(r.base_url),
        online: (() => {
          const at = parseDeviceUrl(r.base_url);
          return !!at && deviceOnline(deviceKey(at.userId, at.device));
        })(),
      }));
      return {
        computers: { connected: rows.length, online: live.length, people: new Set(live.map((r) => r.user_id)).size },
        workflow: live.filter((r) => r.state?.workflow === true).length,
        guard: live.filter((r) => r.state?.guard === true).length,
        usagePeople: usage,
        extensionPeople: ext,
        found: [...kinds.values()].sort((a, b) => b.computers - a.computers),
        sensitiveMode: (await policyOf(c)).sensitiveMode,
        /** People answering their own questions with their own computer's AI, and whether the company allows it. */
        personal: {
          allowed: (await policyOf(c)).allowPersonalAi,
          people: (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM ai_personal_choice")).rows[0]?.n ?? 0,
        },
        /** My own computers: only an admin's own AI may answer for everyone (their questions go to that machine). */
        mine: rows.filter((r) => r.user_id === p.id).map(deviceDto),
        answering,
      };
    });
  }

  /**
   * Whether people may answer their own questions with the AI on their own computer. Off, everyone uses the company's
   * connection; their choices are kept for when it is turned on again.
   */
  @Put("local/connect/personal-policy")
  async personalPolicy(@Req() req: Request, @Body() body: unknown) {
    const p = person(req);
    assertAllowed(p, "ai.policy.manage");
    const b = parse(z.object({ allow: z.boolean() }), body);
    await withTransaction(this.d.pool, async (c) => {
      const prev = (await policyOf(c)).allowPersonalAi;
      await c.query(
        `INSERT INTO ai_policy (allow_personal_ai, updated_by) VALUES ($1, $2)
         ON CONFLICT (singleton) DO UPDATE SET allow_personal_ai = EXCLUDED.allow_personal_ai, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [b.allow, p.id],
      );
      if (prev !== b.allow)
        await recordAudit(c, { action: "ai.policy.changed", targetType: "ai_policy", targetId: "workspace", changes: { personalAi: { from: prev, to: b.allow } } });
    });
    forgetPersonal();
    return { allow: b.allow };
  }

  /**
   * One click: "use this computer's AI for the assistant". Only the admin's own computer, because everyone's
   * questions will be sent to it; the choice is written to the audit log like any other connection.
   */
  @Post("local/connect/use")
  async use(@Req() req: Request, @Body() body: unknown) {
    const p = this.admin(req);
    const b = parse(z.object({ device, ai: z.string().trim().min(1).max(40), model: z.string().trim().max(120).optional() }), body);
    return withTransaction(this.d.pool, async (c) => {
      const dev = (await c.query<DeviceRow>(`SELECT ${DEVICE_COLS} FROM ai_local_devices WHERE user_id = $1 AND device = $2 AND last_seen_at IS NOT NULL`, [p.id, b.device]))
        .rows[0];
      const found = dev?.found?.find((f) => f.id === b.ai);
      if (!dev || !found) throw new NotFoundException("that AI is not on one of your connected computers");
      const model = found.kind === "server" ? b.model || found.models?.[0] : b.ai;
      if (!model) throw new BadRequestException({ error: "invalid", issues: [{ path: "model", message: `${found.name} has no model loaded` }] });
      if (found.kind === "server" && b.model && !found.models?.includes(b.model))
        throw new BadRequestException({ error: "invalid", issues: [{ path: "model", message: "unknown model" }] });
      const url = deviceUrl(p.id, b.device, b.ai);
      const first = !(await c.query("SELECT 1 FROM ai_connections LIMIT 1")).rowCount;
      await c.query("DELETE FROM ai_connections WHERE mode = 'device' AND base_url = $1", [url]);
      const row = (
        await c.query<ConnectionRow>(
          `INSERT INTO ai_connections (id, mode, vendor, name, base_url, model_fast, model_smart, is_default, enabled, created_by, tools_ok)
           VALUES ($1, 'device', 'device', $2, $3, $4, $4, $5, true, $6, false) RETURNING ${CONNECTION_COLS}`,
          [newId(), `${found.name} · ${b.device}`.slice(0, 80), url, model, first, p.id],
        )
      ).rows[0]!;
      await appendToOutbox(c, {
        eventId: newId(),
        eventType: "ai.connection.created.v1" as const,
        version: 1,
        aggregateType: "ai.connection",
        aggregateId: row.id,
        actorId: `user:${p.id}`,
        occurredAt: new Date().toISOString(),
        payload: { id: row.id, mode: row.mode, vendor: row.vendor, name: row.name },
      });
      if (this.d.provider instanceof WorkspaceGateway) this.d.provider.invalidate();
      return { connection: connectionDto(row) };
    });
  }

  /**
   * Model servers the workspace server can reach on its own machine (or the Docker host): found, not typed. Each
   * comes back with its address and models, ready for one click (`POST connections`, mode selfhost).
   */
  @Get("connections/discover")
  async discover(@Req() req: Request) {
    this.admin(req);
    const known = new Set(
      (await this.d.pool.query<{ base_url: string | null }>("SELECT base_url FROM ai_connections WHERE mode = 'selfhost'")).rows.flatMap((r) => {
        try {
          return r.base_url ? [new URL(r.base_url).port] : [];
        } catch {
          return [];
        }
      }),
    );
    const found = await Promise.all(
      LOCAL_SERVERS.map(async (s) => {
        for (const host of LOCAL_HOSTS) {
          const baseUrl = `http://${host}:${s.port}/v1`;
          if (!isPrivateHost(host)) continue;
          const models = await probeModels(baseUrl);
          if (models.length) return { id: s.id, name: s.name, baseUrl, models, connected: known.has(String(s.port)) };
        }
        return null;
      }),
    );
    return { servers: found.filter((x) => x !== null) };
  }
}

/** The chat models an OpenAI-compatible server lists; [] when nothing answers there within a second. */
export async function probeModels(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  try {
    const r = await fetchImpl(`${baseUrl}/models`, { signal: AbortSignal.timeout(1200) });
    if (!r.ok) return [];
    const body = (await r.json()) as { data?: { id?: unknown }[] };
    return (body.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string" && !/embed/i.test(id))
      .slice(0, 40);
  } catch {
    return [];
  }
}
