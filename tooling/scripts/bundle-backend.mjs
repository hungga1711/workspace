// Production bundle of the backend for the Docker image (infra/docker/Dockerfile).
//
//   node tooling/scripts/bundle-backend.mjs <out-dir>
//
// 1. esbuild turns each entry point (the server, the migration runner and the ops tools) into one ESM file,
//    starting from the tsc output (`dist/`), which already carries the decorator metadata NestJS needs.
// 2. Some packages stay external: NestJS/rxjs/reflect-metadata compare classes and registries across packages,
//    bcrypt is a native addon, and the database, HTTP, socket and S3 clients load optional parts at run time.
// 3. @vercel/nft traces which files of those external packages are actually loaded, and only those are copied,
//    so the image carries no dev dependencies, types, docs or unused files.
//
// The output mirrors the repository layout, so the bundles resolve their externals through the same pnpm
// symlinks: <out>/backend/server/dist/main.js, <out>/backend/server/migrations/,
// <out>/backend/packages/service-kit/dist/{dlq,migrate-all}.js and <out>/node_modules/.pnpm/….
import { existsSync, realpathSync } from "node:fs";
import { cp, lstat, mkdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { nodeFileTrace } from "@vercel/nft";
import resolveDependencyModule from "@vercel/nft/out/resolve-dependency.js";
import { build } from "esbuild";

const resolveDependency = resolveDependencyModule.default ?? resolveDependencyModule;
const root = resolve(import.meta.dirname, "../..");
if (!process.argv[2]) {
  console.error("usage: node tooling/scripts/bundle-backend.mjs <out-dir>");
  process.exit(2);
}
const out = resolve(process.argv[2]);
const SERVER = "backend/server";
const KIT = "backend/packages/service-kit";

const EXTERNAL = [
  // Database, HTTP, sockets, logging and S3: loaded from node_modules as installed.
  "pg",
  "pg-pool",
  "express",
  "socket.io",
  "@socket.io/*",
  "pino",
  "@aws-sdk/*",
  // One copy per process: classes and metadata registries are compared across these packages.
  "@nestjs/*",
  "reflect-metadata",
  "rxjs",
  "rxjs/*",
  // Native addon (prebuilt for glibc and musl).
  "bcrypt",
  // The MCP SDK (~650 KB with its schemas) is imported on the first /api/mcp request only; inlined, the server
  // would parse it at startup.
  "@modelcontextprotocol/sdk",
  "@modelcontextprotocol/sdk/*",
  // PDF export (loaded on the first PDF made) reads its own font metrics and data files from its folder at run time.
  "pdfkit",
  // Optional native peers some packages try to load; absent on purpose.
  "pg-native",
  "bufferutil",
  "utf-8-validate",
];

// CommonJS code inside an ESM bundle still calls require() and reads __dirname.
const banner = [
  'import { createRequire as __wxCreateRequire } from "node:module";',
  'import { fileURLToPath as __wxFileURLToPath } from "node:url";',
  'import { dirname as __wxDirname } from "node:path";',
  "const require = __wxCreateRequire(import.meta.url);",
  "const __filename = __wxFileURLToPath(import.meta.url);",
  "const __dirname = __wxDirname(__filename);",
].join("\n");

/** [entry (repository-relative), bundle (repository-relative)] */
const entries = [
  [`${SERVER}/dist/main.js`, `${SERVER}/dist-bundle/main.js`],
  [`${SERVER}/dist/modules/search/reindex-cli.js`, `${SERVER}/dist-bundle/reindex-cli.js`],
  [`${KIT}/dist/cli/dlq.js`, `${KIT}/dist-bundle/dlq.js`],
  // Next to service-kit, where `pg` resolves; the image sets WORKSPACE_ROOT so it still finds the migrations.
  ["tooling/scripts/migrate-all.mjs", `${KIT}/dist-bundle/migrate-all.js`],
];

/** Package directory a bundle belongs to (its externals resolve from there). */
const packageOf = (bundle) => bundle.split("/dist-bundle/")[0];
// Externals a bundle imports through code it inlined from another workspace package (service-kit's pino,
// …) are not dependencies of the bundle's own package. They resolve through
// that other package instead, and a symlink in the bundle's package node_modules makes Node find them.
const FALLBACK = [KIT, "backend/packages/shared", "backend/packages/contracts"];
const packageName = (spec) => (spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);
/** links[bundle package] = Map(external package name → real directory) */
const links = new Map();

for (const [entry, bundle] of entries) {
  const result = await build({
    entryPoints: [join(root, entry)],
    outfile: join(root, bundle),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: EXTERNAL,
    banner: { js: banner },
    // NestJS logs and some error paths use class and function names.
    keepNames: true,
    minifyWhitespace: true,
    minifySyntax: true,
    // License notices of bundled packages stay at the end of each bundle.
    legalComments: "eof",
    logLevel: "warning",
    metafile: true,
  });
  const pkg = packageOf(bundle);
  const names = new Set(
    Object.values(result.metafile.outputs)
      .flatMap((o) => o.imports)
      .filter((i) => i.external && !i.path.startsWith("node:") && !builtinModules.includes(i.path))
      .map((i) => packageName(i.path)),
  );
  for (const name of names) {
    if (existsSync(join(root, pkg, "node_modules", name))) continue;
    const from = FALLBACK.find((d) => existsSync(join(root, d, "node_modules", name)));
    // Not installed anywhere: an optional dependency the package loads inside try/catch (node-fetch's "encoding").
    if (!from) {
      console.warn(`${bundle}: optional "${name}" is not installed (left out)`);
      continue;
    }
    if (!links.has(pkg)) links.set(pkg, new Map());
    links.get(pkg).set(name, realpathSync(join(root, from, "node_modules", name)));
  }
}

// Files the bundles load at run time: the externals, followed through their own requires. nft resolves the
// fallback externals above the way Node will once the symlinks exist.
const { fileList, warnings } = await nodeFileTrace(
  entries.map(([, b]) => join(root, b)),
  {
    base: root,
    // Bundles are self-contained except for externals; nothing in the workspace sources is loaded.
    ignore: (p) => p.endsWith(".d.ts") || p.endsWith(".map") || /(^|\/)(README|CHANGELOG|HISTORY)(\.\w+)?$/i.test(p),
    async resolve(id, parent, job, cjs) {
      try {
        return await resolveDependency(id, parent, job, cjs);
      } catch (e) {
        const pkg = [...links.keys()].find((k) => parent.startsWith(join(root, k) + "/"));
        const dir = pkg && links.get(pkg).get(packageName(id));
        if (!dir) throw e;
        // Resolve as if the importer sat inside the package that really depends on it.
        return resolveDependency(id, join(dir, "..", "__workspace_importer.js"), job, cjs);
      }
    },
  },
);
const unresolved = [...warnings].filter((w) => String(w.message).includes("Failed to resolve dependency") && /dist-bundle/.test(String(w.message)));
for (const w of unresolved) console.warn("nft:", w.message);

await rm(out, { recursive: true, force: true });
let files = 0;
for (const f of [...fileList].sort()) {
  const src = join(root, f);
  // Bundles land where the tsc output sits in the image (dist/), not in dist-bundle/.
  const dest = join(out, f.replace(/\/dist-bundle\//, "/dist/"));
  await mkdir(dirname(dest), { recursive: true });
  const st = await lstat(src);
  if (st.isSymbolicLink()) await symlink(await readlink(src), dest).catch((e) => (e.code === "EEXIST" ? undefined : Promise.reject(e)));
  else if (st.isFile()) {
    await cp(src, dest);
    files++;
  }
}
for (const [pkg, names] of links) {
  for (const [name, dir] of names) {
    const link = join(out, pkg, "node_modules", name);
    await mkdir(dirname(link), { recursive: true });
    await symlink(relative(dirname(link), join(out, relative(root, dir))), link).catch((e) => (e.code === "EEXIST" ? undefined : Promise.reject(e)));
  }
}
await cp(join(root, `${SERVER}/migrations`), join(out, `${SERVER}/migrations`), { recursive: true });
// The fonts embedded in the PDFs the AI makes (office/write-pdf.ts finds them above its own folder).
await cp(join(root, `${SERVER}/assets`), join(out, `${SERVER}/assets`), { recursive: true });
await writeFile(join(out, "package.json"), JSON.stringify({ name: "workspace-runtime", private: true, type: "module" }, null, 2));
// The intermediate bundles are not kept in the working tree.
for (const [, bundle] of entries) await rm(join(root, dirname(bundle)), { recursive: true, force: true });
console.log(`bundled ${entries.length} entry points; ${files} files traced into ${relative(root, out) || out}`);
