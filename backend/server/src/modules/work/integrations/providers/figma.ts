import { defineIntegration, okJson, type ProviderContext } from "../define.js";

/**
 * Figma: a design file, or one frame of it, on the task it is for: a preview, its name, when it last changed, and the
 * design itself in a frame when someone opens it. Token: a personal access token with "File content: read".
 */
const headers = (ctx: ProviderContext) => ({ "x-figma-token": ctx.token, accept: "application/json" });

export const figma = defineIntegration({
  id: "figma",
  name: "Figma",
  category: "design",
  summary: "Design files and frames on the tasks they are for: a preview, when it last changed, and the design a click away.",
  webBase: "https://www.figma.com",
  apiBase: "https://api.figma.com",
  tokenHelp: {
    url: "https://help.figma.com/hc/en-us/articles/8085703771159-Manage-personal-access-tokens",
    needs: "A personal access token with File content: Read only, of an account that can open the files to show",
  },
  embedHosts: ["www.figma.com"],
  match(url) {
    if (url.hostname !== "www.figma.com" && url.hostname !== "figma.com") return null;
    const m = /^\/(file|design|proto|board)\/([A-Za-z0-9]{10,40})(?:\/([^/?#]*))?/.exec(url.pathname);
    if (!m) return null;
    // A frame is named in the address as 12-34; the API calls it 12:34.
    const node = (url.searchParams.get("node-id") ?? "").replace("-", ":");
    const valid = /^\d+:\d+$/.test(node) ? node : "";
    return { key: `${m[2]}${valid ? `@${valid}` : ""}`, kind: "design", data: { file: m[2]!, node: valid, type: m[1]! } };
  },
  async fetch(ref, ctx) {
    const { file, node, type } = ref.data as { file: string; node: string; type: string };
    const f = okJson<{ name: string; lastModified: string; thumbnailUrl?: string }>(
      "Figma",
      await ctx.request(`${ctx.apiBase}/v1/files/${file}?depth=1`, { headers: headers(ctx) }),
    );
    let frame = "";
    let image = f.thumbnailUrl;
    if (node) {
      // The frame's own name and picture; the file's stand in when either cannot be read.
      const [nodes, images] = await Promise.all([
        ctx
          .request(`${ctx.apiBase}/v1/files/${file}/nodes?ids=${encodeURIComponent(node)}&depth=1`, { headers: headers(ctx) })
          .then((r) => (r.status === 200 ? r.json<{ nodes: Record<string, { document?: { name?: string } } | null> }>() : null)),
        ctx
          .request(`${ctx.apiBase}/v1/images/${file}?ids=${encodeURIComponent(node)}&format=png&scale=0.5`, { headers: headers(ctx) })
          .then((r) => (r.status === 200 ? r.json<{ images: Record<string, string | null> }>() : null)),
      ]);
      frame = nodes?.nodes?.[node]?.document?.name ?? "";
      image = images?.images?.[node] ?? image;
    }
    const web = `https://www.figma.com/${type === "file" ? "design" : type}/${file}${node ? `?node-id=${node.replace(":", "-")}` : ""}`;
    return {
      kind: "design",
      title: frame || f.name,
      ref: frame ? `${f.name} › ${frame}` : f.name,
      state: "none",
      updatedAt: f.lastModified,
      thumbnailUrl: image,
      embedUrl: `https://www.figma.com/embed?embed_host=workspace&url=${encodeURIComponent(web)}`,
    };
  },
  async check(ctx) {
    const me = okJson<{ handle?: string; email?: string }>("Figma", await ctx.request(`${ctx.apiBase}/v1/me`, { headers: headers(ctx) }));
    return { account: me.email ?? me.handle ?? "Figma" };
  },
});
