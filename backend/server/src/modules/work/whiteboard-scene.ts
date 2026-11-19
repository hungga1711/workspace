/**
 * Whiteboard scenes as stored (ADR 0024): Excalidraw's own element JSON, kept as data. The server never draws or
 * edits an element; it validates the envelope, merges what several editors saved, and reads the text out for search
 * and AI. Pure functions, no I/O (unit-tested in whiteboard-scene.test.ts).
 */

/** Limits a scene must respect (the PUT body, after merging). */
export const SCENE_LIMITS = {
  /** Serialized scene, in bytes of JSON. */
  bytes: 5 * 1024 * 1024,
  /** Elements that are not deleted. */
  elements: 5000,
  /**
   * Deleted elements kept as tombstones: they let a late save from someone who had not seen the deletion lose to it
   * (its version is lower). Beyond this the oldest go; a client that old reloads from the snapshot anyway.
   */
  tombstones: 5000,
  /** Image entries in `files` (metadata only; the bytes live in object storage). */
  files: 500,
  /** Text kept for search and AI, in characters. */
  text: 200_000,
  /** The thumbnail SVG, in characters. */
  thumbnail: 200 * 1024,
};

export interface SceneElement {
  id: string;
  type: string;
  version: number;
  versionNonce: number;
  isDeleted?: boolean;
  index?: string | null;
  updated?: number;
  [k: string]: unknown;
}

export interface SceneFile {
  id: string;
  mimeType: string;
  /** Our work file id (files table, attached to the board): the browser fetches the bytes through it. */
  fileId: string;
}

export interface Scene {
  elements: SceneElement[];
  appState: { viewBackgroundColor?: string; gridModeEnabled?: boolean };
  files: Record<string, SceneFile>;
}

export const emptyScene = (): Scene => ({ elements: [], appState: {}, files: {} });

const ELEMENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const COLOR = /^(#[0-9A-Fa-f]{3,8}|transparent|[a-z]{3,20})$/;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"]);

export class SceneError extends Error {
  override name = "SceneError";
}

/**
 * Checks the shape the server relies on (ids, versions, the files map) and drops what it must never store:
 * appState beyond the background and grid, and image data URLs (bytes go to object storage, not into the row).
 * Unknown element fields stay: they are Excalidraw's, and a newer editor may add some.
 */
export function normalizeScene(raw: unknown): Scene {
  if (!raw || typeof raw !== "object") throw new SceneError("scene must be an object");
  const r = raw as { elements?: unknown; appState?: unknown; files?: unknown };
  if (!Array.isArray(r.elements)) throw new SceneError("scene.elements must be an array");
  const seen = new Set<string>();
  const elements: SceneElement[] = [];
  for (const e of r.elements) {
    if (!e || typeof e !== "object" || Array.isArray(e)) throw new SceneError("every element must be an object");
    const el = e as Record<string, unknown>;
    if (typeof el.id !== "string" || !ELEMENT_ID.test(el.id)) throw new SceneError("element id is missing or invalid");
    if (typeof el.type !== "string" || el.type.length > 40) throw new SceneError(`element ${el.id}: type is missing`);
    if (!Number.isInteger(el.version) || (el.version as number) < 0) throw new SceneError(`element ${el.id}: version must be an integer`);
    if (typeof el.versionNonce !== "number" || !Number.isFinite(el.versionNonce)) throw new SceneError(`element ${el.id}: versionNonce must be a number`);
    // A duplicate id in one save keeps the newer copy, as a merge would.
    if (seen.has(el.id)) {
      const i = elements.findIndex((x) => x.id === el.id);
      if (wins(el as SceneElement, elements[i]!)) elements[i] = el as SceneElement;
      continue;
    }
    seen.add(el.id);
    elements.push(el as SceneElement);
  }
  const a = (r.appState && typeof r.appState === "object" ? r.appState : {}) as Record<string, unknown>;
  const appState: Scene["appState"] = {};
  if (typeof a.viewBackgroundColor === "string" && COLOR.test(a.viewBackgroundColor)) appState.viewBackgroundColor = a.viewBackgroundColor;
  if (typeof a.gridModeEnabled === "boolean") appState.gridModeEnabled = a.gridModeEnabled;
  const files: Record<string, SceneFile> = {};
  if (r.files && typeof r.files === "object" && !Array.isArray(r.files)) {
    for (const [key, v] of Object.entries(r.files as Record<string, unknown>)) {
      const f = v as Record<string, unknown> | null;
      if (!f || typeof f !== "object") continue;
      // Only the metadata: anything else (dataURL, created) is the browser's cache, never stored here.
      if (typeof f.id !== "string" || f.id !== key || !ELEMENT_ID.test(f.id)) throw new SceneError("files: entries are keyed by their id");
      if (typeof f.fileId !== "string" || !/^[0-9A-Za-z]{10,40}$/.test(f.fileId)) throw new SceneError(`files.${key}: fileId is required (upload the image first)`);
      if (typeof f.mimeType !== "string" || !IMAGE_TYPES.has(f.mimeType)) throw new SceneError(`files.${key}: unsupported image type`);
      files[key] = { id: f.id, mimeType: f.mimeType, fileId: f.fileId };
    }
  }
  return { elements, appState, files };
}

/**
 * Excalidraw's own rule (reconcileElements): the higher `version` wins; on a tie the lower `versionNonce`, so every
 * client and the server pick the same copy without talking to each other.
 */
export function wins(candidate: SceneElement, current: SceneElement): boolean {
  if (candidate.version !== current.version) return candidate.version > current.version;
  return candidate.versionNonce < current.versionNonce;
}

const ord = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Merges a save into the stored scene, element by element (id → the winning copy), so two people saving at once
 * never drop each other's elements; a deletion arrives as `isDeleted: true` with a higher version and wins like any
 * edit. Elements only one side has are kept. Order follows Excalidraw's fractional `index` when every element has
 * one, else the saver's order with elements only the server had appended. Files are a union; the app state is the
 * saver's (background and grid are last-writer-wins settings).
 */
export function mergeScenes(stored: Scene, incoming: Scene): { scene: Scene; changed: boolean } {
  const byId = new Map(stored.elements.map((e) => [e.id, e]));
  let changed = false;
  const merged = new Map<string, SceneElement>();
  for (const e of incoming.elements) {
    const cur = byId.get(e.id);
    const keep = !cur || wins(e, cur) ? e : cur;
    if (keep !== cur && (!cur || cur.version !== e.version || cur.versionNonce !== e.versionNonce)) changed = true;
    merged.set(e.id, keep);
  }
  for (const e of stored.elements) if (!merged.has(e.id)) merged.set(e.id, e);
  let elements = [...merged.values()];
  if (elements.every((e) => typeof e.index === "string" && e.index)) elements.sort((a, b) => ord(a.index as string, b.index as string) || ord(a.id, b.id));
  elements = pruneTombstones(elements);
  const files = { ...stored.files };
  for (const [k, f] of Object.entries(incoming.files)) {
    if (!files[k] || files[k]!.fileId !== f.fileId) changed = true;
    files[k] = f;
  }
  const appState = { ...stored.appState, ...incoming.appState };
  if (appState.viewBackgroundColor !== stored.appState.viewBackgroundColor || appState.gridModeEnabled !== stored.appState.gridModeEnabled) changed = true;
  return { scene: { elements, appState, files }, changed };
}

/** Keeps at most SCENE_LIMITS.tombstones deleted elements, the most recently changed. */
export function pruneTombstones(elements: SceneElement[], keep = SCENE_LIMITS.tombstones): SceneElement[] {
  const dead = elements.filter((e) => e.isDeleted === true);
  if (dead.length <= keep) return elements;
  const drop = new Set(
    [...dead]
      .sort((a, b) => (a.updated ?? 0) - (b.updated ?? 0))
      .slice(0, dead.length - keep)
      .map((e) => e.id),
  );
  return elements.filter((e) => !drop.has(e.id));
}

/** Refuses a scene over the limits; returns its serialized size. */
export function checkSceneLimits(scene: Scene): number {
  const live = scene.elements.filter((e) => e.isDeleted !== true).length;
  if (live > SCENE_LIMITS.elements) throw new SceneError(`a whiteboard holds at most ${SCENE_LIMITS.elements} elements`);
  if (Object.keys(scene.files).length > SCENE_LIMITS.files) throw new SceneError(`a whiteboard holds at most ${SCENE_LIMITS.files} images`);
  const bytes = Buffer.byteLength(JSON.stringify(scene));
  if (bytes > SCENE_LIMITS.bytes) throw new SceneError("scene too large (5 MB at most)");
  return bytes;
}

const textOf = (e: SceneElement): string => {
  const t = typeof e.originalText === "string" ? e.originalText : typeof e.text === "string" ? e.text : "";
  return t.replace(/\s+/g, " ").trim();
};
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Shapes that hold a sticky's text (Excalidraw "containers"). */
const CONTAINERS = new Set(["rectangle", "ellipse", "diamond"]);

export interface Sticky {
  elementId: string;
  text: string;
  x: number;
  y: number;
  color: string | null;
}

export interface BoardText {
  /** Notes: our sticky tool's shapes (customData.sticky), or any filled shape with text in it. */
  stickies: Sticky[];
  /** Free text: headings, labels, text on arrows and in unfilled shapes. */
  labels: { elementId: string; text: string; x: number; y: number }[];
  /** Everything, in reading order (top to bottom, then left to right), one element per line. */
  text: string;
}

/**
 * The words on a board. A sticky is a filled container shape with bound text, or anything our sticky tool made
 * (customData.sticky); its text is the bound text element's. Frames contribute their names.
 */
export function boardText(scene: Pick<Scene, "elements">, maxChars = SCENE_LIMITS.text): BoardText {
  const live = scene.elements.filter((e) => e.isDeleted !== true);
  const byId = new Map(live.map((e) => [e.id, e]));
  const stickies: Sticky[] = [];
  const labels: BoardText["labels"] = [];
  const inSticky = new Set<string>();
  for (const e of live) {
    if (!CONTAINERS.has(e.type)) continue;
    const bound = (Array.isArray(e.boundElements) ? (e.boundElements as { id?: unknown; type?: unknown }[]) : []).find((b) => b?.type === "text");
    const t = bound && typeof bound.id === "string" ? byId.get(bound.id) : undefined;
    const marked = (e.customData as { sticky?: unknown } | undefined)?.sticky === true;
    const filled = typeof e.backgroundColor === "string" && e.backgroundColor !== "transparent" && e.fillStyle !== "hachure";
    if (!marked && !(filled && t)) continue;
    const text = t ? textOf(t) : "";
    if (t) inSticky.add(t.id);
    stickies.push({ elementId: e.id, text, x: Math.round(num(e.x)), y: Math.round(num(e.y)), color: typeof e.backgroundColor === "string" ? e.backgroundColor : null });
  }
  for (const e of live) {
    if (inSticky.has(e.id)) continue;
    const text = e.type === "text" ? textOf(e) : (e.type === "frame" || e.type === "magicframe") && typeof e.name === "string" ? e.name.trim() : "";
    if (text) labels.push({ elementId: e.id, text, x: Math.round(num(e.x)), y: Math.round(num(e.y)) });
  }
  const reading = [...labels.map((l) => ({ ...l })), ...stickies.filter((s) => s.text)].sort((a, b) => Math.round(a.y / 40) - Math.round(b.y / 40) || a.x - b.x);
  let text = "";
  for (const r of reading) {
    if (text.length + r.text.length + 1 > maxChars) break;
    text += (text ? "\n" : "") + r.text;
  }
  return { stickies, labels, text };
}

/**
 * A thumbnail is shown as an image (`<img src="data:image/svg+xml,…">`), where scripts never run; it is still
 * refused when it carries anything active, so no other use of it can turn it into a script.
 */
export function checkThumbnail(svg: string): string {
  const s = svg.trim();
  if (s.length > SCENE_LIMITS.thumbnail) throw new SceneError("thumbnail too large (200 KB at most)");
  if (!/^(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(s)) throw new SceneError("thumbnail must be an SVG document");
  if (/<script|<foreignObject|<iframe|<object|<embed|\son[a-z]+\s*=|javascript:|data:text\/html/i.test(s)) throw new SceneError("thumbnail contains active content");
  return s;
}
