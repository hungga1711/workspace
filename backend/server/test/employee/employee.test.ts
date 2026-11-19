import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import type { INestApplication } from "@nestjs/common";
import pg from "pg";
import { migrate, moduleUrl, signInternalToken, PRINCIPAL_HEADER } from "@workspace/service-kit";
import { newId, runWithContext, withTransaction, type Grant, type Principal } from "@workspace/shared";
import type { EventEnvelope } from "@workspace/contracts";
import { handleDelegation } from "../../src/modules/employee/delegations.js";
import { createEmployeeApp } from "../../src/modules/employee/app.js";
import { workingDays } from "../../src/modules/employee/days.js";
import { resetTestDatabase } from "../test-db.js";

const SECRET = "dev-internal-secret-change-me-32bytes!";
// Unique suffixes for ids created by later tests.
const RUN = newId();
const W = (...ps: string[]): Grant[] => ps.map((permission) => ({ permission, scope: "WORKSPACE" }));
const S = (...ps: string[]): Grant[] => ps.map((permission) => ({ permission, scope: "SELF" }));
const EMP = [...W("employee.profile.read"), ...S("employee.profile.edit", "attendance.read", "attendance.record", "leave.request", "employee.salary.read")];
const MGR = [...EMP, { permission: "leave.approve", scope: "TEAM" as const }, { permission: "attendance.read", scope: "TEAM" as const }];
const HR = [...EMP, ...W("member.manage", "employee.salary.read", "leave.approve", "attendance.read")];
const mk = (id: string, g: Grant[], dep: string | null = null): Principal => ({ type: "user", id, teamIds: [], departmentId: dep, grants: g });
const hr = mk("hr", HR);
const minh = mk("minh", MGR, "dep-eng");
const lan = mk("lan", EMP, "dep-eng");
const huy = mk("huy", EMP, "dep-sales");
const headEng = mk("head", [...EMP, { permission: "employee.salary.read", scope: "DEPARTMENT" }], "dep-eng");

let app: INestApplication;
let base: string;
async function call(p: Principal, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", [PRINCIPAL_HEADER]: await signInternalToken({ principal: p, requestId: newId() }, SECRET) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : null };
}

beforeAll(async () => {
  await resetTestDatabase();
  await migrate("postgres://workspace_owner:owner_pw@localhost:5432/workspace_test", fileURLToPath(new URL("../../migrations/employee", import.meta.url)), "employee");
  app = await createEmployeeApp({
    pool: new pg.Pool({ connectionString: "postgres://workspace_employee:app_pw@localhost:5432/workspace_test", max: 5 }),
    internalSecret: SECRET,
  });
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "127.0.0.1");
  await call(hr, "PUT", "/employees/minh", { displayName: "Minh Le", title: "Engineering Manager", departmentId: "dep-eng" });
  await call(hr, "PUT", "/employees/lan", { displayName: "Lan Nguyen", title: "Engineer", departmentId: "dep-eng", managerId: "minh", hireDate: "2024-03-01" });
  await call(hr, "PUT", "/employees/huy", { displayName: "Huy Tran", title: "Sales", departmentId: "dep-sales", managerId: "minh" });
  for (const u of ["lan", "huy"]) await call(hr, "PUT", `/employees/${u}/compensation`, { baseSalary: 30_000_000, currency: "VND", effectiveFrom: "2026-01-01" });
});

afterAll(async () => {
  await app?.close();
});

describe("profiles", () => {
  it("assigns sequential employee codes", async () => {
    const d = (await call(lan, "GET", "/employees")).body.employees as { code: string }[];
    expect(d.map((e) => e.code).every((c) => /^EMP-\d{6}$/.test(c))).toBe(true);
  });

  it("hides private fields from colleagues but not from self or manager", async () => {
    expect((await call(huy, "GET", "/employees/lan")).body.phone).toBeUndefined();
    expect((await call(lan, "GET", "/employees/lan")).body.hireDate).toBe("2024-03-01");
    expect((await call(minh, "GET", "/employees/lan")).body.hireDate).toBe("2024-03-01");
  });

  it("rejects reporting-line cycles", async () => {
    expect((await call(hr, "PUT", "/employees/minh", { displayName: "Minh Le", managerId: "lan" })).status).toBe(400);
  });
});

describe("compensation", () => {
  it("lets an employee see only their own salary", async () => {
    expect((await call(lan, "GET", "/employees/lan/compensation")).body).toMatchObject({ baseSalary: 30_000_000, currency: "VND" });
    expect((await call(lan, "GET", "/employees/huy/compensation")).status).toBe(403);
  });

  it("DEPARTMENT scope covers only the same department", async () => {
    expect((await call(headEng, "GET", "/employees/lan/compensation")).status).toBe(200);
    expect((await call(headEng, "GET", "/employees/huy/compensation")).status).toBe(403);
  });

  it("does not reveal whether an employee exists", async () => {
    expect((await call(lan, "GET", "/employees/nobody/compensation")).status).toBe(403);
  });
});

