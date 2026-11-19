import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Param, Put, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { assertAllowed, requirePrincipal } from "@workspace/service-kit";
import { withTransaction } from "@workspace/shared";
import { POOL } from "./identity.controller.js";
import { audit, emit } from "./repo.js";

/** Full names: letters (any script, with their marks), spaces, apostrophes, dots and hyphens, as the given name. */
const displayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[\p{L}\p{M}' .-]+$/u, "letters only")
  .transform((s) => s.replace(/\s+/g, " "));

/** What the browser sends: the cropped photo, already resized (256 px), as base64 (identity's JSON limit is 100 KB). */
const AVATAR_MAX = 64 * 1024;
const avatarSchema = z.object({ contentType: z.enum(["image/webp", "image/jpeg", "image/png"]), data: z.string().min(1).max(90_000) });

/** The file's own signature must match the declared type: a renamed HTML or SVG file is refused. */
export function imageMatches(contentType: string, b: Buffer): boolean {
  if (contentType === "image/jpeg") return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (contentType === "image/png") return b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return b.length > 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP";
}

/**
 * Self-service profile in Của tôi › Hồ sơ: one's full name and photo. Renaming emits identity.member.renamed.v1 so
 * the employee profile and people search follow. Photos are served at a versioned URL (the directory carries
 * `avatarVersion`), so browsers may keep them for a year.
 */
@Controller()
export class ProfileController {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  @Put("me/display-name")
  async rename(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    if (p.type !== "user") throw new ForbiddenException();
    const parsed = z.object({ displayName: displayNameSchema }).safeParse(body);
    if (!parsed.success) throw new BadRequestException({ error: "invalid_name", message: parsed.error.issues[0]?.message });
    const name = parsed.data.displayName;
    return withTransaction(this.pool, async (c) => {
      const cur = (await c.query<{ display_name: string; email: string }>("SELECT display_name, email FROM members WHERE user_id = $1 FOR UPDATE", [p.id])).rows[0];
      if (!cur) throw new NotFoundException();
      if (cur.display_name !== name) {
        await c.query("UPDATE members SET display_name = $2, updated_at = now() WHERE user_id = $1", [p.id, name]);
        await audit(c, "member.renamed", "member", p.id, { from: cur.display_name, to: name });
        await emit(c, "identity.member.renamed.v1", "identity.member", p.id, { userId: p.id, email: cur.email, displayName: name });
      }
      return { displayName: name };
    });
  }

  @Put("me/avatar")
  async setAvatar(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    if (p.type !== "user") throw new ForbiddenException();
    const parsed = avatarSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException({ error: "invalid_image" });
    const image = Buffer.from(parsed.data.data, "base64");
    if (image.length === 0 || image.length > AVATAR_MAX) throw new BadRequestException({ error: "image_too_large", maxBytes: AVATAR_MAX });
    if (!imageMatches(parsed.data.contentType, image)) throw new BadRequestException({ error: "invalid_image" });
    return withTransaction(this.pool, async (c) => {
      await c.query(
        `INSERT INTO member_avatars (user_id, content_type, image) VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO UPDATE SET content_type = EXCLUDED.content_type, image = EXCLUDED.image, updated_at = now()`,
        [p.id, parsed.data.contentType, image],
      );
      const v = (
        await c.query<{ v: number }>("UPDATE members SET avatar_version = avatar_version + 1, updated_at = now() WHERE user_id = $1 RETURNING avatar_version AS v", [p.id])
      ).rows[0]?.v;
      await audit(c, "member.avatar_set", "member", p.id, { bytes: image.length, contentType: parsed.data.contentType });
      return { avatarVersion: v ?? 0 };
    });
  }

  @Delete("me/avatar")
  @HttpCode(204)
  async removeAvatar(@Req() req: Request) {
    const p = requirePrincipal(req);
    if (p.type !== "user") throw new ForbiddenException();
    await withTransaction(this.pool, async (c) => {
      const gone = await c.query("DELETE FROM member_avatars WHERE user_id = $1", [p.id]);
      if (!gone.rowCount) return;
      await c.query("UPDATE members SET avatar_version = 0, updated_at = now() WHERE user_id = $1", [p.id]);
      await audit(c, "member.avatar_removed", "member", p.id, {});
    });
  }

  /** A colleague's photo, for anyone who can see the directory. `?v=` only busts caches; the newest photo is served. */
  @Get("members/:userId/avatar")
  async avatar(@Req() req: Request, @Res() res: Response, @Param("userId") userId: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "member.read");
    const row = await withTransaction(
      this.pool,
      async (c) => (await c.query<{ content_type: string; image: Buffer }>("SELECT content_type, image FROM member_avatars WHERE user_id = $1", [userId])).rows[0],
    );
    if (!row) throw new NotFoundException();
    res.setHeader("content-type", row.content_type);
    res.setHeader("cache-control", req.query.v ? "private, max-age=31536000, immutable" : "private, no-cache");
    res.setHeader("x-content-type-options", "nosniff");
    res.end(row.image);
  }
}
