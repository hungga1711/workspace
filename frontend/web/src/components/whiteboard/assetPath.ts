/**
 * The drawing editor fetches its fonts from `EXCALIDRAW_ASSET_PATH`, then from a public CDN (esm.sh) as a fallback.
 * We serve them ourselves (public/excalidraw/, copied from the package by scripts/excalidraw-assets.mjs) so a
 * self-hosted installation works offline and the CSP stays 'self'. Imported before the editor so the path is set
 * when it builds its font list.
 *
 * The CDN fallback is still written into every font's source list, and the browser checks each source against the
 * CSP as soon as the face is created: one console violation per face (~250, most of them CJK faces never used).
 * So font faces are created without CDN sources; a face we do not serve then simply fails over to the next family.
 */
declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}

const CDN = "://esm.sh/";

if (typeof window !== "undefined") {
  window.EXCALIDRAW_ASSET_PATH = "/excalidraw/";
  const Native = window.FontFace as typeof FontFace & { __localOnly?: true };
  if (Native && !Native.__localOnly) {
    class LocalFontFace extends Native {
      constructor(family: string, source: string | BufferSource, descriptors?: FontFaceDescriptors) {
        const local =
          typeof source === "string" && source.includes(CDN)
            ? source
                .split(/,\s*(?=url\()/)
                .filter((s) => !s.includes(CDN))
                .join(", ")
            : "";
        super(family, local || source, descriptors);
      }
    }
    Object.assign(LocalFontFace, { __localOnly: true });
    window.FontFace = LocalFontFace;
  }
}
export {};