describe("attendance", () => {
  it("checks in once per day and checks out once", async () => {
    expect((await call(lan, "POST", "/attendance/check-in")).status).toBe(201);
    expect((await call(lan, "POST", "/attendance/check-in")).status).toBe(409);
    expect((await call(lan, "POST", "/attendance/check-out")).status).toBe(201);
    expect((await call(lan, "POST", "/attendance/check-out")).status).toBe(409);
  });

  it("managers see direct reports; peers do not", async () => {
    const range = "from=2026-01-01&to=2026-12-31";
    expect((await call(minh, "GET", `/attendance?userId=lan&${range}`)).status).toBe(200);
    expect((await call(huy, "GET", `/attendance?userId=lan&${range}`)).status).toBe(403);
  });
  it("a department head's team is their department, even without a reporting line", async () => {
    const d = await call(hr, "POST", "/departments", { name: `Kinh doanh ${Date.now()}`, headId: "huy" });
    expect(d.status).toBe(201);
    // Tuan reports to HR; Huy sees him only as the head of his department.
    await call(hr, "PUT", "/employees/tuan", { displayName: "Tuan Pham", title: "Sales", departmentId: d.body.id, managerId: "hr" });
    const reports = (await call(huy, "GET", "/me/reports")).body.reports.map((r: { userId: string; department: string | null }) => r.userId);
    expect(reports).toContain("tuan");
    expect((await call(huy, "GET", "/me/reports")).body.reports.find((r: { userId: string }) => r.userId === "tuan").department).toMatch(/^Kinh doanh/);
    expect((await call(lan, "GET", "/me/reports")).body.reports).toEqual([]);
  });
});

