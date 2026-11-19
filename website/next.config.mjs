import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  // Fully static: deployable to GitHub Pages, Cloudflare Pages, Netlify or any web server.
  output: "export",
  reactStrictMode: true,
  images: { unoptimized: true },
  // Styles arrive with the HTML instead of as a render-blocking request: most visitors are here for the first time,
  // and Tailwind keeps the stylesheet small.
  experimental: { inlineCss: true },
};

export default withMDX(config);
