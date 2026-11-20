import type { Request, Response } from "express";
import { logger } from "@workspace/service-kit";
import { callTool, TOOLS, toolsFor, type ToolContext } from "./mcp-tools.js";
import { listResources, PROMPTS, promptMessages, readResource, RESOURCE_TEMPLATES } from "./mcp-extras.js";

export { callTool };

/**
 * MCP endpoint (`/api/mcp`, Streamable HTTP): the gateway has already authenticated the caller (an OAuth token, an
 * API key or a session) and resolved their principal. Stateless: each POST builds a server for that caller, answers
 * with JSON and is done, so nothing is kept between requests. This module and the SDK are imported on the first MCP
 * request only, so they cost nothing at startup.
 */

const VERSION = "0.4.0";

type ListedTool = { name: string; title: string; description: string; inputSchema: Record<string, unknown>; annotations: Record<string, unknown> };
let toolList: Promise<ListedTool[]> | null = null;

/** JSON Schema of every tool's input, from the same zod schemas the modules parse (computed once). */
export function listTools() {
  toolList ??= import("@workspace/contracts/openapi").then(({ jsonSchema }) =>
    TOOLS.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: { type: "object", ...jsonSchema(t.input) },
      annotations: {
        title: t.title,
        readOnlyHint: t.readOnly,
        ...(t.readOnly ? {} : { destructiveHint: t.destructive === true, idempotentHint: t.idempotent === true }),
        openWorldHint: false,
      },
    })),
  );
  return toolList;
}

export async function handleMcp(req: Request, res: Response, ctx: ToolContext): Promise<void> {
  // Stateless server: no session to resume or stream, so only POST carries messages.
  if (req.method !== "POST") {
    res
      .status(405)
      .setHeader("allow", "POST")
      .json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: this MCP server is stateless, use POST" }, id: null });
    return;
  }
  const [{ Server }, { StreamableHTTPServerTransport }, types] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/index.js"),
    import("@modelcontextprotocol/sdk/server/streamableHttp.js"),
    import("@modelcontextprotocol/sdk/types.js"),
  ]);
  const server = new Server(
    { name: "workspace", version: VERSION },
    {
      capabilities: { tools: {}, prompts: {}, resources: {} },
      instructions:
        "workspace is the company's work-management app. Tools act as the signed-in person with the permissions they approved: tasks (read, create, update, comment), agent workflows (start a run on a task, follow what the agent does step by step, approve, send back, answer its questions), requests for approval, the calendar and meetings, projects, documents, whiteboards, chat channels, the people directory, 'my day', search, team workload and AI Insights aggregates. Tasks, projects, documents, requests and meetings take an id or the code shown in the app (WEB-42, D-012, YC-007, H-012). Dates are ISO 8601 with an offset. Ask before posting chat messages, deciding a request or a run, or changing other people's work: it is recorded under the person's name.",
    },
  );
  server.setRequestHandler(types.ListToolsRequestSchema, async () => ({ tools: toolsFor(await listTools(), ctx.principal) }));
  server.setRequestHandler(types.CallToolRequestSchema, async (r) => callTool(r.params.name, r.params.arguments, ctx));
  server.setRequestHandler(types.ListPromptsRequestSchema, async () => ({
    prompts: PROMPTS.map(({ name, title, description, arguments: a }) => ({ name, title, description, arguments: a })),
  }));
  server.setRequestHandler(types.GetPromptRequestSchema, async (r) => promptMessages(r.params.name, r.params.arguments ?? {}));
  server.setRequestHandler(types.ListResourcesRequestSchema, async () => ({ resources: await listResources(ctx) }));
  server.setRequestHandler(types.ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: RESOURCE_TEMPLATES }));
  server.setRequestHandler(types.ReadResourceRequestSchema, async (r) => readResource(r.params.uri, ctx));
  // No sessionIdGenerator: stateless, one transport per request.
  const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    // The SDK's own types disagree under exactOptionalPropertyTypes (sessionId?: string vs string | undefined).
    await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    logger.error({ err }, "mcp request failed");
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
  }
}