describe("leave", () => {
  it("counts working days", () => {
    expect(workingDays("2026-10-09", "2026-10-13")).toBe(3); // Fri, Mon, Tue
  });

  it("enforces balance including pending requests, routes to the manager, updates balance on approval", async () => {
    await call(hr, "PUT", "/leave/balances/lan", { type: "annual", year: 2026, entitledDays: 4 });
    const r1 = await call(lan, "POST", "/leave", { type: "annual", startDate: "2026-11-02", endDate: "2026-11-04" }); // 3 days
    expect(r1.body).toMatchObject({ days: 3, status: "pending" });
    const r2 = await call(lan, "POST", "/leave", { type: "annual", startDate: "2026-11-09", endDate: "2026-11-10" }); // 2 > 1 left
    expect(r2.status).toBe(409);
    expect(r2.body).toMatchObject({ error: "insufficient_balance", available: 1 });
    expect((await call(lan, "POST", "/leave", { type: "annual", startDate: "2026-11-03", endDate: "2026-11-03" })).status).toBe(409); // overlap
    expect((await call(huy, "POST", `/leave/${r1.body.id}/decision`, { decision: "approved" })).status).toBe(403);
    expect((await call(minh, "POST", `/leave/${r1.body.id}/decision`, { decision: "approved" })).status).toBe(204);
    expect((await call(minh, "POST", `/leave/${r1.body.id}/decision`, { decision: "rejected" })).status).toBe(409);
    const me = (await call(lan, "GET", "/me")).body;
    expect(me.leaveBalances).toEqual([{ type: "annual", entitled: 4, used: 3, pending: 0 }]);
  });

  it("someone with no manager yet can still ask for leave: it goes to the top of the company", async () => {
    await call(hr, "PUT", "/employees/hr", { displayName: "Thu HR", title: "HR" });
    const r = await call(minh, "POST", "/leave", { type: "unpaid", startDate: "2026-12-14", endDate: "2026-12-14" });
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    const approvers = await Promise.all(
      [hr, headEng, lan, huy].map(async (u) => ((await call(u, "GET", "/leave?role=approver")).body.requests as { id: string }[]).some((x) => x.id === r.body.id)),
    );
    expect(approvers.filter(Boolean)).toHaveLength(1);
  });

  it("the manager a request is routed to decides it without an HR-wide leave.approve grant", async () => {
    // Huy holds Employee grants only; Kim reports to him, so Kim's request is his to decide.
    const kim = mk("kim", EMP, "dep-sales");
    await call(hr, "PUT", "/employees/kim", { displayName: "Kim Pham", title: "Sales", departmentId: "dep-sales", managerId: "huy" });
    const r = await call(kim, "POST", "/leave", { type: "unpaid", startDate: "2026-12-21", endDate: "2026-12-21" });
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    expect((await call(lan, "POST", `/leave/${r.body.id}/decision`, { decision: "approved" })).status).toBe(403);
    expect((await call(huy, "POST", `/leave/${r.body.id}/decision`, { decision: "approved" })).status).toBe(204);
  });

  it("lists everyone's requests for company-wide HR only, and keeps who decided and why", async () => {
    const r = await call(huy, "POST", "/leave", { type: "unpaid", startDate: "2026-12-22", endDate: "2026-12-22", reason: "dentist" });
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    expect((await call(minh, "GET", "/leave/requests")).status).toBe(403); // team-scoped approver
    expect((await call(lan, "GET", "/leave/requests")).status).toBe(403);
    const pending = (await call(hr, "GET", "/leave/requests?status=pending&userId=huy")).body.requests as { id: string }[];
    expect(pending.map((x) => x.id)).toContain(r.body.id);
    // A refusal without a reason is refused itself.
    const bare = await call(hr, "POST", `/leave/${r.body.id}/decision`, { decision: "rejected" });
    expect(bare.status).toBe(400);
    expect(bare.body.error).toBe("reason_required");
    expect((await call(hr, "POST", `/leave/${r.body.id}/decision`, { decision: "rejected", note: "busy week" })).status).toBe(204);
    const decided = (await call(hr, "GET", "/leave/requests?status=rejected&from=2026-12-22&to=2026-12-22")).body.requests;
    expect(decided.find((x: { id: string }) => x.id === r.body.id)).toMatchObject({ status: "rejected", decidedBy: "hr", decisionNote: "busy week" });
  });

  it("rejects requests that cover no working days; a request over New Year is charged to the year it starts in", async () => {
    expect((await call(lan, "POST", "/leave", { type: "annual", startDate: "2026-10-10", endDate: "2026-10-11" })).status).toBe(400); // weekend
    await call(hr, "PUT", "/leave/balances/lan", { type: "annual", year: 2026, entitledDays: 20 });
    const r = await call(lan, "POST", "/leave", { type: "annual", startDate: "2026-12-30", endDate: "2027-01-02" });
    expect(r.status).toBe(201);
    expect(r.body.days).toBe(3); // Wed 30, Thu 31, Fri 1 Jan; Sat 2 Jan is not a working day
    expect((await call(lan, "POST", `/leave/${r.body.id}/cancel`)).status).toBe(204);
  });

  it("types that need no balance (sick, unpaid) are granted without one; custom types can be added and removed", async () => {
    const sick = await call(huy, "POST", "/leave", { type: "sick", startDate: "2026-11-02", endDate: "2026-11-03" });
    expect(sick.status).toBe(201);
    expect((await call(huy, "POST", `/leave/${sick.body.id}/cancel`)).status).toBe(204);
    expect((await call(lan, "PUT", "/leave/types/wedding", { nameVi: "Nghỉ cưới", nameEn: "Wedding leave", requiresBalance: false })).status).toBe(403);
    expect((await call(hr, "PUT", "/leave/types/wedding", { nameVi: "Nghỉ cưới", nameEn: "Wedding leave", requiresBalance: false })).status).toBe(200);
    // The "add type" form never rewrites an existing type.
    expect((await call(hr, "PUT", "/leave/types/sick?create=1", { nameVi: "x", nameEn: "x" })).status).toBe(409);
    expect((await call(lan, "GET", "/leave/types")).body.types.map((t: { code: string }) => t.code)).toEqual(["annual", "sick", "unpaid", "wedding"]);
    expect((await call(hr, "DELETE", "/leave/types/annual")).status).toBe(409); // the policy's default type
    expect((await call(hr, "DELETE", "/leave/types/wedding")).status).toBe(204);
    expect((await call(lan, "GET", "/leave/types")).body.types.some((t: { code: string }) => t.code === "wedding")).toBe(false);
    expect((await call(hr, "GET", "/leave/types")).body.types.find((t: { code: string }) => t.code === "wedding")).toMatchObject({ active: false });
  });

  it("the work week shapes working days and the yearly grant prorates and records the year", async () => {
    const reset = () =>
      call(hr, "PUT", "/settings", {
        workWeek: [1, 2, 3, 4, 5],
        shift: null,
        leavePolicy: { autoGrant: false, typeCode: "annual", defaultDays: 12, prorate: true, seniority: false, carryOverMax: 0 },
      });
    try {
      expect(
        (
          await call(hr, "PUT", "/settings", {
            workWeek: [1, 2, 3, 4, 5, 6],
            shift: null,
            leavePolicy: { autoGrant: true, typeCode: "annual", defaultDays: 12, prorate: true, seniority: false, carryOverMax: 0 },
          })
        ).status,
      ).toBe(200);
      expect((await call(lan, "GET", "/holidays?year=2026")).body.workWeek).toEqual([1, 2, 3, 4, 5, 6]);
      expect((await call(lan, "GET", "/settings")).body.workWeek).toEqual([1, 2, 3, 4, 5, 6]);
      // Saturday 10 Oct is now a working day.
      const sat = await call(huy, "POST", "/leave", { type: "unpaid", startDate: "2026-10-10", endDate: "2026-10-10" });
      expect(sat.status).toBe(201);
      expect(sat.body.days).toBe(1);
      await call(huy, "POST", `/leave/${sat.body.id}/cancel`);
      const idNew = `new-${RUN.slice(-5)}`;
      await call(hr, "PUT", `/employees/${idNew}`, { displayName: "Người Mới", managerId: null, hireDate: "2027-07-20" });
      const { grantYearlyLeave } = await import("../../src/modules/employee/leave-grant.js");
      const pool = new pg.Pool({ connectionString: "postgres://workspace_employee:app_pw@localhost:5432/workspace_test", max: 1 });
      expect(await grantYearlyLeave(pool, new Date("2027-01-01T12:00:00Z"))).toBeGreaterThanOrEqual(1);
      expect(await grantYearlyLeave(pool, new Date("2027-01-02T12:00:00Z"))).toBe(0); // idempotent per year
      await pool.end();
      const b = (await call(hr, "GET", "/leave/balances?year=2027&type=annual")).body;
      expect(b.policy).toMatchObject({ autoGrant: true, lastGrantedYear: 2027 });
      expect(b.employees.find((e: { userId: string }) => e.userId === idNew)).toMatchObject({ entitled: 5 }); // hired 20 July: 5 months left (July does not count after the 15th)
      expect(b.employees.find((e: { userId: string }) => e.userId === "lan")).toMatchObject({ entitled: 12 });
    } finally {
      await reset();
    }
  });
});

