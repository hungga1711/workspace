"use client";

import "./assetPath";
import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  Excalidraw,
  exportToBlob,
  exportToSvg,
  FONT_FAMILY,
  MainMenu,
  newElementWith,
  reconcileElements,
  restoreElements,
  ROUNDNESS,
  sceneCoordsToViewportCoords,
  viewportCoordsToSceneCoords,
} from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import type { ExcalidrawElement, OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFileData, BinaryFiles, Collaborator, ExcalidrawImperativeAPI, SocketId } from "@excalidraw/excalidraw/types";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/client";
import { useFormat, useLocale, useT } from "@/lib/i18n/client";
import { taskHref } from "@/lib/links";
import { useDirectory } from "@/lib/people";
import { cx, popover } from "@/lib/ui";
import { useToast } from "@/components/ui/Toast";
import { ChevronDownIcon, StickyIcon } from "@/components/app/icons";
import { openBoardLive, type LiveBoard, type LivePeer } from "./collab";
import type { BoardController, Presence, SaveState, SelectedSticky } from "./controller";
import { CANVAS, EDGE, FONT_NUNITO, INK, LANE, STICKY_COLORS, STICKY_SIZE, stickyFill, type StickyColor } from "./palette";
import { changedSince, clusterLayout, freeSlot, freeSlots, isSticky, mergeElements, newer, sceneText, snapshotElements, stickies, type Box } from "./scene";
import type { SceneElement, SceneFile, WbLink, Whiteboard } from "./types";

/** Excalidraw's own UI language codes for ours. */
const EXCALIDRAW_LANG = { en: "en", vi: "vi-VN", zh: "zh-CN", es: "es-ES" } as const;

type El = ExcalidrawElement;
const asScene = (els: readonly El[]) => els as unknown as SceneElement[];
const asEls = (els: readonly SceneElement[]) => els as unknown as OrderedExcalidrawElement[];

/** Drawing defaults for a clean board: straight lines, solid strokes, the sans font, the app's ink. */
const DEFAULTS: Partial<AppState> = {
  currentItemRoughness: 0,
  currentItemStrokeStyle: "solid",
  currentItemStrokeColor: INK,
  currentItemStrokeWidth: 1,
  currentItemFillStyle: "solid",
  currentItemRoundness: "round",
  currentItemFontFamily: FONT_FAMILY.Nunito,
  currentItemFontSize: 20,
  currentItemArrowType: "round",
};
const SAVE_AFTER_MS = 2000;
const THUMB_FONT = "Inter, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const THUMB_EVERY_MS = 20_000;

/** A data URL as bytes, without fetch() (the CSP's connect-src does not list data:). */
function dataUrlToBlob(url: string): Blob {
  const [head, b64 = ""] = url.split(",");
  const type = /data:([^;]+)/.exec(head ?? "")?.[1] ?? "application/octet-stream";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}
const blobToDataUrl = (b: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(b);
  });

const download = (blob: Blob, name: string) => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

/** A sticky as an element skeleton: filled, no outline, rounded, its text centred inside. */
function stickySkeleton(x: number, y: number, color: StickyColor, text: string, width = STICKY_SIZE): ExcalidrawElementSkeleton {
  return {
    type: "rectangle",
    x,
    y,
    width,
    height: STICKY_SIZE,
    backgroundColor: stickyFill(color),
    strokeColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    roughness: 0,
    roundness: { type: ROUNDNESS.ADAPTIVE_RADIUS },
    customData: { sticky: true },
    ...(text ? { label: { text, fontSize: 20, fontFamily: FONT_NUNITO, strokeColor: INK, textAlign: "center", verticalAlign: "middle" } } : {}),
  } as ExcalidrawElementSkeleton;
}

/** A small SVG of the board for the list (no fonts or images inlined: it must stay under 200 KB). */
async function thumbnailOf(elements: readonly El[], background: string): Promise<string | null> {
  const visible = elements.filter((e) => !e.isDeleted);
  if (!visible.length) return null;
  const svg: SVGSVGElement = await exportToSvg({
    elements: visible,
    appState: { exportBackground: true, viewBackgroundColor: background, exportWithDarkMode: false },
    files: null,
    exportPadding: 24,
    skipInliningFonts: true,
  });
  const w = Number(svg.getAttribute("width")) || 480;
  const h = Number(svg.getAttribute("height")) || 300;
  const k = Math.min(1, 480 / w);
  svg.setAttribute("width", String(Math.round(w * k)));
  svg.setAttribute("height", String(Math.round(h * k)));
  // An <img> has no web fonts: the words use the system's sans (as the app's own fallback stack does), not the
  // browser's default serif.
  const s = new XMLSerializer().serializeToString(svg).replace(/font-family="[^"]*"/g, `font-family="${THUMB_FONT}"`);
  return s.length <= 200_000 ? s : null;
}

