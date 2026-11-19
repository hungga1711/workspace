import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { API_VERSION, PUBLIC_API, type ApiOperation } from "./public-api.js";

/**
 * OpenAPI 3.1 document of the public API, built from PUBLIC_API. Kept in its own entry point
 * (`@workspace/contracts/openapi`) so code that only needs the schemas never loads the JSON Schema converter.
 */

type Json = Record<string, unknown>;

/** Request bodies are what a client sends: fields with a default are optional for them. */
export function jsonSchema(schema: z.ZodTypeAny, io: "input" | "output" = "input"): Json {
  const out = zodToJsonSchema(schema, { $refStrategy: "none", effectStrategy: io === "input" ? "input" : "any", pipeStrategy: io }) as Json;
  delete out.$schema;
  return out;
}

function parameters(op: ApiOperation): Json[] {
  const list: Json[] = [];
  for (const [where, obj] of [
    ["path", op.params],
    ["query", op.query],
  ] as const) {
    if (!obj) continue;
    const s = jsonSchema(obj) as { properties?: Record<string, Json>; required?: string[] };
    for (const [name, prop] of Object.entries(s.properties ?? {})) {
      const { description, ...schema } = prop;
      list.push({ name, in: where, required: where === "path" || (s.required ?? []).includes(name), schema, ...(description ? { description } : {}) });
    }
  }
  return list;
}

/** Every refusal has this shape; `error` is a stable word to branch on, `message` is for people (or a list of field problems). */
const errorSchema: Json = {
  type: "object",
  required: ["error"],
  properties: {
    error: { type: "string", description: "A stable reason: not_found, conflict, invalid, rate limit exceeded, feature_off…" },
    message: { description: "For people: a sentence, or a list of what is wrong with the request's fields", oneOf: [{ type: "string" }, { type: "array", items: {} }] },
    requestId: { type: "string", description: "Quote it when asking for help: every log line of the call carries it" },
  },
};

export function buildOpenApi(version: string = API_VERSION): Json {
  const paths: Record<string, Record<string, Json>> = {};
  for (const op of PUBLIC_API) {
    const status = String(op.status ?? (op.method === "POST" && op.operationId.startsWith("create") ? 201 : 200));
    const entry: Json = {
      operationId: op.operationId,
      tags: [op.tag],
      summary: op.summary,
      ...(op.description || op.permission ? { description: [op.description, op.permission ? `Permission: \`${op.permission}\`.` : null].filter(Boolean).join("\n\n") } : {}),
      parameters: [...parameters(op), ...(op.method === "POST" ? [{ $ref: "#/components/parameters/IdempotencyKey" }] : [])],
      ...(op.body ? { requestBody: { required: true, content: { "application/json": { schema: jsonSchema(op.body) } } } } : {}),
      responses: {
        ...(status === "204"
          ? { "204": { description: "Done, no body" } }
          : { [status]: { description: "OK", content: { "application/json": { schema: jsonSchema(op.response, "output") } } } }),
        "400": { $ref: "#/components/responses/Error" },
        "401": { $ref: "#/components/responses/Error" },
        "403": { $ref: "#/components/responses/Error" },
        "404": { $ref: "#/components/responses/Error" },
        ...(op.method === "GET" ? {} : { "409": { $ref: "#/components/responses/Error" }, "422": { $ref: "#/components/responses/Error" } }),
        "429": { $ref: "#/components/responses/RateLimited" },
      },
    };
    (paths[op.path] ??= {})[op.method.toLowerCase()] = entry;
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "workspace API",
      version,
      license: { name: "MIT", identifier: "MIT" },
      description:
        "The public HTTP API of a workspace installation. Authenticate with `Authorization: Bearer wos_…` (an API key from Admin › Integrations; a personal key acts as the person who made it) or a signed-in session token. Every call is checked against the caller's permissions, exactly as in the web app. The same operations are available to AI agents through the MCP endpoint `/api/mcp` (docs/integrations/mcp.md).",
    },
    servers: [{ url: "/", description: "This installation (APP_URL)" }],
    security: [{ bearer: [] }],
    tags: [...new Set(PUBLIC_API.map((o) => o.tag))].map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer", description: "A workspace API key (wos_…) or a session access token" } },
      parameters: {
        IdempotencyKey: {
          name: "Idempotency-Key",
          in: "header",
          required: false,
          schema: { type: "string", minLength: 8, maxLength: 128 },
          description:
            "API keys only. A retry with the same key and the same body within 24 hours answers what the first call answered (header `Idempotency-Replayed: true`) instead of doing the work twice; the same key with another body is a 422.",
        },
      },
      headers: {
        "RateLimit-Limit": { schema: { type: "integer" }, description: "Requests allowed per minute for this credential" },
        "RateLimit-Remaining": { schema: { type: "integer" }, description: "Requests left in the current minute" },
        "RateLimit-Reset": { schema: { type: "integer" }, description: "Seconds until the count starts again" },
      },
      responses: {
        Error: {
          description: "Error",
          content: { "application/json": { schema: errorSchema } },
        },
        RateLimited: {
          description: "Too many requests for this credential: wait `Retry-After` seconds",
          headers: { "Retry-After": { schema: { type: "integer" }, description: "Seconds to wait" } },
          content: { "application/json": { schema: errorSchema } },
        },
      },
    },
  };
}