describe("departments", () => {
  it("renames, changes the head and deletes (people are moved out only on request)", async () => {
    const d = (await call(hr, "POST", "/departments", { name: `Vận hành ${Date.now()}`, headId: null })).body as { id: string };
    expect((await call(hr, "PATCH", `/departments/${d.id}`, { name: `Ops ${d.id.slice(-4)}`, headId: "minh" })).status).toBe(204);
    const nhi = mk(`nhi-${d.id.slice(-4)}`, EMP, d.id);
    await call(hr, "PUT", `/employees/${nhi.id}`, { displayName: "Nhi", title: "Ops", departmentId: d.id });
    const list = (await call(hr, "GET", "/departments")).body.departments as { id: string; name: string; headId: string | null; members: number }[];
    expect(list.find((x) => x.id === d.id)).toMatchObject({ name: `Ops ${d.id.slice(-4)}`, headId: "minh", members: 1 });
    expect((await call(hr, "DELETE", `/departments/${d.id}`)).status).toBe(409);
    expect((await call(lan, "DELETE", `/departments/${d.id}?move=1`)).status).toBe(403);
    expect((await call(hr, "DELETE", `/departments/${d.id}?move=1`)).status).toBe(204);
    expect((await call(nhi, "GET", "/me")).body.department ?? null).toBeNull();
    expect((await call(hr, "DELETE", `/departments/${d.id}`)).status).toBe(404);
  });
});

describe("announcements", () => {
  const comms = mk("comms", [...EMP, ...W("announcement.publish")]);
  it("only publishers post; everyone in scope reads; departments and schedules are respected", async () => {
    expect((await call(lan, "POST", "/announcements", { title: "Không được" })).status).toBe(403);
    const all = (await call(comms, "POST", "/announcements", { title: "Lịch nghỉ lễ 20/11", body: "Công ty nghỉ **cả ngày**.", pinned: true })).body;
    const eng = (await call(comms, "POST", "/announcements", { title: "Họp kỹ thuật quý", category: "event", eventAt: "2026-11-02T09:00:00+07:00", departmentIds: ["dep-eng"] }))
      .body;
    const later = (await call(comms, "POST", "/announcements", { title: "Sắp công bố", publishAt: new Date(Date.now() + 86400_000).toISOString() })).body;
    const ids = (r: { body: { announcements: { id: string }[] } }) => r.body.announcements.map((a) => a.id);
    const lanFeed = await call(lan, "GET", "/announcements");
    expect(ids(lanFeed)).toEqual(expect.arrayContaining([all.id, eng.id]));
    expect(ids(lanFeed)).not.toContain(later.id);
    expect(ids(lanFeed)[0]).toBe(all.id); // pinned first
    expect(lanFeed.body.announcements[0].readCount).toBeUndefined();
    const huyFeed = await call(huy, "GET", "/announcements");
    expect(ids(huyFeed)).toContain(all.id);
    expect(ids(huyFeed)).not.toContain(eng.id);
    expect((await call(huy, "GET", `/announcements/${eng.id}`)).status).toBe(404);
    expect(ids(await call(comms, "GET", "/announcements?all=1"))).toContain(later.id);
  });

  it("tracks read receipts and unread counts; events need a date; links must be https", async () => {
    const a = (await call(comms, "POST", "/announcements", { title: "Chương trình học tiếng Anh", category: "learning", linkUrl: "https://hoc.example.com/dang-ky" })).body;
    const before = (await call(lan, "GET", "/announcements")).body.unread;
    expect((await call(lan, "POST", `/announcements/${a.id}/read`)).status).toBe(204);
    expect((await call(lan, "POST", `/announcements/${a.id}/read`)).status).toBe(204);
    expect((await call(lan, "GET", "/announcements")).body.unread).toBe(before - 1);
    const mine = (await call(comms, "GET", "/announcements")).body.announcements.find((x: { id: string }) => x.id === a.id);
    expect(mine.readCount).toBe(1);
    expect((await call(comms, "POST", "/announcements", { title: "Sự kiện", category: "event" })).status).toBe(400);
    expect((await call(comms, "POST", "/announcements", { title: "Link", linkUrl: "http://pay.example.com" })).status).toBe(400);
  });

  it("edits and removes", async () => {
    const a = (await call(comms, "POST", "/announcements", { title: "Bản nháp" })).body;
    expect((await call(comms, "PATCH", `/announcements/${a.id}`, { title: "Bản chính thức", pinned: true })).status).toBe(200);
    expect((await call(lan, "GET", `/announcements/${a.id}`)).body).toMatchObject({ title: "Bản chính thức", pinned: true });
    expect((await call(lan, "DELETE", `/announcements/${a.id}`)).status).toBe(403);
    expect((await call(comms, "DELETE", `/announcements/${a.id}`)).status).toBe(204);
    expect((await call(lan, "GET", `/announcements/${a.id}`)).status).toBe(404);
  });
});

