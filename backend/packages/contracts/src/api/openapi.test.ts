import { describe, expect, it } from "vitest";
import { buildOpenApi } from "./openapi.js";
import { PUBLIC_API } from "./public-api.js";
import { taskCreateBody } from "./work.js";

describe("public API document", () => {
  it("has unique operation ids and one entry per method and path", () => {
    expect(new Set(PUBLIC_API.map((o) => o.operationId)).size).toBe(PUBLIC_API.length);
    expect(new Set(PUBLIC_API.map((o) => `${o.method} ${o.path}`)).size).toBe(PUBLIC_API.length);
  });

  it("declares every {param} of a path", () => {
    for (const op of PUBLIC_API) {
      const names = [...op.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      expect(Object.keys(op.params?.shape ?? {}).sort(), op.operationId).toEqual(names.sort());
    }
  });

  it("marks only fields without a default as required in request bodies", () => {
    const doc = buildOpenApi("0.0.0") as { paths: Record<string, Record<string, { requestBody?: { content: Record<string, { schema: { required?: string[] } }> } }>> };
    expect(doc.paths["/api/work/tasks"]!.post!.requestBody!.content["application/json"]!.schema.required).toEqual(["title"]);
    expect(doc.paths["/api/work/tasks/{id}"]!.patch!.requestBody!.content["application/json"]!.schema.required).toEqual(["expectedVersion"]);
    // The body the modules parse fills those defaults in.
    expect(taskCreateBody.parse({ title: "x" })).toMatchObject({ priority: "medium", labels: [], projectId: null });
  });
});

describe("what the document says about every operation", () => {
  type Op = { parameters: { $ref?: string; name?: string }[]; responses: Record<string, { $ref?: string; content?: unknown }> };
  const doc = buildOpenApi("0.0.0") as { paths: Record<string, Record<string, Op>>; components: { responses: Record<string, { headers?: object }>; parameters: object } };

  it("a POST takes an Idempotency-Key; a 429 says how long to wait", () => {
    const start = doc.paths["/api/work/tasks/{id}/runs"]!.post!;
    expect(start.parameters.some((p) => p.$ref === "#/components/parameters/IdempotencyKey")).toBe(true);
    expect(doc.paths["/api/work/tasks"]!.get!.parameters.some((p) => p.$ref)).toBe(false);
    expect(start.responses["429"]).toEqual({ $ref: "#/components/responses/RateLimited" });
    expect(doc.components.responses.RateLimited!.headers).toHaveProperty("Retry-After");
  });

  it("answers with the status the route really gives: 201 for what it creates, 204 for nothing to say", () => {
    expect(Object.keys(doc.paths["/api/work/tasks/{id}/runs"]!.post!.responses)).toContain("201");
    const decide = doc.paths["/api/work/approvals/{id}/decision"]!.post!.responses;
    expect(decide["204"]).toEqual({ description: "Done, no body" });
    expect(decide["200"]).toBeUndefined();
  });

  it("covers workflows and their runs, approvals and the calendar", () => {
    const ids = PUBLIC_API.map((o) => o.operationId);
    expect(ids).toEqual(expect.arrayContaining(["listWorkflows", "startRun", "getRun", "runActivity", "approveRun", "reworkRun", "answerRunQuestions", "cancelRun"]));
    expect(ids).toEqual(expect.arrayContaining(["listApprovals", "getApproval", "createApproval", "decideApproval", "listCalendarEvents", "createCalendarEvent", "getMeeting"]));
  });
});