interface Badge {
  link: WbLink;
  left: number;
  top: number;
}

/**
 * The board's canvas: the drawing editor with our defaults, the sticky tool, live editing with the others in the
 * room, saving (2 s after a change, when the tab hides, on leaving), images through work files, and the task badges
 * under linked stickies. The header drives it through the `BoardController` handed to `onReady`.
 */
export function Canvas({
  board,
  canEdit,
  onReady,
  onSelection,
  onPeers,
  onConnection,
  onSaveState,
  onLinksChanged,
  onSaved,
}: {
  board: Whiteboard;
  canEdit: boolean;
  onReady: (c: BoardController) => void;
  onSelection: (s: SelectedSticky[]) => void;
  onPeers: (p: Presence[]) => void;
  onConnection: (online: boolean) => void;
  onSaveState: (s: SaveState) => void;
  onLinksChanged: () => void;
  onSaved: (updatedAt: string) => void;
}) {
  const t = useT();
  const fmt = useFormat();
  const locale = useLocale();
  const dir = useDirectory();
  const router = useRouter();
  const toast = useToast();
  const [xapi, setXapi] = useState<ExcalidrawImperativeAPI | null>(null);
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const live = useRef<LiveBoard | null>(null);
  const [isLive, setIsLive] = useState(false);
  /** Per element, the version the room (or the saved scene) already has: anything else is ours to send. */
  // Seeded from the saved scene: the editor hands the same elements back once it has loaded them, which is not a change.
  const known = useRef(new Map<string, number>((board.scene.elements ?? []).map((e) => [e.id, e.version])));
  const save = useRef({
    version: board.sceneVersion,
    dirty: false,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
    running: null as Promise<void> | null,
    thumbAt: 0,
  });
  const filesMeta = useRef(new Map<string, SceneFile>(Object.values(board.scene.files ?? {}).map((f) => [f.id, f])));
  const pendingFiles = useRef(new Set<string>());
  const links = useRef<WbLink[]>([]);
  const lastSel = useRef("");
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const color = useRef<StickyColor>("yellow");
  const [stickyColor, setStickyColor] = useState<StickyColor>("yellow");
  const [badges, setBadges] = useState<Badge[]>([]);
  const frame = useRef(0);
  const host = useRef<HTMLDivElement>(null);
  const lastElements = useRef<readonly OrderedExcalidrawElement[] | null>(null);
  // An empty board has nothing to fit (its first sticky must not move the view).
  const fitted = useRef(!(board.scene.elements ?? []).some((e) => !e.isDeleted));

  const initialData = useMemo(
    () => ({
      elements: asEls(board.scene.elements ?? []),
      appState: { ...DEFAULTS, viewBackgroundColor: board.scene.appState?.viewBackgroundColor ?? CANVAS, gridModeEnabled: !!board.scene.appState?.gridModeEnabled },
      scrollToContent: true,
    }),
    // The saved scene seeds the editor once; later changes come through the editor itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  /* ── badges under linked stickies ─────────────────────────────────────────────────────────────── */
  const placeBadges = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const a = apiRef.current;
      if (!a || !links.current.length) return setBadges((b) => (b.length ? [] : b));
      const st = a.getAppState();
      const byId = new Map(a.getSceneElements().map((e) => [e.id, e]));
      const next = links.current.flatMap((link): Badge[] => {
        const el = byId.get(link.elementId);
        if (!el) return [];
        const p = sceneCoordsToViewportCoords({ sceneX: el.x, sceneY: el.y + el.height }, st);
        return [{ link, left: Math.round(p.x - st.offsetLeft), top: Math.round(p.y - st.offsetTop + 6) }];
      });
      setBadges((b) => (JSON.stringify(b) === JSON.stringify(next) ? b : next));
    });
  }, []);

  /* ── saving ───────────────────────────────────────────────────────────────────────────────────── */
  const snapshot = useCallback(async (withThumb: boolean) => {
    const a = apiRef.current!;
    const all = a.getSceneElementsIncludingDeleted();
    const elements = snapshotElements(asScene(all), Date.now());
    const st = a.getAppState();
    const used = new Set(elements.flatMap((e) => (!e.isDeleted && e.type === "image" && e.fileId ? [e.fileId] : [])));
    const files = Object.fromEntries([...filesMeta.current].filter(([id]) => used.has(id)));
    const thumbnail = withThumb ? await thumbnailOf(all, st.viewBackgroundColor).catch(() => undefined) : undefined;
    return {
      scene: { elements, appState: { viewBackgroundColor: st.viewBackgroundColor, gridModeEnabled: st.gridModeEnabled }, files },
      text: sceneText(elements),
      ...(thumbnail !== undefined ? { thumbnail } : {}),
    };
  }, []);

  /** Takes the server's newer scene in (someone saved from outside the room) before saving again. */
  const takeRemote = useCallback(
    (remote: SceneElement[], files: SceneFile[]) => {
      const a = apiRef.current;
      if (!a) return;
      if (remote.length) {
        const local = a.getSceneElementsIncludingDeleted();
        const byId = new Map(local.map((e) => [e.id, e as unknown as SceneElement]));
        const echo: SceneElement[] = [];
        for (const r of remote) {
          const l = byId.get(r.id);
          // Ours is newer than what arrived (two people changed it at once): send ours again so the room settles on it.
          if (l && newer(l, r) === l && (l.version !== r.version || l.versionNonce !== r.versionNonce)) echo.push(l);
          else known.current.set(r.id, r.version);
        }
        const merged = reconcileElements(local, asEls(remote) as never, a.getAppState());
        a.updateScene({ elements: merged, captureUpdate: CaptureUpdateAction.NEVER });
        if (echo.length) live.current?.push(echo);
        // A sticky someone else turned into a task: fetch the fresh links for its badge.
        if (remote.some((r) => r.link && r.link.startsWith("/app/work/tasks/") && !links.current.some((l) => l.elementId === r.id))) onLinksChanged();
      }
      for (const f of files) {
        filesMeta.current.set(f.id, f);
        if (a.getFiles()[f.id] || pendingFiles.current.has(f.id)) continue;
        pendingFiles.current.add(f.id);
        void fetch(`/files/${encodeURIComponent(f.fileId)}`)
          .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
          .then(blobToDataUrl)
          .then((dataURL) => a.addFiles([{ id: f.id, mimeType: f.mimeType, dataURL, created: Date.now() } as BinaryFileData]))
          .catch(() => undefined)
          .finally(() => pendingFiles.current.delete(f.id));
      }
    },
    [onLinksChanged],
  );

  const runSave = useCallback(
    async (final = false): Promise<void> => {
      const s = save.current;
      if (!canEdit || !apiRef.current) return;
      if (s.running) {
        await s.running;
        if (!s.dirty) return;
      }
      if (!s.dirty) return;
      clearTimeout(s.timer);
      s.dirty = false;
      const work = (async () => {
        onSaveState("saving");
        const withThumb = final || Date.now() - s.thumbAt > THUMB_EVERY_MS;
        try {
          const body = await snapshot(withThumb);
          // The server merges per element (newer version wins) and never refuses a stale base; `merged` says the stored
          // scene had changes this copy had not loaded (someone saved outside the live room).
          const r = await api<{ sceneVersion: number; merged?: boolean }>(`work/whiteboards/${board.id}/scene`, { method: "PUT", body: { baseVersion: s.version, ...body } });
          s.version = r.sceneVersion;
          if (withThumb) s.thumbAt = Date.now();
          if (r.merged && !live.current) {
            const fresh = await api<Whiteboard>(`work/whiteboards/${board.id}`).catch(() => null);
            if (fresh) {
              const local = asScene(apiRef.current!.getSceneElementsIncludingDeleted());
              const merged = mergeElements(local, fresh.scene.elements);
              takeRemote(
                merged.filter((m) => !local.some((l) => l.id === m.id && l.version === m.version && l.versionNonce === m.versionNonce)),
                Object.values(fresh.scene.files ?? {}),
              );
              s.version = Math.max(s.version, fresh.sceneVersion);
            }
          }
          onSaveState(s.dirty ? "idle" : "saved");
          onSaved(new Date().toISOString());
        } catch {
          s.dirty = true;
          onSaveState("error");
          clearTimeout(s.timer);
          s.timer = setTimeout(() => void runSaveRef.current(), 10_000);
        }
      })();
      s.running = work;
      try {
        await work;
      } finally {
        s.running = null;
      }
    },
    [board.id, canEdit, onSaveState, onSaved, snapshot, takeRemote],
  );
  const runSaveRef = useRef(runSave);
  runSaveRef.current = runSave;

  const markDirty = useCallback(() => {
    const s = save.current;
    s.dirty = true;
    clearTimeout(s.timer);
    s.timer = setTimeout(() => void runSaveRef.current(), SAVE_AFTER_MS);
  }, []);

  /* ── images: bytes to work files, the scene keeps only where they are ─────────────────────────── */
  const uploadFile = useCallback(
    async (f: BinaryFileData) => {
      pendingFiles.current.add(f.id);
      try {
        const blob = dataUrlToBlob(f.dataURL);
        const ext = f.mimeType.split("/")[1]?.replace("svg+xml", "svg") ?? "bin";
        const u = await api<{ fileId: string; uploadUrl: string }>("work/files/uploads", {
          method: "POST",
          body: { name: `${board.code}-${f.id.slice(0, 8)}.${ext}`, contentType: f.mimeType, size: blob.size, attachTo: { type: "whiteboard", id: board.id } },
        });
        const put = await fetch(u.uploadUrl, { method: "PUT", headers: { "content-type": f.mimeType }, body: blob });
        if (!put.ok) throw new Error("upload");
        await api(`work/files/${u.fileId}/confirm`, { method: "POST" });
        const meta: SceneFile = { id: f.id, mimeType: f.mimeType, fileId: u.fileId };
        filesMeta.current.set(f.id, meta);
        live.current?.push([], [meta]);
        markDirty();
      } catch {
        toast({ message: t("whiteboard.imageFailed") });
      } finally {
        pendingFiles.current.delete(f.id);
      }
    },
    [board.code, board.id, markDirty, t, toast],
  );

  /* ── the editor's changes ─────────────────────────────────────────────────────────────────────── */
  const onChange = useCallback(
    (elements: readonly OrderedExcalidrawElement[], st: AppState, files: BinaryFiles) => {
      if (!apiRef.current) return;
      placeBadges();
      if (elements !== lastElements.current) {
        lastElements.current = elements;
        // The first time the board's elements are in: show the whole board, as Miro opens one (never above 100%).
        if (!fitted.current && elements.some((e) => !e.isDeleted)) {
          fitted.current = true;
          const a = apiRef.current;
          requestAnimationFrame(() => a.scrollToContent(undefined, { fitToViewport: true, viewportZoomFactor: 0.9, maxZoom: 1, animate: false }));
        }
        // The stickies' words on the canvas element, for screen-reader-free checks (e2e) of what a board shows: the
        // canvas itself has no DOM text.
        const notes = stickies(asScene(elements));
        if (host.current) {
          host.current.dataset.stickies = String(notes.length);
          host.current.dataset.stickyText = notes
            .map((n) => n.text)
            .join(" | ")
            .slice(0, 2000);
        }
      }
      const sel = Object.keys(st.selectedElementIds ?? {})
        .filter((k) => st.selectedElementIds[k])
        .sort()
        .join(",");
      if (sel !== lastSel.current) {
        lastSel.current = sel;
        const ids = new Set(sel ? sel.split(",") : []);
        const linked = new Set(links.current.map((l) => l.elementId));
        onSelection(
          stickies(asScene(elements))
            .filter((s) => ids.has(s.element.id))
            .map((s) => ({ id: s.element.id, text: s.text, linked: linked.has(s.element.id) })),
        );
        live.current?.presence({ selected: Object.fromEntries([...ids].map((id) => [id, true as const])) });
      }
      const changed = changedSince(known.current, elements);
      if (!changed.length) return;
      for (const e of changed) known.current.set(e.id, e.version);
      if (!canEdit) return;
      live.current?.push(asScene(changed));
      markDirty();
      for (const e of changed) {
        if (e.type !== "image" || !e.fileId || e.isDeleted || filesMeta.current.has(e.fileId) || pendingFiles.current.has(e.fileId)) continue;
        const f = files[e.fileId];
        if (f?.dataURL) void uploadFile(f);
      }
    },
    [canEdit, markDirty, onSelection, placeBadges, uploadFile],
  );

  /* ── placing things ───────────────────────────────────────────────────────────────────────────── */
  const viewCenter = useCallback(() => {
    const st = apiRef.current!.getAppState();
    return viewportCoordsToSceneCoords({ clientX: st.offsetLeft + st.width / 2, clientY: st.offsetTop + st.height / 2 }, st);
  }, []);
  const add = useCallback((skeletons: ExcalidrawElementSkeleton[], select = true) => {
    const a = apiRef.current;
    if (!a || !skeletons.length) return [];
    const made = convertToExcalidrawElements(skeletons);
    const top = made.filter((e) => !("containerId" in e && e.containerId));
    a.updateScene({
      elements: [...a.getSceneElementsIncludingDeleted(), ...made],
      ...(select ? { appState: { selectedElementIds: Object.fromEntries(top.map((e) => [e.id, true as const])) } as AppState } : {}),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    return made;
  }, []);
  /** The notes on the board, as boxes a new one must not cover. */
  const takenBoxes = useCallback((): Box[] => {
    const a = apiRef.current;
    return a ? stickies(asScene(a.getSceneElements())).map(({ element: e }) => ({ x: e.x, y: e.y, width: e.width, height: e.height })) : [];
  }, []);
  const addSticky = useCallback(
    (c: StickyColor, at?: { x: number; y: number }) => {
      if (!apiRef.current || !canEdit) return;
      const p = freeSlot(at ?? viewCenter(), takenBoxes(), { width: STICKY_SIZE, height: STICKY_SIZE });
      add([stickySkeleton(p.x, p.y, c, "")]);
    },
    [add, canEdit, takenBoxes, viewCenter],
  );

  /** From a button: the new sticky, with the keyboard handed back to the canvas so Enter starts writing on it. */
  const addFromButton = useCallback(() => {
    addSticky(color.current);
    host.current?.querySelector<HTMLElement>(".excalidraw")?.focus();
  }, [addSticky]);

  const controller = useMemo<BoardController>(
    () => ({
      addSticky,
      recolor: (c) => {
        const a = apiRef.current;
        if (!a || !canEdit) return;
        const sel = a.getAppState().selectedElementIds;
        a.updateScene({
          elements: a
            .getSceneElementsIncludingDeleted()
            .map((e) => (sel[e.id] && isSticky(e as unknown as SceneElement) ? newElementWith(e, { backgroundColor: stickyFill(c) }) : e)),
          captureUpdate: CaptureUpdateAction.IMMEDIATELY,
        });
        color.current = c;
        setStickyColor(c);
      },
      insertTemplate: async (key) => {
        const a = apiRef.current;
        if (!a || !canEdit) return;
        // The work module's templates (localized there); their text sizes are approximate, so they are measured here.
        const r = await api<{ templates: { key: string; scene: { elements: SceneElement[] } }[] }>("work/whiteboards/templates");
        const tpl = r.templates.find((x) => x.key === key);
        if (!tpl?.scene.elements.length) return;
        const els = restoreElements(asEls(tpl.scene.elements.map((e) => ({ ...e, index: null }))), null, { refreshDimensions: true });
        const xs = els.map((e) => e.x);
        const ys = els.map((e) => e.y);
        const x0 = Math.min(...xs);
        const y0 = Math.min(...ys);
        const w = Math.max(...els.map((e) => e.x + e.width)) - x0;
        const h = Math.max(...els.map((e) => e.y + e.height)) - y0;
        const c = viewCenter();
        const dx = Math.round(c.x - x0 - w / 2);
        const dy = Math.round(c.y - y0 - h / 2);
        const placed = els.map((e) => newElementWith(e, { x: e.x + dx, y: e.y + dy }));
        a.updateScene({
          elements: [...a.getSceneElementsIncludingDeleted(), ...placed],
          appState: { selectedElementIds: Object.fromEntries(placed.filter((e) => !("containerId" in e && e.containerId)).map((e) => [e.id, true as const])) } as AppState,
          captureUpdate: CaptureUpdateAction.IMMEDIATELY,
        });
      },
      addStickies: (texts, c = "yellow") => {
        if (!apiRef.current || !canEdit || !texts.length) return;
        const spots = freeSlots(texts.length, viewCenter(), takenBoxes(), { width: STICKY_SIZE, height: STICKY_SIZE });
        add(texts.map((text, i) => stickySkeleton(spots[i]!.x, spots[i]!.y, c, text)));
      },
      addNote: (text) => {
        if (!apiRef.current || !canEdit || !text.trim()) return;
        const p = freeSlot(viewCenter(), takenBoxes(), { width: 480, height: STICKY_SIZE });
        add([stickySkeleton(p.x, p.y, "grey", text, 480)]);
      },
      arrange: (groups) => {
        const a = apiRef.current;
        if (!a || !canEdit || !groups.length) return;
        const all = a.getSceneElementsIncludingDeleted();
        // The clusters go beside everything already drawn (nothing is covered), level with the notes' top.
        const live = all.filter((e) => !e.isDeleted);
        const grouped = new Set(groups.flatMap((g) => g.elementIds));
        const right = Math.max(...live.filter((e) => !grouped.has(e.id) && !("containerId" in e && e.containerId && grouped.has(e.containerId))).map((e) => e.x + e.width), 0);
        const top = Math.min(...live.filter((e) => grouped.has(e.id)).map((e) => e.y), 0);
        const { frames, moves } = clusterLayout(groups, { x: Math.round(right + 120), y: Math.round(top) }, STICKY_SIZE);
        // Bound text moves with its sticky (the editor only does that for its own drags).
        const delta = new Map<string, { dx: number; dy: number }>();
        for (const e of all) {
          const to = moves.get(e.id);
          if (to) delta.set(e.id, { dx: to.x - e.x, dy: to.y - e.y });
        }
        const moved = all.map((e) => {
          const d = delta.get(e.id) ?? ("containerId" in e && e.containerId ? delta.get(e.containerId) : undefined);
          return d ? newElementWith(e, { x: e.x + d.dx, y: e.y + d.dy }) : e;
        });
        // Each cluster: a lane-grey frame with its theme as a 28px heading, drawn under the notes.
        const frameEls = convertToExcalidrawElements(
          frames.flatMap((f) => [
            {
              type: "rectangle",
              x: f.x,
              y: f.y,
              width: f.width,
              height: f.height,
              backgroundColor: LANE,
              strokeColor: EDGE,
              fillStyle: "solid",
              strokeWidth: 1,
              roughness: 0,
              roundness: { type: ROUNDNESS.ADAPTIVE_RADIUS },
            } as ExcalidrawElementSkeleton,
            { type: "text", x: f.x + 24, y: f.y + 16, text: f.title, fontSize: 28, fontFamily: FONT_NUNITO, strokeColor: INK } as ExcalidrawElementSkeleton,
          ]),
        );
        const backs = frameEls.filter((e) => e.type === "rectangle");
        const heads = frameEls.filter((e) => e.type !== "rectangle");
        // Order: the frames below everything, the headings on top; the editor re-indexes the new elements.
        a.updateScene({ elements: [...backs, ...moved, ...heads], captureUpdate: CaptureUpdateAction.IMMEDIATELY });
        a.scrollToContent([...backs], { fitToViewport: true, viewportZoomFactor: 0.9, animate: true });
      },
      setLinks: (next) => {
        links.current = next;
        const a = apiRef.current;
        if (a && canEdit) {
          const want = new Map(next.map((l) => [l.elementId, taskHref({ id: l.taskId, code: l.code })]));
          const all = a.getSceneElementsIncludingDeleted();
          if (all.some((e) => want.has(e.id) && e.link !== want.get(e.id)))
            a.updateScene({
              elements: all.map((e) => (want.has(e.id) && e.link !== want.get(e.id) ? newElementWith(e, { link: want.get(e.id)! }) : e)),
              captureUpdate: CaptureUpdateAction.NEVER,
            });
        }
        placeBadges();
      },
      exportImage: async (kind) => {
        const a = apiRef.current;
        if (!a) return;
        const elements = a.getSceneElements();
        const appState = { ...a.getAppState(), exportBackground: true, exportWithDarkMode: false };
        const name = (board.title.replace(/[\\/:*?"<>|]+/g, " ").trim() || board.code) + (kind === "png" ? ".png" : ".svg");
        if (kind === "png") download(await exportToBlob({ elements, appState, files: a.getFiles(), mimeType: "image/png", exportPadding: 24 }), name);
        else {
          const svg: SVGSVGElement = await exportToSvg({ elements, appState, files: a.getFiles(), exportPadding: 24 });
          download(new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" }), name);
        }
      },
      save: () => runSaveRef.current(),
    }),
    [add, addSticky, board.code, board.title, canEdit, placeBadges, takenBoxes, viewCenter],
  );

  /* ── mount: the editor is ready → live room, files, controller ────────────────────────────────── */
  useEffect(() => {
    if (!xapi) return;
    apiRef.current = xapi;
    for (const e of xapi.getSceneElementsIncludingDeleted()) known.current.set(e.id, e.version);
    takeRemote([], [...filesMeta.current.values()]);
    onReady(controller);
    // A board filled outside the editor (an import, a script) has no picture for its card yet: draw one now, once.
    // (The saved scene is read from the board: the editor takes it in a moment after it reports ready.)
    if (canEdit && !board.thumbnail && board.scene.elements.some((e) => !e.isDeleted)) {
      save.current.thumbAt = 0;
      markDirty();
    }
    let gone = false;
    const me = { id: dir.me, name: dir.name(dir.me) };
    void openBoardLive(
      { boardId: board.id, canEdit, me, elements: asScene(xapi.getSceneElementsIncludingDeleted()), files: [...filesMeta.current.values()] },
      {
        onRemote: (els, files) => takeRemote(els, files),
        onConnection: (on) => {
          onConnection(on);
          setIsLive(on);
        },
        onPeers: (peers: LivePeer[]) => {
          const map = new Map<SocketId, Collaborator>();
          for (const p of peers)
            map.set(String(p.clientId) as SocketId, {
              id: p.id,
              username: p.name,
              color: { background: p.color, stroke: p.color },
              pointer: p.pointer,
              button: p.button,
              selectedElementIds: p.selected,
            });
          apiRef.current?.updateScene({ collaborators: map, captureUpdate: CaptureUpdateAction.NEVER });
          onPeers(peers.map((p) => ({ clientId: p.clientId, id: p.id, name: p.name })));
        },
      },
    ).then((lb) => {
      if (gone) return void lb?.close();
      live.current = lb;
      setIsLive(!!lb);
      if (lb) takeRemote(lb.elements, lb.files);
    });
    return () => {
      gone = true;
      void live.current?.close();
      live.current = null;
    };
    // Once per editor instance; the handlers read refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [xapi]);
  useEffect(() => {
    if (xapi) onReady(controller);
  }, [xapi, controller, onReady]);

  /* ── save on hide and on leave; S adds a sticky ───────────────────────────────────────────────── */
  useEffect(() => {
    const hide = () => document.visibilityState === "hidden" && void runSaveRef.current(true);
    // Closing the tab: a last small save that survives the page going away (keepalive caps the body at 64 KB).
    const leave = () => {
      const s = save.current;
      if (!s.dirty || !apiRef.current || !canEdit) return;
      const els = snapshotElements(asScene(apiRef.current.getSceneElementsIncludingDeleted()), Date.now());
      const st = apiRef.current.getAppState();
      const used = new Set(els.flatMap((e) => (!e.isDeleted && e.type === "image" && e.fileId ? [e.fileId] : [])));
      const body = JSON.stringify({
        baseVersion: s.version,
        scene: {
          elements: els,
          appState: { viewBackgroundColor: st.viewBackgroundColor, gridModeEnabled: st.gridModeEnabled },
          files: Object.fromEntries([...filesMeta.current].filter(([id]) => used.has(id))),
        },
        text: sceneText(els),
      });
      if (body.length < 60_000)
        void fetch(`/api/proxy/work/whiteboards/${board.id}/scene`, { method: "PUT", keepalive: true, headers: { "content-type": "application/json", "x-wos-csrf": "1" }, body });
    };
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("pagehide", leave);
    return () => {
      document.removeEventListener("visibilitychange", hide);
      window.removeEventListener("pagehide", leave);
      void runSaveRef.current(true);
    };
  }, [board.id, canEdit]);
  useEffect(() => {
    if (!canEdit) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "s" && e.key !== "S") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      if (!host.current?.contains(el) && el !== document.body) return;
      const st = apiRef.current?.getAppState();
      if (!st || st.editingTextElement || st.openDialog) return;
      e.preventDefault();
      e.stopPropagation();
      // S drops the note under the pointer (or the nearest free spot); the buttons use the middle of the view.
      addSticky(color.current, pointer.current ?? undefined);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [addSticky, canEdit]);

  // The editor switches to its phone layout below 730px wide (or a short, narrow window); the sticky button moves
  // with it: in its top-right corner on the desktop layout, a round button above its bottom bar on the phone one.
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const { width, height } = e!.contentRect;
      setCompact(width < 730 || (height < 500 && width < 1000));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The drawing editor ships two icon-only buttons with no accessible name (its main menu and "exit zen mode"):
  // name them as they appear, since the editor re-renders them on layout changes.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const names: [string, string][] = [
      [".main-menu-trigger", t("whiteboard.mainMenu")],
      [".disable-zen-mode", t("whiteboard.exitZen")],
    ];
    const label = () => {
      for (const [sel, name] of names) el.querySelectorAll<HTMLElement>(sel).forEach((b) => b.getAttribute("aria-label") || b.setAttribute("aria-label", name));
    };
    label();
    const mo = new MutationObserver(label);
    mo.observe(el, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [t]);

  const dark = typeof document !== "undefined" && document.documentElement.dataset.theme === "dark";

  return (
    <div
      ref={host}
      data-whiteboard-canvas=""
      data-view-only={canEdit ? undefined : ""}
      aria-label={t("whiteboard.canvas", { title: board.title })}
      role="region"
      className={cx(
        "absolute inset-0",
        // The editor in the app's look: our sans for its UI, our blue for its selection and active tool; the
        // library button is not offered (no shared libraries in a self-hosted board). Important (`!`): the editor's
        // own stylesheet is not in a cascade layer, so it would beat our utilities whatever their specificity.
        "[&_.excalidraw]:[--color-primary-darker:var(--accent-text)]! [&_.excalidraw]:[--color-primary-darkest:var(--accent-text)]! [&_.excalidraw]:[--color-primary-light:var(--accent-wash)]! [&_.excalidraw]:[--color-primary:var(--accent)]! [&_.excalidraw]:[--color-selection:var(--accent)]! [&_.excalidraw]:[--ui-font:var(--font-sans)]!",
        // Who is here shows once, in our header, not again in the editor's corner.
        "[&_.default-sidebar-trigger]:hidden! [&_.UserList]:hidden!",
        // The editor ships only languages it has ≥ 85% translated; Vietnamese (49%) falls back to English, so its
        // hint line ("To move canvas, hold mouse wheel…") would read in English over the board. Hidden in Vietnamese.
        locale === "vi" && "[&_.HintViewer]:hidden!",
      )}
    >
      <Excalidraw
        excalidrawAPI={setXapi}
        initialData={initialData}
        onChange={onChange}
        onPointerUpdate={({ pointer: p, button }) => {
          pointer.current = { x: p.x, y: p.y };
          live.current?.presence({ pointer: p, button });
        }}
        onScrollChange={placeBadges}
        onLinkOpen={(el, e) => {
          if (el.link?.startsWith("/")) {
            e.preventDefault();
            router.push(el.link);
          }
        }}
        viewModeEnabled={!canEdit}
        isCollaborating={isLive}
        theme={dark ? "dark" : "light"}
        langCode={EXCALIDRAW_LANG[locale]}
        name={board.title}
        aiEnabled={false}
        autoFocus
        UIOptions={{
          canvasActions: {
            loadScene: false,
            saveToActiveFile: false,
            saveAsImage: false,
            export: false,
            toggleTheme: false,
            clearCanvas: canEdit,
            changeViewBackgroundColor: canEdit,
          },
          tools: { image: canEdit },
        }}
        renderTopRightUI={() =>
          canEdit && !compact ? (
            <StickyTool
              color={stickyColor}
              onAdd={addFromButton}
              onColor={(c) => {
                color.current = c;
                setStickyColor(c);
              }}
            />
          ) : null
        }
      >
        <MainMenu>
          {canEdit ? <MainMenu.DefaultItems.ClearCanvas /> : null}
          {canEdit ? <MainMenu.DefaultItems.ChangeCanvasBackground /> : null}
          <MainMenu.DefaultItems.Help />
        </MainMenu>
      </Excalidraw>
      <div className="pointer-events-none absolute inset-0 z-[3] overflow-hidden" aria-hidden={!badges.length}>
        {badges.map((b) => (
          <Link
            key={b.link.elementId}
            href={taskHref({ id: b.link.taskId, code: b.link.code })}
            aria-label={t("whiteboard.openTask", { code: b.link.code, title: b.link.title })}
            title={b.link.title}
            // Positioned on the sticky it belongs to (scene → screen coordinates).
            style={{ left: b.left, top: b.top }}
            className="bg-surface border-hairline text-ink shadow-raised pointer-events-auto absolute flex items-center gap-1.5 rounded-sm border px-2 py-0.5 text-xs no-underline"
          >
            <span className="font-mono tabular-nums">{b.link.code}</span>
            <span
              className={cx(
                "size-1.5 rounded-full",
                b.link.status === "done" ? "bg-ok" : b.link.status === "in_progress" ? "bg-accent" : b.link.status === "review" ? "bg-warn" : "bg-ink-2",
              )}
            />
            <span className="text-ink-2">{fmt.status(b.link.status)}</span>
          </Link>
        ))}
      </div>
      {canEdit && compact ? (
        // The phone layout: the editor's own toolbar fills the top, so the sticky is a round button above its bottom bar.
        <button
          type="button"
          onClick={addFromButton}
          aria-label={t("whiteboard.stickyAdd")}
          className="bg-surface border-hairline shadow-raised text-ink absolute bottom-20 right-3 z-[4] grid size-11 place-items-center rounded-full border"
        >
          <StickyIcon className="size-5" />
        </button>
      ) : null}
    </div>
  );
}

/** The sticky button in the canvas's top-right corner: a click adds one, the dot picks the colour for the next. */
function StickyTool({ color, onAdd, onColor }: { color: StickyColor; onAdd: () => void; onColor: (c: StickyColor) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const current = STICKY_COLORS.find((c) => c.key === color) ?? STICKY_COLORS[0];
  return (
    <div ref={ref} className="bg-surface border-hairline shadow-raised relative flex h-9 items-center rounded-full border font-sans text-sm">
      <button
        type="button"
        onClick={onAdd}
        title={t("whiteboard.stickyAdd")}
        aria-label={t("whiteboard.stickyAdd")}
        className="text-ink hover:bg-hover flex h-full items-center gap-1.5 rounded-l-full pl-3 pr-2 font-medium"
      >
        <StickyIcon className="size-4" />
        <span className="max-md:hidden">{t("whiteboard.sticky")}</span>
      </button>
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={t("whiteboard.stickyColor")}
        onClick={() => setOpen((v) => !v)}
        className="border-divider hover:bg-hover flex h-full items-center gap-1 rounded-r-full border-l pl-2 pr-2.5"
      >
        {/* The sticky colour itself (scene data, palette.ts). */}
        <span className="border-edge block size-4 rounded-full border" style={{ backgroundColor: current.color }} />
        <ChevronDownIcon className="text-ink-2 size-3.5" />
      </button>
      {open ? (
        <div className={cx(popover, "absolute right-0 top-full z-20 mt-1 grid grid-cols-3 gap-1 p-1.5")} role="group" aria-label={t("whiteboard.stickyColor")}>
          {STICKY_COLORS.map((c) => (
            <button
              key={c.key}
              type="button"
              aria-pressed={c.key === color}
              aria-label={t(`whiteboard.color.${c.key}`)}
              title={t(`whiteboard.color.${c.key}`)}
              onClick={() => {
                onColor(c.key);
                setOpen(false);
              }}
              className={cx("grid size-9 place-items-center rounded-md", c.key === color ? "bg-selected" : "hover:bg-hover")}
            >
              <span className="border-edge block size-6 rounded-md border" style={{ backgroundColor: c.color }} />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