describe("Me views", () => {
  it("managers see their team's attendance today; employees see nothing; HR sees the company", async () => {
    await call(lan, "POST", "/attendance/check-in");
    const team = (await call(minh, "GET", "/attendance/team")).body;
    expect(team.scope).toBe("team");
    // The whole reporting line: huy and lan report to minh, kim reports to huy.
    expect(team.members.map((m: { userId: string }) => m.userId).sort()).toEqual(["huy", "kim", "lan"]);
    expect(team.members.find((m: { userId: string }) => m.userId === "lan").checkIn).not.toBeNull();
    expect(team.members.find((m: { userId: string }) => m.userId === "lan")).toMatchObject({ missedCheckout: false, onLeave: false });
    expect(typeof team.workingDay).toBe("boolean");
    expect((await call(lan, "GET", "/attendance/team")).body.members).toEqual([]);
    expect((await call(hr, "GET", "/attendance/team")).body.scope).toBe("company");
  });

  it("shows leave only to the person and their manager, without reasons", async () => {
    const year = new Date().getFullYear() + 1;
    await call(hr, "PUT", "/leave/balances/lan", { type: "annual", year, entitledDays: 12 });
    const r = (await call(lan, "POST", "/leave", { type: "annual", startDate: `${year}-03-02`, endDate: `${year}-03-03`, reason: "việc riêng" })).body;
    const range = `from=${year}-03-01&to=${year}-03-31`;
    await call(hr, "PUT", "/employees/head", { displayName: "Head Eng", title: "Head", departmentId: "dep-eng" });
    const mgr = (await call(minh, "GET", `/leave/out?${range}`)).body.out;
    expect(mgr.find((x: { userId: string }) => x.userId === "lan")).toMatchObject({ status: "pending" });
    expect(mgr[0].reason).toBeUndefined();
    expect((await call(headEng, "GET", `/leave/out?${range}`)).body.out.some((x: { userId: string }) => x.userId === "lan")).toBe(false); // pending is private
    await call(minh, "POST", `/leave/${r.id}/decision`, { decision: "approved" });
    expect((await call(headEng, "GET", `/leave/out?${range}`)).body.out.some((x: { userId: string }) => x.userId === "lan")).toBe(false); // colleagues never see each other's leave
    expect((await call(huy, "GET", `/leave/out?${range}`)).body.out.some((x: { userId: string }) => x.userId === "lan")).toBe(false); // other department
  });
});

describe("master data projection", () => {
  it("applies newer full snapshots, ignores older ones, heals gaps, and validates leave types", async () => {
    const { applySnapshot, resyncMasterData } = await import("../../src/modules/employee/masterdata.js");
    const { ServiceClient } = await import("@workspace/service-kit");
    const pool = new pg.Pool({ connectionString: "postgres://workspace_employee:app_pw@localhost:5432/workspace_test", max: 1 });
    await resyncMasterData(pool, new ServiceClient(moduleUrl("platform"), SECRET, "test", []));
    const kind = `test_kind_${RUN.slice(-6).toLowerCase()}`;
    const c = await pool.connect();
    try {
      expect(await applySnapshot(c, kind, 1, [{ code: "a", label: { vi: "A" }, active: true }])).toBe(true);
      expect(await applySnapshot(c, kind, 1, [{ code: "x", label: { vi: "X" }, active: true }])).toBe(false);
      expect(
        await applySnapshot(c, kind, 5, [
          { code: "a", label: { vi: "A" }, active: true },
          { code: "b", label: { vi: "B" }, active: false },
        ]),
      ).toBe(true); // gap 1→5
      expect(await applySnapshot(c, kind, 3, [])).toBe(false);
      const rows = (await c.query("SELECT code FROM master_data WHERE kind = $1 ORDER BY code", [kind])).rows.map((r) => r.code);
      expect(rows).toEqual(["a", "b"]);
      await c.query("DELETE FROM master_data WHERE kind = $1", [kind]);
      await c.query("DELETE FROM master_data_versions WHERE kind = $1", [kind]);
    } finally {
      c.release();
      await pool.end();
    }
    const year = new Date().getFullYear() + 1;
    expect((await call(lan, "POST", "/leave", { type: "vacation_on_mars", startDate: `${year}-04-06`, endDate: `${year}-04-06` })).status).toBe(400);
    expect((await call(lan, "GET", "/master-data/leave_type")).body.items.map((i: { code: string }) => i.code)).toEqual(expect.arrayContaining(["annual", "sick", "unpaid"]));
  });
});

describe("offboarding handover (HR side)", () => {
  it("moves pending leave approvals and direct reports to a successor, never to self-approval", async () => {
    const id = (s: string) => `${s}-${RUN.slice(-5)}`;
    const put = (u: string, managerId: string | null) => call(hr, "PUT", `/employees/${id(u)}`, { displayName: u, managerId });
    await put("sep", null);
    await put("qly", id("sep"));
    await put("nv1", id("qly"));
    await put("nv2", id("qly"));
    for (const u of ["nv1", "nv2"]) await call(hr, "PUT", `/leave/balances/${id(u)}`, { type: "annual", year: 2026, entitledDays: 10 });
    const nv1 = mk(id("nv1"), EMP);
    const nv2 = mk(id("nv2"), EMP);
    const r1 = (await call(nv1, "POST", "/leave", { type: "annual", startDate: "2026-12-01", endDate: "2026-12-01" })).body;
    const r2 = (await call(nv2, "POST", "/leave", { type: "annual", startDate: "2026-12-02", endDate: "2026-12-02" })).body;

    expect((await call(minh, "GET", `/handover/${id("qly")}`)).status).toBe(403);
    expect((await call(hr, "GET", `/handover/${id("qly")}`)).body).toEqual({ leaveApprovals: 2, reports: 2 });
    expect((await call(hr, "POST", `/handover/${id("qly")}`, { toUserId: id("nv2") })).body).toEqual({ leaveApprovals: 2, reports: 2 });
    expect((await call(hr, "GET", `/handover/${id("qly")}`)).body).toEqual({ leaveApprovals: 0, reports: 0 });

    const asNv2 = (await call(mk(id("nv2"), MGR), "GET", "/leave?role=approver")).body.requests as { id: string }[];
    expect(asNv2.map((r) => r.id)).toEqual([r1.id]); // nv2 approves nv1's leave, not their own
    const asSep = (await call(mk(id("sep"), MGR), "GET", "/leave?role=approver")).body.requests as { id: string }[];
    expect(asSep.map((r) => r.id)).toContain(r2.id);
    expect((await call(hr, "GET", `/employees/${id("nv1")}`)).body.managerId).toBe(id("nv2"));
    expect((await call(hr, "GET", `/employees/${id("nv2")}`)).body.managerId).toBe(id("sep"));
  });
});

