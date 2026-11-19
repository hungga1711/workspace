import type { MetadataRoute } from "next";
import { SITE } from "@/lib/site";
import { source } from "@/lib/source";

// Static export: Next writes this as out/sitemap.xml at build time. The landing page first, then every docs page.
export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  const docs = source.getPages().map((page) => ({
    url: `${SITE.url}${page.url}`,
    changeFrequency: "monthly" as const,
    priority: page.url === "/docs" ? 0.8 : 0.6,
  }));
  return [{ url: `${SITE.url}/`, changeFrequency: "weekly", priority: 1 }, ...docs];
}
