import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { accept, drift, hashOf, packSidecar, unpackSidecar } from "./drift";
import { en } from "./messages/en";
import { vi } from "./messages/vi";
import { zh } from "./messages/zh";
import { es } from "./messages/es";

type Tree = { [k: string]: string | Tree };

describe("translation drift", () => {
  const source: Tree = { a: { save: "Save", n_one: "{count} task", n_other: "{count} tasks" }, b: "Hello" };
  const es1: Tree = { a: { save: "Guardar", n_one: "{count} tarea", n_many: "{count} de tareas", n_other: "{count} tareas" } };

  it("finds translations made from an older English string", () => {
    const rec = accept(source, es1);
    expect(rec["a.n_many"]).toBe(hashOf("{count} tasks"));
    expect(drift(source, es1, rec)).toEqual({ stale: [], untracked: [], missing: 1 });
    const changed: Tree = { ...source, a: { ...(source.a as Tree), save: "Save changes" } };
    expect(drift(changed, es1, rec).stale).toEqual(["a.save"]);
    expect(drift(changed, es1, accept(changed, es1, rec, ["a.save"])).stale).toEqual([]);
  });

  it("lists translations with no record and drops records of removed keys", () => {
    expect(drift(source, es1, {}).untracked).toHaveLength(4);
    expect(accept(source, {}, { "gone.key": "abc123" })).toEqual({});
  });

  it("packs the record as one tree for all languages", () => {
    const s = { vi: { "a.save": "111111" }, zh: {}, es: { "a.save": "222222", b: "333333" } };
    expect(packSidecar(s)).toEqual({ a: { save: "111111 - 222222" }, b: "- - 333333" });
    expect(unpackSidecar(packSidecar(s))).toEqual(s);
  });

  it("no shipped translation is stale (after changing English, re-translate and run i18n:drift --accept)", () => {
    const rec = unpackSidecar(JSON.parse(readFileSync(new URL("./messages/translated-from.json", import.meta.url), "utf8")) as Tree);
    const stale = (
      [
        ["vi", vi],
        ["zh", zh],
        ["es", es],
      ] as const
    ).flatMap(([l, c]) => drift(en as unknown as Tree, c as unknown as Tree, rec[l]).stale.map((k) => `${l}:${k}`));
    expect(stale).toEqual([]);
  });
});
