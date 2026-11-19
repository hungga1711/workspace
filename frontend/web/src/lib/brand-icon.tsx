import { ImageResponse } from "next/og";
import { markSvg, MARK_ON_LIGHT } from "@/lib/brand-mark";

/**
 * The workspace app icon (lib/brand-mark.ts) as a PNG at any size. `maskable` fills the whole canvas and keeps the glyph inside the 80% safe zone for Android.
 */
export function brandIcon(size: number, maskable = false): ImageResponse {
  const glyph = Math.round(size * (maskable ? 0.72 : 1));
  const radius = maskable ? 0 : size * 0.25;
  return new ImageResponse(
    (
      <div style={{ width: size, height: size, display: "flex", alignItems: "center", justifyContent: "center", background: MARK_ON_LIGHT.tile, borderRadius: radius }}>
        <img src={`data:image/svg+xml;base64,${Buffer.from(markSvg({ ...MARK_ON_LIGHT, tile: "transparent" })).toString("base64")}`} width={glyph} height={glyph} alt="" />
      </div>
    ),
    { width: size, height: size },
  );
}
