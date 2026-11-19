import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { parseStack, repoPath } = await import("./symbolicate");

describe("symbolicate: stack parsing", () => {
  it("reads Chrome and Firefox frames, named or not, and stops at the limit", () => {
    const chrome = `TypeError: i is not a function
    at o_ (http://localhost:3000/_next/static/chunks/68c35ae9-856dee6d9531f451.js:1:82069)
    at http://localhost:3000/_next/static/chunks/app/layout-1.js:2:30
    at Array.forEach (<anonymous>)`;
    expect(parseStack(chrome)).toEqual([
      expect.objectContaining({ name: "o_", url: "http://localhost:3000/_next/static/chunks/68c35ae9-856dee6d9531f451.js", line: 1, col: 82069 }),
      expect.objectContaining({ name: null, url: "http://localhost:3000/_next/static/chunks/app/layout-1.js", line: 2, col: 30 }),
    ]);
    const gecko = "render@https://work.example.com/_next/static/chunks/a.js:3:4\n@https://work.example.com/_next/static/chunks/b.js:5:6";
    expect(parseStack(gecko).map((f) => [f.name, f.line, f.col])).toEqual([
      ["render", 3, 4],
      [null, 5, 6],
    ]);
    expect(parseStack(Array.from({ length: 20 }, (_, i) => `    at f${i} (http://x/_next/static/chunks/c.js:${i + 1}:1)`).join("\n"))).toHaveLength(6);
    expect(parseStack(null)).toEqual([]);
  });
});

describe("symbolicate: source paths", () => {
  it("names app files by their repo path and packages by name", () => {
    expect(repoPath("webpack://_N_E/./src/components/work/Board.tsx")).toBe("frontend/web/src/components/work/Board.tsx");
    expect(repoPath("webpack://_N_E/(app-pages-browser)/./src/lib/ui.ts")).toBe("frontend/web/src/lib/ui.ts");
    expect(repoPath("webpack://_N_E/../../node_modules/.pnpm/react-dom@19.0.0/node_modules/react-dom/cjs/react-dom-client.production.js")).toBe(
      "node_modules/react-dom/cjs/react-dom-client.production.js",
    );
    expect(repoPath("webpack://_N_E/./node_modules/@dnd-kit/core/dist/core.esm.js")).toBe("node_modules/@dnd-kit/core/dist/core.esm.js");
  });
});
