import { describe, expect, it } from "vitest";
import { CATEGORIES, validateWorkflow, type WorkflowStep } from "./model.js";
import { TEMPLATES, templatesFor } from "./templates.js";

const PH = /\{\{\s*([^{}]+?)\s*\}\}/g;
const PLAIN = ["task", "previous", "inputs", "resources", "answers"];
const makesResult = (s: WorkflowStep) => s.kind === "ai" || s.kind === "command";
const texts = (s: WorkflowStep) => [s.prompt, s.criteria, s.command, s.role].filter((x): x is string => !!x);

describe.each(["en", "vi"] as const)("workflow templates (%s)", (lang) => {
  const all = templatesFor(lang);

  it("has one of each key, in a known department", () => {
    expect(new Set(all.map((t) => t.key)).size).toBe(all.length);
    expect(all.length).toBe(TEMPLATES.length);
    for (const t of all) expect(CATEGORIES, t.key).toContain(t.category);
  });

  it("every template is a workflow the server accepts, unchanged by normalization", () => {
    for (const t of all) {
      const v = validateWorkflow(t.steps, t.config);
      expect(v.steps, t.key).toEqual(t.steps);
      expect(v.config, t.key).toEqual(t.config);
      expect(v.runner, t.key).toBe(t.runner);
      expect(new Set(t.steps.map((s) => s.key)).size, t.key).toBe(t.steps.length);
      expect(t.name && t.description, t.key).toBeTruthy();
      expect(t.uses.length, t.key).toBeGreaterThanOrEqual(2);
    }
  });

  it("only uses placeholders the engine fills: earlier results, declared inputs", () => {
    for (const t of all) {
      const inputs = new Set(t.config.inputs.map((f) => f.key));
      t.steps.forEach((s, i) => {
        const earlier = new Set(
          t.steps
            .slice(0, i)
            .filter(makesResult)
            .map((x) => x.key),
        );
        // A check's criteria and a command stand on their own: the judge reads the result, the shell reads files.
        for (const text of [s.criteria, s.command].filter((x): x is string => !!x)) expect([...text.matchAll(PH)], `${t.key}/${s.key}`).toEqual([]);
        for (const m of (s.prompt ?? "").matchAll(PH)) {
          const name = m[1]!;
          const where = `${t.key}/${s.key} {{${name}}}`;
          if (name.startsWith("steps.")) expect(earlier.has(name.slice(6)), where).toBe(true);
          else if (name.startsWith("input.")) expect(inputs.has(name.slice(6)), where).toBe(true);
          else expect(PLAIN, where).toContain(name);
        }
        if (s.kind === "ai" && i > 0 && t.steps.slice(0, i).some(makesResult))
          expect(
            /\{\{\s*(previous|steps\.[a-z0-9_-]+)\s*\}\}/.test(s.prompt ?? "") || s.kind !== "ai" || t.config.environment.kind !== "assistant",
            `${t.key}/${s.key} reads no earlier result`,
          ).toBe(true);
      });
      // Every declared input is used somewhere.
      for (const key of inputs)
        expect(
          t.steps.some((s) => (s.prompt ?? "").includes(`{{input.${key}}}`) || (s.prompt ?? "").includes("{{inputs}}")),
          `${t.key} input ${key}`,
        ).toBe(true);
    }
  });

  it("never ends on an AI result nobody checked", () => {
    for (const t of all) {
      const last = t.steps.map((s) => s.kind).lastIndexOf("ai");
      expect(last, t.key).toBeGreaterThanOrEqual(0);
      expect(
        t.steps.slice(last + 1).some((s) => s.kind === "check" || s.kind === "approval"),
        t.key,
      ).toBe(true);
    }
  });

  it("keeps commands off the company's AI and options behind choices", () => {
    for (const t of all) {
      if (t.config.environment.kind === "assistant") {
        expect(
          t.steps.some((s) => s.kind === "command" || (s.kind === "check" && s.command)),
          t.key,
        ).toBe(false);
        expect(t.config.output.files, t.key).toBe(false);
      }
      for (const f of t.config.inputs) {
        if (f.type === "choice") expect(f.options?.length ?? 0, `${t.key}/${f.key}`).toBeGreaterThanOrEqual(2);
        if (f.type === "choice" && f.default) expect(f.options, `${t.key}/${f.key}`).toContain(f.default);
      }
      // A check that sends work back needs an AI step to send it to.
      t.steps.forEach((s, i) => {
        if (s.kind === "check" && (s.attempts ?? 0) > 0)
          expect(
            t.steps.slice(0, i).some((x) => x.kind === "ai"),
            `${t.key}/${s.key}`,
          ).toBe(true);
      });
      for (const s of t.steps) for (const text of texts(s)) expect(text.trim().length, `${t.key}/${s.key}`).toBeGreaterThan(0);
    }
  });
});

describe("workflow templates in other languages", () => {
  it("Chinese and Spanish read the English templates", () => {
    expect(templatesFor("zh")).toEqual(templatesFor("en"));
    expect(templatesFor("es")).toEqual(templatesFor("en"));
  });

  it("Vietnamese keeps every placeholder of the English prompt", () => {
    const en = templatesFor("en");
    const vi = templatesFor("vi");
    en.forEach((t, k) =>
      t.steps.forEach((s, i) => {
        const names = (x?: string) => [...(x ?? "").matchAll(PH)].map((m) => m[1]).sort();
        expect(names(vi[k]!.steps[i]!.prompt), `${t.key}/${s.key}`).toEqual(names(s.prompt));
        expect((vi[k]!.steps[i]!.criteria ?? "").split("\n").length, `${t.key}/${s.key} criteria`).toBe((s.criteria ?? "").split("\n").length);
      }),
    );
  });

  it("covers every department but 'creative' and 'other', engineering first", () => {
    const en = templatesFor("en");
    expect(en[0]!.key).toBe("ship-change");
    const have = new Set(en.map((t) => t.category));
    for (const c of CATEGORIES) if (c !== "creative" && c !== "other") expect(have.has(c), c).toBe(true);
  });
});
