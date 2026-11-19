import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Inject, NotFoundException, Put, Req } from "@nestjs/common";
import type { Request } from "express";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { getRequestContext, withTransaction } from "@workspace/shared";
import { assertAllowed, requirePrincipal } from "@workspace/service-kit";
import { readWorkspaceConfig } from "./config.js";
import { POOL, audit, emit } from "./common.js";

/** Logos are small marks, not photos: 256 KB is plenty for a 512 px PNG or an SVG. */
const LOGO_MAX = 256 * 1024;
const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"] as const;
const uploadSchema = z.object({
  contentType: z.enum(LOGO_TYPES),
  data: z
    .string()
    .min(1)
    .max(Math.ceil((LOGO_MAX * 4) / 3) + 4),
});

/** Where the web loads it from: the gateway's public route, versioned so each upload may be cached for a year. */
export const logoUrl = (version: number) => `/api/workspace-logo?v=${version}`;

/**
 * The bytes must be what the type says: a PNG, JPEG or WebP signature, or an SVG document with no scripts, event
 * handlers or external references (it is served with a sandboxing CSP as well, see the gateway's /api/workspace-logo).
 */
export function logoMatches(contentType: string, b: Buffer): boolean {
  if (contentType === "image/jpeg") return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (contentType === "image/png") return b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (contentType === "image/webp") return b.length > 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP";
  const text = b.toString("utf8");
  return /^<svg[\s>]/i.test(afterSvgProlog(text)) && !/<script|<foreignObject|\son[a-z]+\s*=|javascript:|(?:href|src)\s*=\s*["']\s*(?:https?:|\/\/|data:)/i.test(text);
}

/** Points config.branding.logoUrl at the current logo (or none), as a new config version other modules follow. */
async function setLogoUrl(c: PoolClient, url: string | null) {
  const row = (await c.query<{ config: unknown }>("SELECT config FROM workspace_config FOR UPDATE")).rows[0];
  if (!row) throw new NotFoundException({ error: "not_set_up" });
  const config = readWorkspaceConfig(row.config);
  config.branding.logoUrl = url;
  const r = await c.query<{ version: number }>("UPDATE workspace_config SET config = $1, version = version + 1, updated_at = now() RETURNING version", [JSON.stringify(config)]);
  await emit(c, getRequestContext().actorId, "platform.workspace.config_changed.v1", { version: r.rows[0]!.version, config });
}

/** Admin › Cài đặt › Branding: upload, replace or remove the company logo; anyone (even signed out) can load it. */
@Controller()
export class LogoController {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  @Put("workspace/logo")
  async upload(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "workspace.configure");
    const parsed = uploadSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException({ error: "invalid_image", message: "send a PNG, JPEG, WebP or SVG image as base64" });
    const image = Buffer.from(parsed.data.data, "base64");
    if (image.length === 0 || image.length > LOGO_MAX)
      throw new BadRequestException({ error: "image_too_large", maxBytes: LOGO_MAX, message: `the logo must be at most ${LOGO_MAX / 1024} KB` });
    if (!logoMatches(parsed.data.contentType, image)) throw new BadRequestException({ error: "invalid_image", message: "the file is not a valid image of that type" });
    return withTransaction(this.pool, async (c) => {
      const v = (
        await c.query<{ version: number }>(
          // The version is the upload time (seconds), never reused, even after a removal: each URL is one image for good.
          `INSERT INTO workspace_logo (content_type, image, version) VALUES ($1, $2, floor(extract(epoch FROM clock_timestamp()))::int)
           ON CONFLICT (singleton) DO UPDATE SET content_type = EXCLUDED.content_type, image = EXCLUDED.image,
             version = greatest(workspace_logo.version + 1, EXCLUDED.version), updated_at = now()
           RETURNING version`,
          [parsed.data.contentType, image],
        )
      ).rows[0]!.version;
      await setLogoUrl(c, logoUrl(v));
      await audit(c, getRequestContext().actorId, "workspace.logo_set", "workspace", "workspace", { bytes: image.length, contentType: parsed.data.contentType });
      return { logoUrl: logoUrl(v) };
    });
  }

  @Delete("workspace/logo")
  @HttpCode(204)
  async remove(@Req() req: Request) {
    const p = requirePrincipal(req);
    assertAllowed(p, "workspace.configure");
    await withTransaction(this.pool, async (c) => {
      await c.query("DELETE FROM workspace_logo");
      await setLogoUrl(c, null);
      await audit(c, getRequestContext().actorId, "workspace.logo_removed", "workspace", "workspace", {});
    });
  }

  /** Public (no principal; see app.ts): the bytes as base64 for the gateway, which serves them as an image. */
  @Get("logo")
  async logo() {
    const row = (await this.pool.query<{ content_type: string; image: Buffer; version: number }>("SELECT content_type, image, version FROM workspace_logo")).rows[0];
    if (!row) throw new NotFoundException({ error: "no_logo" });
    return { contentType: row.content_type, data: row.image.toString("base64"), version: row.version };
  }
}

/** What follows an SVG file's prolog: the XML declaration, comments and a doctype, skipped without backtracking. */
function afterSvgProlog(text: string): string {
  let s = text.trimStart();
  if (s.startsWith("<?xml")) s = s.slice(s.indexOf(">") + 1).trimStart();
  while (s.startsWith("<!--")) {
    const end = s.indexOf("-->");
    if (end < 0) return "";
    s = s.slice(end + 3).trimStart();
  }
  if (/^<!DOCTYPE svg/i.test(s)) s = s.slice(s.indexOf(">") + 1).trimStart();
  return s;
}
