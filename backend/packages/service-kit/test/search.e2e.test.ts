import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { newId, runWithContext, withTransaction } from "@workspace/shared";
import { migrate } from "../src/migrate.js";
import { deleteDoc, indexDocs, search, searchPool, type SearchDoc, type SearchQuery } from "../src/search.js";

const pool = searchPool("postgres://workspace_search:app_pw@localhost:5432/workspace");
const general = newId();
const finance = newId();
const at = (minutesAgo = 0) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

/** Every document this file indexes, removed afterwards (the containers are new per run, so nothing else matches). */
const made: SearchDoc[] = [];
const doc = (over: Partial<SearchDoc>): SearchDoc => {
  const d: SearchDoc = {
    entity_type: "message",
    entity_id: newId(),
    container_id: general,
    title: "",
    body: "",
    url: "/x",
    created_at: at(),
    updated_at: at(),
    ...over,
  };
  made.push(d);
  return d;
};
const tx = <T>(fn: Parameters<typeof withTransaction<T>>[1]) => runWithContext({ actorId: "test", requestId: "t" }, () => withTransaction(pool, fn));
const find = (q: Partial<SearchQuery> & { text: string }) => tx((c) => search(c, { userId: "minh", containerIds: [general], ...q }));
const bodies = async (q: Partial<SearchQuery> & { text: string }) => (await find(q)).hits.map((h) => h.body);

beforeAll(async () => {
  await migrate("postgres://workspace_owner:owner_pw@localhost:5432/workspace", fileURLToPath(new URL("../../../server/migrations/search", import.meta.url)), "search");
  await tx((c) =>
    indexDocs(c, [
      doc({ body: "Kế hoạch thanh toán dự án Alpha" }),
      doc({ container_id: finance, body: "Bảng lương thanh toán tháng 10" }),
      doc({ container_id: finance, acl_users: ["lan"], entity_type: "document", title: "Thanh toán shared to Lan", body: "x" }),
      doc({ entity_type: "task", title: "T-042 Đường dây nóng hỗ trợ khách hàng", body: "" }),
      doc({ entity_type: "document", title: "Quy trình tuyển dụng", body: `${"Mở đầu. ".repeat(80)}Phỏng vấn vòng hai do trưởng phòng phụ trách. ${"Kết. ".repeat(80)}` }),
    ]),
  );
});
afterAll(async () => {
  for (const d of made) await tx((c) => deleteDoc(c, d.entity_type, d.entity_id));
  await pool.end();
});

describe("permission-aware search", () => {
  it("returns only containers the caller belongs to", async () => {
    expect(await bodies({ text: "thanh toán" })).toEqual(["Kế hoạch thanh toán dự án Alpha"]);
  });

  it("revocation is immediate: dropping a container from the filter hides its docs", async () => {
    expect(await bodies({ containerIds: [general, finance], text: "lương" })).toHaveLength(1);
    expect(await bodies({ containerIds: [general], text: "lương" })).toHaveLength(0);
  });

  it("includes documents shared directly to the user, and only to them", async () => {
    const lan = await find({ userId: "lan", containerIds: [], text: "thanh toan" });
    expect(lan.hits.map((h) => h.title)).toEqual(["Thanh toán shared to Lan"]);
    const huy = await find({ userId: "huy", containerIds: [], text: "thanh toan" });
    expect(huy.hits).toHaveLength(0);
  });

  it("filters by type", async () => {
    const r = await find({ containerIds: [general, finance], userId: "lan", text: "thanh toan", types: ["document"] });
    expect(r.hits.map((h) => h.entity_type)).toEqual(["document"]);
  });
});

describe("matching", () => {
  it("folds Vietnamese diacritics both ways, including đ", async () => {
    expect(await bodies({ text: "thanh toan" })).toHaveLength(1);
    expect(await bodies({ text: "THANH TOÁN" })).toHaveLength(1);
    expect((await find({ text: "duong day nong" })).hits.map((h) => h.title)).toEqual(["T-042 Đường dây nóng hỗ trợ khách hàng"]);
  });

  it("tolerates typos through the workspace vocabulary", async () => {
    expect(await bodies({ text: "thanh toann" })).toEqual(["Kế hoạch thanh toán dự án Alpha"]);
    expect((await find({ text: "tuyen dungg" })).hits.map((h) => h.title)).toEqual(["Quy trình tuyển dụng"]);
  });

  it("matches the last word as a prefix (type-ahead)", async () => {
    expect((await find({ text: "duong da" })).hits).toHaveLength(1);
    expect((await find({ text: "tuyển d" })).hits.map((h) => h.title)).toEqual(["Quy trình tuyển dụng"]);
  });

  it("finds task codes", async () => {
    expect((await find({ text: "T-042" })).hits.map((h) => h.entity_type)).toEqual(["task"]);
  });

  it("falls back to any word when no document has them all", async () => {
    expect(await bodies({ text: "alpha zzzqqq" })).toEqual(["Kế hoạch thanh toán dự án Alpha"]);
  });

  it("does not fall back on function words alone (a question about something absent finds nothing)", async () => {
    expect(await bodies({ text: "What is the zzzqqq deadline?" })).toEqual([]);
    expect(await bodies({ text: "kế hoạch của zzzqqq" })).toEqual(["Kế hoạch thanh toán dự án Alpha"]);
  });

  it("returns an excerpt around the match for long bodies, in the original text", async () => {
    const [hit] = (await find({ text: "phong van" })).hits;
    expect(hit?.body).toContain("Phỏng vấn vòng hai");
    expect(hit!.body.length).toBeLessThan(400);
  });

  it("ignores queries with no words and survives tsquery syntax in the input", async () => {
    expect((await find({ text: "!!! &&& ::" })).hits).toEqual([]);
    expect((await find({ text: "thanh' & toan:* | !" })).hits.length).toBeGreaterThan(0);
  });
});

describe("indexing", () => {
  it("is idempotent, never lets an older update win, and deletes", async () => {
    const id = newId();
    await tx((c) => indexDocs(c, [doc({ entity_id: id, body: "phiên bản mới nhất", updated_at: at(0) })]));
    await tx((c) => indexDocs(c, [doc({ entity_id: id, body: "phiên bản cũ", updated_at: at(5) })]));
    await tx((c) => indexDocs(c, [doc({ entity_id: id, body: "phiên bản mới nhất", updated_at: at(0) })]));
    expect(await bodies({ text: "phien ban" })).toEqual(["phiên bản mới nhất"]);
    await tx((c) => deleteDoc(c, "message", id));
    expect(await bodies({ text: "phien ban" })).toEqual([]);
  });

  it("pages with a keyset cursor", async () => {
    const docs = Array.from({ length: 7 }, (_, i) => doc({ body: `trang thử nghiệm ${i}` }));
    await tx((c) => indexDocs(c, docs));
    const first = await find({ text: "trang thu nghiem", size: 4 });
    expect(first.hits).toHaveLength(4);
    const second = await find({ text: "trang thu nghiem", size: 4, after: first.next! });
    expect(second.hits).toHaveLength(3);
    expect(new Set([...first.hits, ...second.hits].map((h) => h.entity_id)).size).toBe(7);
  });
});
