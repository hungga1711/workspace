import type { MetadataRoute } from "next";

/** A self-hosted workspace is private: nothing on it is for search engines. */
export default function robots(): MetadataRoute.Robots {
  return { rules: [{ userAgent: "*", disallow: "/" }] };
}
