import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // A separate output dir lets a production build run next to `next dev` (e.g. NEXT_DIST_DIR=.next-prod).
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // The static live demo (tooling/live-demo) lives under a folder of the public site; installations have no base path.
  ...(process.env.NEXT_BASE_PATH ? { basePath: process.env.NEXT_BASE_PATH } : {}),
  // Docker image (infra/docker/Dockerfile): a self-contained server with only the files it needs, traced from
  // the monorepo root so workspace packages and pnpm's symlinked node_modules are included.
  ...(process.env.NEXT_OUTPUT === "standalone" ? { output: "standalone", outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)) } : {}),
  // The Docker image build (NEXT_SKIP_CHECKS=1) skips type checking and lint: CI runs both, and they would
  // double the memory the build needs on a small server.
  ...(process.env.NEXT_SKIP_CHECKS === "1" ? { typescript: { ignoreBuildErrors: true }, eslint: { ignoreDuringBuilds: true } } : {}),
  // Browser source maps are served with the build: the error screen's code (Admin › Lỗi trình duyệt) resolves a
  // minified stack to file and line with them (src/lib/symbolicate.ts). Self-hosted, so the source is not a secret.
  productionBrowserSourceMaps: true,
  reactStrictMode: true,
  // The dev-only "static route" toast is a role=status element that collides with app status messages in tests.
  devIndicators: { appIsrStatus: false },
  poweredByHeader: false,
  // `turbo: {}` only tells Next that Turbopack (the default for `pnpm dev`, see scripts/dev.mjs) is intended, so it
  // stops warning about the webpack block below. optimizePackageImports applies to webpack and `next build`.
  experimental: { turbo: {}, optimizePackageImports: ["@dnd-kit/core", "@dnd-kit/sortable"] },
  // `DEV_BUNDLER=webpack pnpm dev` (webpack) watches only source: build outputs, test reports, git and installed
  // packages are skipped, so the watcher stays small (macOS "EMFILE: too many open files, watch"). Restart after
  // installs. Turbopack has its own watcher and ignores this block.
  webpack(config, { dev, webpack }) {
    // The whiteboard editor (@excalidraw/excalidraw) imports ~55 UI translations and Mermaid (with dozens of diagram
    // chunks) on demand. Every async chunk adds an entry to the webpack runtime that every route loads, so only the
    // translations we use are kept (English, Vietnamese, Chinese, Spanish) and Mermaid import is left out (its
    // "Mermaid to diagram" dialog is not offered on our boards).
    config.plugins.push(
      new webpack.IgnorePlugin({ resourceRegExp: /^\.\/locales\/(?!(vi-VN|en|zh-CN|es-ES)-)/, contextRegExp: /@excalidraw[\\/]excalidraw/ }),
      new webpack.IgnorePlugin({ resourceRegExp: /^@excalidraw\/mermaid-to-excalidraw$/ }),
    );
    if (dev) config.watchOptions = { ...config.watchOptions, ignored: ["**/node_modules/**", "**/.git/**", "**/.next*/**", "**/test-results/**", "**/playwright-report/**"] };
    return config;
  },
  skipTrailingSlashRedirect: true,
  // MCP for AI agents (docs/integrations/mcp.md): the endpoint and its OAuth protocol routes belong to the server. The
  // production proxy (Caddy) sends them there directly; these rewrites make the app's own address work too (development,
  // or a proxy that forwards everything here), so an MCP client only ever needs the app URL. The consent page
  // (/oauth/authorize) is a page of this app.
  async rewrites() {
    const gateway = (process.env.GATEWAY_URL ?? "http://localhost:4000").replace(/\/$/, "");
    return {
      afterFiles: [
        "/api/mcp",
        // A workflow's address for systems outside (no sign-in; the token in it is the credential).
        "/api/hooks/:token",
        // The workflow runner and the token collector on people's computers are given the app URL too.
        "/api/work/runner/:path*",
        "/api/ai/local-usage",
        "/api/ai/local-usage/:path*",
        // …and so is the connect program (workspace-connect.mjs): its heartbeat, its questions, the safety net.
        "/api/ai/local/:path*",
        "/.well-known/oauth-protected-resource",
        "/.well-known/oauth-protected-resource/:path*",
        "/.well-known/oauth-authorization-server",
        "/.well-known/oauth-authorization-server/:path*",
        "/oauth/token",
        "/oauth/register",
        "/oauth/revoke",
      ].map((source) => ({ source, destination: `${gateway}${source}` })),
      // Integrations with a workspace API key (Authorization: Bearer wos_…) use the app URL as their API base too, so a
      // company without a separate API domain still has one address; the browser never sends such a header here.
      beforeFiles: ["/api/:path*"].map((source) => ({
        source,
        has: [{ type: "header", key: "authorization", value: "Bearer wos_.*" }],
        destination: `${gateway}${source}`,
      })),
    };
  },
  async headers() {
    // Content Security Policy: only our origin, object storage (presigned up/downloads) and the realtime endpoint.
    // Next's inline bootstrap needs 'unsafe-inline' for scripts on static pages; remote scripts, plugins, framing
    // and form posts elsewhere are all blocked. Files on local disk are served at /storage/ on the app's own origin
    // in production ('self'); development may use the S3 container (:8333) or the server (:4000).
    // Presigned uploads go straight to object storage, so its origin must be allowed, in production too (S3_ENDPOINT
    // or S3_PUBLIC_ENDPOINT, not only STORAGE_PUBLIC_ORIGIN).
    const origin = (u) => {
      try {
        return u ? new URL(u).origin : "";
      } catch {
        return "";
      }
    };
    const storage = [
      process.env.STORAGE_PUBLIC_ORIGIN,
      origin(process.env.S3_PUBLIC_ENDPOINT || process.env.S3_ENDPOINT),
      origin(process.env.STORAGE_PUBLIC_URL),
      ...(process.env.NODE_ENV === "production" ? [] : ["http://localhost:8333", "http://localhost:4000"]),
    ]
      .filter(Boolean)
      .filter((v, i, a) => a.indexOf(v) === i)
      .join(" ");
    const chat = process.env.NEXT_PUBLIC_CHAT_URL ?? "http://localhost:4000";
    const chatWs = chat.replace(/^http/, "ws");
    // Video meetings: the browser talks to the LiveKit SFU directly (signalling over WebSocket). Only when this
    // server has one (LIVEKIT_URL; the local container in development), so the policy lists nothing unused.
    const livekit = process.env.LIVEKIT_URL || (process.env.NODE_ENV === "development" ? "ws://localhost:7880" : "");
    const livekitHttp = livekit.replace(/^ws/, "http");
    const https = (process.env.APP_URL ?? "").startsWith("https://");
    const csp = [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}`,
      "style-src 'self' 'unsafe-inline'",
      `img-src 'self' data: blob: ${storage}`,
      `media-src 'self' blob: ${storage}`,
      "font-src 'self' data:",
      `connect-src 'self' ${storage} ${chat} ${chatWs}${livekit ? ` ${livekit} ${livekitHttp}` : ""}`,
      "worker-src 'self' blob:",
      // A design opened inside a task (the integrations hub, on click): only the viewers of the integrations shipped.
      "frame-src 'self' https://www.figma.com",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
      ...(https ? ["upgrade-insecure-requests"] : []),
    ].join("; ");
    const security = [
      { key: "Content-Security-Policy", value: csp },
      ...(https ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }] : []),
      { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "X-Frame-Options", value: "DENY" },
      // Camera, microphone and screen share for our own pages only (video meetings).
      { key: "Permissions-Policy", value: "camera=(self), microphone=(self), display-capture=(self), geolocation=()" },
    ];
    // A self-hosted workspace is private: nothing on it is for search engines (robots.ts says the same).
    return [{ source: "/:path*", headers: [...security, { key: "X-Robots-Tag", value: "noindex, nofollow" }] }];
  },
};
// `ANALYZE=1 next build`: what each bundle is made of (reports in <distDir>/analyze, JSON stats for scripts).
const analyze =
  process.env.ANALYZE === "1" ? (await import("@next/bundle-analyzer")).default({ enabled: true, openAnalyzer: false, analyzerMode: "static", generateStatsFile: true }) : (c) => c;
export default analyze(nextConfig);