describe("leave approvals follow out-of-office delegation", () => {
  it("routes new leave to the manager's delegate, who may decide it; never to the requester", async () => {
    const pool = new pg.Pool({ connectionString: "postgres://workspace_employee:app_pw@localhost:5432/workspace_test", max: 1 });
    const id = (s: string) => `${s}-d${RUN.slice(-5)}`;
    await call(hr, "PUT", `/employees/${id("boss")}`, { displayName: "Sếp", managerId: null });
    await call(hr, "PUT", `/employees/${id("vice")}`, { displayName: "Phó", managerId: id("boss") });
    await call(hr, "PUT", `/employees/${id("staff")}`, { displayName: "Nhân viên", managerId: id("boss") });
    for (const u of ["vice", "staff"]) await call(hr, "PUT", `/leave/balances/${id(u)}`, { type: "annual", year: 2026, entitledDays: 10 });
    const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
    const ev = (eventType: string, payload: Record<string, unknown>): EventEnvelope => ({
      eventId: newId(),
      eventType,
      version: 1,
      aggregateType: "work.delegation",
      aggregateId: id("boss"),
      actorId: `user:${id("boss")}`,
      occurredAt: new Date().toISOString(),
      payload,
    });
    await runWithContext({ actorId: "test", requestId: newId() }, () =>
      withTransaction(pool, (c) => handleDelegation(ev("work.delegation.set.v1", { userId: id("boss"), delegateId: id("vice"), until: today }), c)),
    );

    const staff = mk(id("staff"), EMP);
    const vice = mk(id("vice"), EMP); // no leave.approve of their own
    const r = (await call(staff, "POST", "/leave", { type: "annual", startDate: "2026-12-07", endDate: "2026-12-07" })).body;
    const inbox = (await call(vice, "GET", "/leave?role=approver")).body.requests as { id: string; onBehalfOf: string }[];
    expect(inbox.find((x) => x.id === r.id)).toMatchObject({ onBehalfOf: id("boss") });
    expect((await call(vice, "POST", `/leave/${r.id}/decision`, { decision: "approved" })).status).toBeLessThan(300);

    // The delegate's own leave goes to the away manager, not to themselves.
    const own = (await call(vice, "POST", "/leave", { type: "annual", startDate: "2026-12-08", endDate: "2026-12-08" })).body;
    expect(((await call(mk(id("boss"), MGR), "GET", "/leave?role=approver")).body.requests as { id: string }[]).map((x) => x.id)).toContain(own.id);

    await runWithContext({ actorId: "test", requestId: newId() }, () =>
      withTransaction(pool, (c) => handleDelegation(ev("work.delegation.cleared.v1", { userId: id("boss") }), c)),
    );
    const after = (await call(staff, "POST", "/leave", { type: "annual", startDate: "2026-12-09", endDate: "2026-12-09" })).body;
    expect(((await call(mk(id("boss"), MGR), "GET", "/leave?role=approver")).body.requests as { id: string }[]).map((x) => x.id)).toContain(after.id);
    await pool.end();
  });
});

describe("monthly attendance report (HR)", () => {
  it("counts days, hours, missing check-outs and approved leave per employee; HR only", async () => {
    const pool = new pg.Pool({ connectionString: "postgres://workspace_employee:app_pw@localhost:5432/workspace_test", max: 1 });
    const id = (s: string) => `${s}-r${RUN.slice(-5)}`;
    await call(hr, "PUT", `/employees/${id("an")}`, { displayName: "An Báo Cáo", managerId: null });
    await runWithContext({ actorId: "test", requestId: newId() }, () =>
      withTransaction(pool, async (c) => {
        await c.query(
          "INSERT INTO attendance (id, user_id, day, check_in, check_out) VALUES (md5(random()::text),$1,'2026-09-01','2026-09-01T01:00:00Z','2026-09-01T10:00:00Z'), (md5(random()::text),$1,'2026-09-02','2026-09-02T01:30:00Z','2026-09-02T09:30:00Z'), (md5(random()::text),$1,'2026-09-03','2026-09-03T01:00:00Z',NULL)",
          [id("an")],
        );
        await c.query(
          "INSERT INTO leave_requests (id, user_id, leave_type, start_date, end_date, days, reason, approver_id, status) VALUES ($1,$2,'annual','2026-09-28','2026-10-02',5,'',null,'approved')",
          [newId(), id("an")],
        );
      }),
    );
    expect((await call(lan, "GET", "/attendance/report?month=2026-09")).status).toBe(403);
    const r = (await call(hr, "GET", "/attendance/report?month=2026-09")).body;
    expect(r).toMatchObject({ month: "2026-09", workingDays: 22 });
    const an = r.employees.find((e: { userId: string }) => e.userId === id("an"));
    expect(an).toMatchObject({ days: 3, hours: 17, open: 1, leaveDays: 3 }); // 28–30 Sep are working days inside September
    await pool.end();
  });
});

