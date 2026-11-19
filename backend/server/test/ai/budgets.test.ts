import { beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { migrate } from "@workspace/service-kit";
import { newId, runWithContext, withTransaction } from "@workspace/shared";
import {
  assertBudget,
  BudgetExceeded,
  costUsd,
  firstExceeded,
  listBudgets,
  percentUsed,
  reached,
  recordUsage,
  setBudget,
  type Budget,
  type UsageRecord,
} from "../../src/modules/ai/budgets.js";
import { departmentOf, type Deps } from "../../src/modules/ai/runtime.js";
import { agentOnBehalfOf, type Principal } from "@workspace/shared";

const budget = (over: Partial<Budget>): Budget => ({ scope: "workspace", scopeId: "", monthlyTokens: null, monthlyUsd: null, ...over });

describe("pricing math", () => {
  it("prices input and output per million tokens", () => {
    expect(costUsd(1_000_000, 0, { inputPerMTok: 3, outputPerMTok: 15 })).toBe(3);
    expect(costUsd(2_000, 500, { inputPerMTok: 3, outputPerMTok: 15 })).toBeCloseTo(0.0135, 10);
    expect(costUsd(5_000, 5_000, { inputPerMTok: 0, outputPerMTok: 0 })).toBe(0);
  });

  it("measures a budget by the fuller of its two limits", () => {
    const b = budget({ monthlyTokens: 1000, monthlyUsd: 10 });
    expect(percentUsed(b, { tokens: 500, usd: 9 })).toBe(90);
    expect(percentUsed(b, { tokens: 900, usd: 1 })).toBe(90);
    expect(percentUsed(budget({ monthlyUsd: 10 }), { tokens: 1e9, usd: 0 })).toBe(0);
    expect(reached(b, { tokens: 799, usd: 0 })).toEqual([]);
    expect(reached(b, { tokens: 800, usd: 0 })).toEqual([80]);
    expect(reached(b, { tokens: 0, usd: 10 })).toEqual([80, 100]);
  });
});

describe("which budget stops a call", () => {
  it("names the person's own budget before the department's and the workspace's", () => {
    const all = [budget({ monthlyTokens: 100 }), budget({ scope: "department", scopeId: "d1", monthlyTokens: 100 }), budget({ scope: "person", scopeId: "u1", monthlyUsd: 1 })];
    const e = firstExceeded(all, () => ({ tokens: 100, usd: 1 }));
    expect(e).toBeInstanceOf(BudgetExceeded);
    expect(e).toMatchObject({ scope: "person", unit: "usd", limit: 1 });
  });

  it("lets a call through below every limit, and without any budget", () => {
    expect(firstExceeded([budget({ monthlyTokens: 100, monthlyUsd: 5 })], () => ({ tokens: 99, usd: 4.99 }))).toBeNull();
    expect(firstExceeded([], () => ({ tokens: 1e12, usd: 1e9 }))).toBeNull();
  });
});

describe("the department a call counts against", () => {
  it("is the asker's when an agent runs for them, looked up as the asker (the agent's grants may not read profiles)", async () => {
    const asker: Principal = { type: "user", id: newId(), teamIds: [], departmentId: null, grants: [{ permission: "employee.profile.read", scope: "WORKSPACE" }] };
    const agent: Principal = { type: "agent", id: newId(), teamIds: [], departmentId: null, grants: [{ permission: "message.read", scope: "WORKSPACE" }] };
    const asked: Principal[] = [];
    const d = {
      identity: { request: async () => asker },
      services: {
        employee: {
          request: async (_m: string, _p: string, _b: unknown, as: Principal) => {
            asked.push(as);
            if (!as.grants.some((g) => g.permission === "employee.profile.read")) throw new Error("403");
            return { departmentId: "dept-1" };
          },
        },
      },
    } as unknown as Deps;
    expect(await departmentOf(d, agentOnBehalfOf(agent, asker))).toBe("dept-1");
    expect(asked[0]).toMatchObject({ type: "user", id: asker.id });
    expect(await departmentOf(d, { ...asker, type: "service" })).toBeNull();
  });
});

describe("budgets against the database", () => {
  const U = newId();
  const OTHER = newId();
  const DEPT = newId();
  let pool: pg.Pool;
  const inRequest = <R>(fn: () => Promise<R>) => runWithContext({ actorId: U, requestId: newId() }, fn);
  const use = (over: Partial<UsageRecord> = {}): UsageRecord => ({
    userId: U,
    agentId: null,
    feature: "ask",
    model: "gpt-x-2026-01-01",
    provider: "openai",
    departmentId: DEPT,
    subject: null,
    inputTokens: 600,
    outputTokens: 400,
    ...over,
  });
  const record = (u: UsageRecord) => inRequest(() => recordUsage(pool, u, async () => ["admin-1"]));
  const alerts = () =>
    inRequest(() =>
      withTransaction(pool, async (c) => (await c.query<{ scope: string; threshold: number }>("SELECT scope, threshold FROM ai_budget_alerts ORDER BY threshold")).rows),
    );

  beforeAll(async () => {
    await migrate("postgres://workspace_owner:owner_pw@localhost:5432/workspace_test", fileURLToPath(new URL("../../migrations/ai", import.meta.url)), "ai");
    pool = new pg.Pool({ connectionString: "postgres://workspace_ai:app_pw@localhost:5432/workspace_test", max: 3 });
  });

  it("costs usage by the connection's price, prefix-matching dated model names; self-hosted is free, the rest unpriced", async () => {
    const conn = newId();
    await inRequest(() =>
      withTransaction(pool, async (c) => {
        await c.query(
          `INSERT INTO ai_connections (id, mode, vendor, name, base_url, model_fast, model_smart, created_by) VALUES ($1,'selfhost','openai_compatible','Ollama','http://ollama:11434/v1','llama3.2','llama3.2',$2)`,
          [conn, U],
        );
        await c.query("INSERT INTO ai_model_prices (provider, model, input_per_mtok, output_per_mtok, updated_by) VALUES ('openai','gpt-x',2,10,$1)", [U]);
      }),
    );
    await record(use({ userId: OTHER, departmentId: null }));
    await record(use({ userId: OTHER, departmentId: null, provider: `c_${conn}`, model: "llama3.2:latest" }));
    await record(use({ userId: OTHER, departmentId: null, provider: "anthropic", model: "claude-x" }));
    const rows = await inRequest(() =>
      withTransaction(
        pool,
        async (c) => (await c.query<{ provider: string; cost: number | null }>("SELECT provider, cost_usd::float AS cost FROM ai_usage_costed WHERE user_id = $1", [OTHER])).rows,
      ),
    );
    const cost = Object.fromEntries(rows.map((r) => [r.provider.startsWith("c_") ? "selfhost" : r.provider, r.cost]));
    expect(cost.openai).toBeCloseTo((600 * 2 + 400 * 10) / 1e6, 10);
    expect(cost.selfhost).toBe(0);
    expect(cost.anthropic).toBeNull();
  });

  it("blocks a person past their token budget, warns once at 80% and once at 100%, and leaves others alone", async () => {
    await inRequest(() => withTransaction(pool, (c) => setBudget(c, budget({ scope: "person", scopeId: U, monthlyTokens: 2500 }), "admin-1")));
    await inRequest(() => assertBudget(pool, { userId: U, departmentId: DEPT }));
    await record(use()); // 1000
    await record(use()); // 2000 → 80%
    expect(await alerts()).toEqual([{ scope: "person", threshold: 80 }]);
    await record(use()); // 3000 → 100%
    await record(use()); // past: no second alert
    expect(await alerts()).toEqual([
      { scope: "person", threshold: 80 },
      { scope: "person", threshold: 100 },
    ]);
    await expect(inRequest(() => assertBudget(pool, { userId: U, departmentId: DEPT }))).rejects.toMatchObject({ scope: "person", unit: "tokens", limit: 2500 });
    await inRequest(() => assertBudget(pool, { userId: newId(), departmentId: DEPT }));
  });

  it("blocks a whole department on its USD budget, and a raised limit lets people continue", async () => {
    await inRequest(() =>
      withTransaction(pool, async (c) => {
        await c.query("DELETE FROM ai_budgets");
        await setBudget(c, budget({ scope: "department", scopeId: DEPT, monthlyUsd: 0.01 }), "admin-1");
      }),
    );
    // 4 calls × (600×2 + 400×10)/1e6 = 0.0208 USD in DEPT already.
    const colleague = newId();
    await expect(inRequest(() => assertBudget(pool, { userId: colleague, departmentId: DEPT }))).rejects.toMatchObject({ scope: "department", unit: "usd" });
    await inRequest(() => assertBudget(pool, { userId: colleague, departmentId: newId() }));
    await inRequest(() => withTransaction(pool, (c) => setBudget(c, budget({ scope: "department", scopeId: DEPT, monthlyUsd: 5 }), "admin-1")));
    await inRequest(() => assertBudget(pool, { userId: colleague, departmentId: DEPT }));
    const [b] = await inRequest(() => withTransaction(pool, (c) => listBudgets(c)));
    expect(b).toMatchObject({ scope: "department", scopeId: DEPT, monthlyUsd: 5 });
    expect(b!.spend.usd).toBeCloseTo(0.0208, 6);
  });

  it("refuses budgets with no limit, and workspace budgets with an id", async () => {
    await expect(inRequest(() => withTransaction(pool, (c) => setBudget(c, budget({ scope: "person", scopeId: U }), "a")))).rejects.toThrow();
    await expect(inRequest(() => withTransaction(pool, (c) => setBudget(c, budget({ scopeId: "x", monthlyTokens: 5 }), "a")))).rejects.toThrow();
  });

  it("lists budgets from the month's running totals, and every call adds to the hourly rollup", async () => {
    const who = newId();
    await inRequest(() =>
      withTransaction(pool, async (c) => {
        await setBudget(c, budget({ scope: "person", scopeId: who, monthlyTokens: 100_000 }), "admin-1");
        // What listBudgets reads is ai_spend_month, not the month's usage rows: a total written there shows as is.
        await c.query("INSERT INTO ai_spend_month (month, scope, scope_id, tokens, cost_usd) VALUES (date_trunc('month', now())::date, 'person', $1, 40000, 1.5)", [who]);
      }),
    );
    const mine = (await inRequest(() => withTransaction(pool, (c) => listBudgets(c)))).find((b) => b.scopeId === who);
    expect(mine).toMatchObject({ scope: "person", spend: { tokens: 40000, usd: 1.5 }, percent: 40 });
    await record(use({ userId: who, departmentId: null, feature: "translate", model: "gpt-x-2026-01-01" }));
    const [h] = await inRequest(() =>
      withTransaction(
        pool,
        async (c) => (await c.query("SELECT source, feature, provider, model, calls, input_tokens, output_tokens FROM ai_hourly_stats WHERE user_id = $1", [who])).rows,
      ),
    );
    expect(h).toEqual({ source: "app", feature: "translate", provider: "openai", model: "gpt-x-2026-01-01", calls: 1, input_tokens: "600", output_tokens: "400" });
  });

  it("keeps the work a call served", async () => {
    const task = newId();
    await record(use({ userId: newId(), departmentId: null, feature: "task_summarize", subject: { type: "task", id: task } }));
    const row = await inRequest(() =>
      withTransaction(pool, async (c) => (await c.query("SELECT subject_type, subject_id, feature FROM ai_usage WHERE subject_id = $1", [task])).rows[0]),
    );
    expect(row).toEqual({ subject_type: "task", subject_id: task, feature: "task_summarize" });
  });
});
