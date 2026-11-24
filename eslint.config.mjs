import js from "@eslint/js";
import tseslint from "typescript-eslint";
import { dirname, resolve, sep } from "node:path";

const ro = (names) => Object.fromEntries(names.map((n) => [n, "readonly"]));
const NODE = ro([
  "process",
  "console",
  "Buffer",
  "URL",
  "URLSearchParams",
  "fetch",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "AbortController",
  "structuredClone",
  "FormData",
  "Request",
]);
const BROWSER = ro([
  "window",
  "document",
  "location",
  "navigator",
  "console",
  "chrome",
  "fetch",
  "URL",
  "URLSearchParams",
  "Element",
  "Node",
  "HTMLElement",
  "MutationObserver",
  "CustomEvent",
  "Event",
  "KeyboardEvent",
  "AbortController",
  "crypto",
  "TextEncoder",
  "TextDecoder",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "requestAnimationFrame",
  "localStorage",
  "sessionStorage",
]);

/**
 * Module boundaries inside the one backend process (ADR 0021): code under `backend/server/src/modules/<a>/` never
 * imports another module's code. Modules talk through ServiceClient (`moduleUrl`) or events; what they share lives in
 * backend/packages. Integration tests may compose several modules.
 */
const MODULES_DIR = `${sep}backend${sep}server${sep}src${sep}modules${sep}`;
const moduleOf = (file) => {
  const i = file.indexOf(MODULES_DIR);
  return i >= 0 ? file.slice(i + MODULES_DIR.length).split(sep)[0] : null;
};
const moduleBoundaries = {
  meta: { type: "problem", messages: { cross: "Module {{from}} imports module {{to}}'s code: call it through ServiceClient (moduleUrl) or an event instead." } },
  create(context) {
    const from = moduleOf(context.filename);
    if (!from) return {};
    const check = (node) => {
      const spec = node.source?.value;
      if (typeof spec !== "string" || !spec.startsWith(".")) return;
      const target = resolve(dirname(context.filename), spec);
      const i = target.indexOf(MODULES_DIR);
      if (i < 0) return;
      const to = target.slice(i + MODULES_DIR.length).split(sep)[0];
      if (to && to !== from) context.report({ node: node.source, messageId: "cross", data: { from, to } });
    };
    return { ImportDeclaration: check, ImportExpression: check, ExportNamedDeclaration: check, ExportAllDeclaration: check };
  },
};

/**
 * The backend server and shared packages (frontend/web has its own Next.js config).
 * Run with `pnpm lint`. Type-aware rules are left out to keep it fast; tsc covers types.
 */
export default tseslint.config(
  { ignores: ["**/dist/**", "**/dist-bundle/**", "**/node_modules/**", "frontend/web/**", "**/coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["backend/**/src/**/*.ts", "backend/**/test/**/*.ts", "backend/**/evals/**/*.ts", "tooling/**/*.mjs"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      // Event payloads and SQL rows are untyped JSON at the edges; zod parses what matters.
      "@typescript-eslint/no-explicit-any": "off",
      // NestJS controllers and injection tokens use empty classes / namespaces by design.
      "@typescript-eslint/no-extraneous-class": "off",
    },
  },
  { files: ["backend/server/src/**/*.ts"], plugins: { workspace: { rules: { "module-boundaries": moduleBoundaries } } }, rules: { "workspace/module-boundaries": "error" } },
  { files: ["**/*.mjs", "**/*.config.*"], languageOptions: { globals: NODE } },
  // k6 load-test scripts (tooling/loadtest): k6's own globals.
  // The live demo's browser runtime (D: the manifest build.mjs puts before it) and its Node preload.
  {
    files: ["tooling/live-demo/runtime.js"],
    languageOptions: {
      sourceType: "script",
      globals: { ...BROWSER, ...ro(["D", "Response", "Request", "Headers", "Error", "EventTarget", "HTMLImageElement", "history", "matchMedia", "addEventListener"]) },
    },
  },
  { files: ["tooling/live-demo/preload.cjs"], languageOptions: { sourceType: "commonjs", globals: NODE } },
  { files: ["tooling/loadtest/**/*.js"], languageOptions: { globals: { ...NODE, __ENV: "readonly", __VU: "readonly", __ITER: "readonly", open: "readonly" } } },
  // The browser extension (plain scripts loaded by Chrome).
  // `WORKSPACE_AI_SITES` is sites.js's list, loaded before the other scripts; `module` is there only under `require` (tests).
  {
    files: ["frontend/browser-extension/**/*.js"],
    languageOptions: { sourceType: "script", globals: { ...BROWSER, WORKSPACE_AI_SITES: "readonly", module: "readonly" } },
  },
  // sites.js is where the list is declared.
  { files: ["frontend/browser-extension/sites.js"], languageOptions: { globals: { WORKSPACE_AI_SITES: "off" } } },
);