describe("attendance corrections (HR)", () => {
  it("HR fixes a forgotten check-out with a note; the employee sees it marked; others cannot", async () => {
    const id = `fix-${RUN.slice(-5)}`;
    await call(hr, "PUT", `/employees/${id}`, { displayName: "Quên Chấm Ra", managerId: null });
    const bad = { checkIn: "2026-09-10T01:00:00Z", checkOut: "2026-09-10T00:00:00Z", note: "x" };
    expect((await call(lan, "PUT", `/attendance/${id}/2026-09-10`, { ...bad, checkOut: null })).status).toBe(403);
    expect((await call(hr, "PUT", `/attendance/${id}/2026-09-10`, bad)).status).toBe(400); // out before in
    expect((await call(hr, "PUT", `/attendance/${id}/2026-09-11`, { ...bad, checkOut: null })).status).toBe(400); // wrong day
    const r = (
      await call(hr, "PUT", `/attendance/${id}/2026-09-10`, { checkIn: "2026-09-10T01:00:00Z", checkOut: "2026-09-10T10:00:00Z", note: "Quên chấm ra, xác nhận qua camera" })
    ).body;
    expect(r).toMatchObject({ day: "2026-09-10", source: "admin", correctedBy: "hr", note: "Quên chấm ra, xác nhận qua camera" });
    const days = (await call(hr, "GET", `/attendance?userId=${id}&from=2026-09-01&to=2026-09-30`)).body.days;
    expect(days).toEqual([expect.objectContaining({ day: "2026-09-10", source: "admin", correctionNote: "Quên chấm ra, xác nhận qua camera" })]);
    expect((await call(hr, "GET", "/attendance/report?month=2026-09")).body.employees.find((e: { userId: string }) => e.userId === id)).toMatchObject({
      days: 1,
      hours: 9,
      open: 0,
    });
  });
});

