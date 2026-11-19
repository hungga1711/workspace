import { describe, expect, it } from "vitest";
import type { Principal } from "@workspace/shared";
import type { ToolContext } from "./tools.js";
import { answerServices } from "./workspace-kit.js";

const who = (id: string) => ({ type: "user", id, teamIds: [], departmentId: null, grants: [] }) as unknown as Principal;

/** A fake module client that counts its calls and can be told to fail the next one. */
function client() {
  const calls: string[] = [];
  let fail = false;
  return {
    calls,
    failNext: () => (fail = true),
    request: async (method: string, path: string, _body?: unknown, as?: Principal) => {
      calls.push(`${method} ${path} ${as?.id ?? ""}`);
      if (fail) {
        fail = false;
        throw new Error("down");
      }
      return { path };
    },
  };
}

describe("answerServices", () => {
  it("reads the directory once per person for one answer, and nothing else from the memo", async () => {
    const employee = client();
    const services = answerServices({ employee, chat: client(), work: client() } as unknown as ToolContext["services"]);
    await Promise.all([
      services.employee.request("GET", "/employees?all=1", undefined, who("a")),
      services.employee.request("GET", "/employees?all=1", undefined, who("a")),
      services.employee.request("GET", "/employees?all=1", undefined, who("b")),
    ]);
    await services.employee.request("GET", "/me/reports", undefined, who("a"));
    await services.employee.request("GET", "/me/reports", undefined, who("a"));
    await services.employee.request("POST", "/departments", {}, who("a"));
    expect(employee.calls).toEqual(["GET /employees?all=1 a", "GET /employees?all=1 b", "GET /me/reports a", "GET /me/reports a", "POST /departments a"]);
  });

  it("does not keep a failed read: the next tool asks again", async () => {
    const employee = client();
    const services = answerServices({ employee, chat: client(), work: client() } as unknown as ToolContext["services"]);
    employee.failNext();
    await expect(services.employee.request("GET", "/departments", undefined, who("a"))).rejects.toThrow("down");
    await expect(services.employee.request("GET", "/departments", undefined, who("a"))).resolves.toEqual({ path: "/departments" });
    expect(employee.calls).toHaveLength(2);
  });

  it("a new answer reads afresh", async () => {
    const employee = client();
    const base = { employee, chat: client(), work: client() } as unknown as ToolContext["services"];
    await answerServices(base).employee.request("GET", "/employees?all=1", undefined, who("a"));
    await answerServices(base).employee.request("GET", "/employees?all=1", undefined, who("a"));
    expect(employee.calls).toHaveLength(2);
  });
});
