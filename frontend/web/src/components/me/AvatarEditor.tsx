"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import { useT } from "@/lib/i18n/client";
import { btn, btnPrimary, cx } from "@/lib/ui";
import { Modal } from "@/components/ui/Modal";
import { CameraIcon } from "@/components/app/icons";

const VIEW = 224; // the on-screen crop circle, px (`size-56`)
const OUT = 256; // the stored square, px
const MAX_BYTES = 64 * 1024; // the server's limit

/** Draws the visible square of `img` (offset and zoom in view pixels) into a `size`×`size` canvas. */
function draw(ctx: CanvasRenderingContext2D, img: HTMLImageElement, size: number, zoom: number, x: number, y: number) {
  const base = VIEW / Math.min(img.naturalWidth, img.naturalHeight);
  const scale = (base * zoom * size) / VIEW;
  ctx.clearRect(0, 0, size, size);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(
    img,
    (x * size) / VIEW + size / 2 - (img.naturalWidth * scale) / 2,
    (y * size) / VIEW + size / 2 - (img.naturalHeight * scale) / 2,
    img.naturalWidth * scale,
    img.naturalHeight * scale,
  );
}

const toBlob = (canvas: HTMLCanvasElement, type: string, quality: number) => new Promise<Blob | null>((r) => canvas.toBlob(r, type, quality));

/** WebP where the browser can encode it (Safari cannot and hands back PNG), else JPEG; quality steps down to fit. */
async function encode(canvas: HTMLCanvasElement): Promise<Blob | null> {
  for (const q of [0.88, 0.8, 0.7, 0.6, 0.5]) {
    let b = await toBlob(canvas, "image/webp", q);
    if (!b || b.type !== "image/webp") b = await toBlob(canvas, "image/jpeg", q);
    if (b && b.size <= MAX_BYTES) return b;
  }
  return null;
}

const base64 = (b: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(b);
  });

/**
 * Profile photo: pick an image, drag and zoom it inside the circle, save. The crop happens in the browser (a 256 px
 * square, WebP or JPEG under 64 KB), so the server only ever stores a small photo. Loaded on demand from Hồ sơ.
 */
export function AvatarEditor({ hasPhoto, onClose, onDone }: { hasPhoto: boolean; onClose: () => void; onDone: (message: string) => void }) {
  const t = useT();
  const file = useRef<HTMLInputElement>(null);
  const view = useRef<HTMLCanvasElement>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keep the image covering the circle: the offset may not exceed what the zoomed image overhangs.
  const clamp = (x: number, y: number, z = zoom, i = img) => {
    if (!i) return { x: 0, y: 0 };
    const s = (VIEW / Math.min(i.naturalWidth, i.naturalHeight)) * z;
    const mx = Math.max(0, (i.naturalWidth * s - VIEW) / 2);
    const my = Math.max(0, (i.naturalHeight * s - VIEW) / 2);
    return { x: Math.min(mx, Math.max(-mx, x)), y: Math.min(my, Math.max(-my, y)) };
  };

  useEffect(() => {
    const c = view.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx || !img) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = VIEW * dpr;
    c.height = VIEW * dpr;
    draw(ctx, img, VIEW * dpr, zoom, pos.x, pos.y);
  }, [img, zoom, pos]);

  const pick = (f: File | undefined) => {
    if (!f) return;
    setError(null);
    const url = URL.createObjectURL(f);
    const i = new Image();
    i.onload = () => {
      URL.revokeObjectURL(url);
      setImg(i);
      setZoom(1);
      setPos({ x: 0, y: 0 });
    };
    i.onerror = () => {
      URL.revokeObjectURL(url);
      setError(t("me.profile.photoUnreadable"));
    };
    i.src = url;
  };

  const save = async () => {
    if (!img) return;
    setBusy(true);
    setError(null);
    try {
      const out = document.createElement("canvas");
      out.width = OUT;
      out.height = OUT;
      const ctx = out.getContext("2d");
      if (!ctx) throw new Error("no canvas");
      draw(ctx, img, OUT, zoom, pos.x, pos.y);
      const blob = await encode(out);
      if (!blob) throw new Error("too large");
      await api("identity/me/avatar", { method: "PUT", body: { contentType: blob.type, data: await base64(blob) } });
      onDone(t("me.profile.photoSaved"));
    } catch {
      setError(t("me.profile.photoFailed"));
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api("identity/me/avatar", { method: "DELETE" });
      onDone(t("me.profile.photoRemoved"));
    } catch {
      setError(t("me.profile.photoFailed"));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t("me.profile.photo")}
      onClose={onClose}
      footer={
        <>
          {hasPhoto && !img ? (
            <button type="button" className={cx(btn, "text-block mr-auto")} disabled={busy} onClick={() => void remove()}>
              {t("me.profile.removePhoto")}
            </button>
          ) : null}
          <button type="button" className={btn} onClick={onClose}>
            {t("me.meview.huy")}
          </button>
          <button type="button" className={btnPrimary} disabled={!img || busy} onClick={() => void save()}>
            {t("me.meview.luu")}
          </button>
        </>
      }
    >
      <div className="grid justify-items-center gap-4">
        <input ref={file} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={(e) => pick(e.target.files?.[0])} tabIndex={-1} aria-hidden="true" />
        {img ? (
          <>
            <canvas
              ref={view}
              className="bg-ground size-56 cursor-grab touch-none rounded-full active:cursor-grabbing"
              aria-label={t("me.profile.photoHint")}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                drag.current = { x: pos.x, y: pos.y, px: e.clientX, py: e.clientY };
              }}
              onPointerMove={(e) => {
                const d = drag.current;
                if (d) setPos(clamp(d.x + e.clientX - d.px, d.y + e.clientY - d.py));
              }}
              onPointerUp={() => (drag.current = null)}
              onPointerCancel={() => (drag.current = null)}
            />
            <label className="text-ink-2 flex w-full max-w-[224px] items-center gap-3 text-sm">
              {t("me.profile.photoZoom")}
              <input
                type="range"
                min={1}
                max={3}
                step={0.01}
                value={zoom}
                onChange={(e) => {
                  const z = Number(e.target.value);
                  setZoom(z);
                  setPos((p) => clamp(p.x, p.y, z));
                }}
                className="accent-ink min-w-0 flex-1"
              />
            </label>
          </>
        ) : (
          <button
            type="button"
            onClick={() => file.current?.click()}
            className="border-hairline hover:bg-hover text-ink-2 grid size-56 place-items-center content-center gap-2 rounded-full border border-dashed text-sm"
          >
            <CameraIcon className="size-6" />
            {t("me.profile.photoPick")}
          </button>
        )}
        <p className="text-ink-2 m-0 max-w-sm text-center text-xs">{img ? t("me.profile.photoHint") : t("me.profile.photoEmpty")}</p>
        {img ? (
          <button type="button" className={btn} onClick={() => file.current?.click()}>
            {t("me.profile.photoPick")}
          </button>
        ) : null}
        {error ? (
          <p className="text-block m-0 text-sm" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