describe("attendance: shifts, overnight and self-service corrections", () => {
  it("records lateness against the shift, closes an overnight check-in, allows a second entry after a break", async () => {
    const id = `shift-${RUN.slice(-5)}`;
    const who = mk(id, EMP);
    await call(hr, "PUT", `/employees/${id}`, { displayName: "Ca Đêm", managerId: "minh" });
    // A shift that started long ago: everything is late, so the number is deterministic.
    expect(
      (
        await call(hr, "PUT", "/settings", {
          workWeek: [1, 2, 3, 4, 5],
          shift: { start: "00:00", end: "08:00", lateAfterMin: 0 },
          leavePolicy: { autoGrant: false, typeCode: "annual", defaultDays: 12, prorate: true, seniority: false, carryOverMax: 0 },
        })
      ).status,
    ).toBe(200);
    const first = await call(who, "POST", "/attendance/check-in");
    expect(first.status).toBe(201);
    expect(first.body.lateMinutes).toBeGreaterThanOrEqual(0);
    expect((await call(who, "POST", "/attendance/check-in")).status).toBe(409); // still open
    const out = await call(who, "POST", "/attendance/check-out");
    expect(out.status).toBe(201);
    expect(out.body.id).toBe(first.body.id);
    expect((await call(who, "POST", "/attendance/check-in")).status).toBe(201); // a second entry the same day
    await call(who, "POST", "/attendance/check-out");
    const pool = new pg.Pool({ connectionString: "postgres://workspace_employee:app_pw@localhost:5432/workspace_test", max: 1 });
    const openSince = (hours: number) =>
      runWithContext({ actorId: "test", requestId: newId() }, () =>
        withTransaction(pool, (c) =>
          c.query(`INSERT INTO attendance (id, user_id, day, check_in) VALUES ($1,$2,(now() - interval '${hours} hours')::date, now() - interval '${hours} hours')`, [newId(), id]),
        ),
      );
    // An entry opened last night closes this morning (night shift) with its real hours.
    await openSince(9);
    const night = await call(who, "POST", "/attendance/check-out");
    expect(night.status).toBe(201);
    expect(night.body.missedCheckout).toBe(false);
    // Open longer than a shift: a forgotten check-out. Checking out closes it with no hours and the flag.
    await openSince(72);
    const late = await call(who, "POST", "/attendance/check-out");
    expect(late.status).toBe(201);
    expect(late.body).toMatchObject({ missedCheckout: true });
    expect(late.body.checkOut).toBe(late.body.checkIn);
    // Checking in the next day is never blocked by yesterday's open entry: it is closed and named in the answer.
    await openSince(24);
    const next = await call(who, "POST", "/attendance/check-in");
    expect(next.status).toBe(201);
    expect(next.body.closedMissed?.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((await call(who, "POST", "/attendance/check-in")).body).toMatchObject({ error: "already_checked_in" }); // today's is open
    await call(who, "POST", "/attendance/check-out");
    await pool.end();
    await call(hr, "PUT", "/settings", {
      workWeek: [1, 2, 3, 4, 5],
      shift: null,
      leavePolicy: { autoGrant: false, typeCode: "annual", defaultDays: 12, prorate: true, seniority: false, carryOverMax: 0 },
    });
  });

  it("an employee asks for a correction; the line manager approves it and the day is rewritten with a note", async () => {
    const id = `corr-${RUN.slice(-5)}`;
    const who = mk(id, EMP);
    await call(hr, "PUT", `/employees/${id}`, { displayName: "Quên Thẻ", managerId: "minh" });
    const ask = await call(who, "POST", "/attendance/corrections", {
      day: "2026-09-14",
      checkIn: "2026-09-14T01:00:00Z",
      checkOut: "2026-09-14T10:00:00Z",
      reason: "Quên thẻ, có mặt từ 8h",
    });
    expect(ask.status).toBe(201);
    expect((await call(who, "POST", "/attendance/corrections", { day: "2026-09-14", checkIn: "2026-09-14T01:00:00Z", checkOut: null, reason: "again" })).body).toMatchObject({
      error: "pending_correction",
    });
    expect((await call(who, "GET", "/attendance/corrections")).body.corrections).toEqual([expect.objectContaining({ id: ask.body.id, status: "pending", approverId: "minh" })]);
    expect((await call(minh, "GET", "/attendance/corrections?role=approver")).body.corrections.some((x: { id: string }) => x.id === ask.body.id)).toBe(true);
    expect((await call(who, "POST", `/attendance/corrections/${ask.body.id}/decision`, { decision: "approved" })).status).toBe(403); // not your own
    expect((await call(lan, "POST", `/attendance/corrections/${ask.body.id}/decision`, { decision: "approved" })).status).toBe(403);
    expect((await call(minh, "POST", `/attendance/corrections/${ask.body.id}/decision`, { decision: "approved" })).status).toBe(204);
    expect((await call(minh, "POST", `/attendance/corrections/${ask.body.id}/decision`, { decision: "approved" })).status).toBe(409);
    const days = (await call(hr, "GET", `/attendance?userId=${id}&from=2026-09-01&to=2026-09-30`)).body.days;
    expect(days).toEqual([expect.objectContaining({ day: "2026-09-14", source: "admin", correctedBy: "minh", correctionNote: "Quên thẻ, có mặt từ 8h" })]);
  });
});

describe("company holidays", () => {
  it("are managed by HR, visible to all, and not counted as leave or working days", async () => {
    expect((await call(lan, "PUT", "/holidays/2026-04-30", { name: "Giải phóng miền Nam" })).status).toBe(403);
    expect((await call(hr, "PUT", "/holidays/2026-04-30", { name: "Giải phóng miền Nam" })).status).toBe(200);
    expect((await call(hr, "PUT", "/holidays/2026-05-01", { name: "Quốc tế Lao động" })).status).toBe(200);
    expect((await call(hr, "PUT", "/holidays/2026-13-01", { name: "x" })).status).toBe(400);
    expect((await call(lan, "GET", "/holidays?year=2026")).body.holidays).toEqual(
      expect.arrayContaining([
        { day: "2026-04-30", name: "Giải phóng miền Nam" },
        { day: "2026-05-01", name: "Quốc tế Lao động" },
      ]),
    );

    const id = `hol-${RUN.slice(-5)}`;
    await call(hr, "PUT", `/employees/${id}`, { displayName: "Nghỉ Lễ", managerId: "minh" });
    await call(hr, "PUT", `/leave/balances/${id}`, { type: "annual", year: 2026, entitledDays: 10 });
    const me = mk(id, EMP);
    const r = (await call(me, "POST", "/leave", { type: "annual", startDate: "2026-04-29", endDate: "2026-05-04" })).body;
    expect(r.days).toBe(2); // Wed 29/4 and Mon 4/5: 30/4 and 1/5 are holidays, then the weekend
    expect((await call(me, "POST", "/leave", { type: "annual", startDate: "2026-04-30", endDate: "2026-05-01" })).status).toBe(400); // only holidays
    expect((await call(hr, "GET", "/attendance/report?month=2026-04")).body).toMatchObject({ workingDays: 21, holidays: ["2026-04-30"] });

    expect((await call(hr, "DELETE", "/holidays/2026-05-01")).status).toBe(204);
    expect((await call(hr, "DELETE", "/holidays/2026-05-01")).status).toBe(404);
    await call(hr, "DELETE", "/holidays/2026-04-30");
  });
});

describe("leave balances for everyone (HR)", () => {
  it("grants a year in bulk with seniority and carry-over, shows the overview, never below used", async () => {
    const id = (s: string) => `${s}-b${RUN.slice(-5)}`;
    await call(hr, "PUT", `/employees/${id("senior")}`, { displayName: "Lâu Năm", managerId: null, hireDate: "2015-03-01" });
    await call(hr, "PUT", `/employees/${id("junior")}`, { displayName: "Mới Vào", managerId: null, hireDate: "2024-06-01" });
    await call(hr, "PUT", `/leave/balances/${id("junior")}`, { type: "annual", year: 2026, entitledDays: 12 });
    await runWithContext({ actorId: "test", requestId: newId() }, async () => {
      const pool = new pg.Pool({ connectionString: "postgres://workspace_employee:app_pw@localhost:5432/workspace_test", max: 1 });
      await withTransaction(pool, (c) => c.query("UPDATE leave_balances SET used_days = 9 WHERE user_id = $1 AND year = 2026", [id("junior")]));
      await pool.end();
    });
    expect((await call(lan, "POST", "/leave/balances/bulk", { type: "annual", year: 2027, entitledDays: 12 })).status).toBe(403);
    const r = (await call(hr, "POST", "/leave/balances/bulk", { type: "annual", year: 2027, entitledDays: 12, seniority: true, carryOverMax: 2, onlyMissing: true })).body;
    expect(r.updated).toBeGreaterThanOrEqual(2);
    const view = (await call(hr, "GET", "/leave/balances?year=2027&type=annual")).body.employees as { userId: string; entitled: number }[];
    expect(view.find((e) => e.userId === id("senior"))?.entitled).toBe(14); // 12 + 2 (11 full years → 2 × 5)
    expect(view.find((e) => e.userId === id("junior"))?.entitled).toBe(14); // 12 + carry-over capped at 2 (3 left)
    // Running again with onlyMissing leaves everyone as is.
    expect((await call(hr, "POST", "/leave/balances/bulk", { type: "annual", year: 2027, entitledDays: 20, onlyMissing: true })).body.updated).toBe(0);
    expect((await call(hr, "PUT", `/leave/balances/${id("junior")}`, { type: "annual", year: 2026, entitledDays: 5 })).body.error).toBe("below_used");
  });
});
