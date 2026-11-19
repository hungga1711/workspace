import type { WbFolder } from "./types";

/** The folders in tree order with their depth (children by position, then name), for the sidebar and the pickers. */
export function flattenFolders(folders: WbFolder[]): { folder: WbFolder; depth: number }[] {
  const kids = new Map<string | null, WbFolder[]>();
  for (const f of folders) kids.set(f.parentId, [...(kids.get(f.parentId) ?? []), f]);
  const out: { folder: WbFolder; depth: number }[] = [];
  const walk = (parent: string | null, depth: number, seen: Set<string>) => {
    for (const f of kids.get(parent) ?? []) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      out.push({ folder: f, depth });
      walk(f.id, depth + 1, seen);
    }
  };
  walk(null, 0, new Set());
  return out;
}

/** The folders from the top level down to `id` (as far as the reader can see). */
export function folderTrail(folders: WbFolder[], id: string | null): WbFolder[] {
  const by = new Map(folders.map((f) => [f.id, f]));
  const out: WbFolder[] = [];
  let cur = id ? by.get(id) : undefined;
  while (cur && out.length < 64) {
    out.unshift(cur);
    cur = cur.parentId ? by.get(cur.parentId) : undefined;
  }
  return out;
}

/** `id` and every folder inside it. */
export function folderSubtree(folders: WbFolder[], id: string): Set<string> {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of folders)
      if (f.parentId && out.has(f.parentId) && !out.has(f.id)) {
        out.add(f.id);
        grew = true;
      }
  }
  return out;
}

export const whiteboardsHref = (p: { folder?: string | null; scope?: string; q?: string } = {}) => {
  const s = new URLSearchParams();
  if (p.folder) s.set("folder", p.folder);
  if (p.scope === "mine") s.set("scope", "mine");
  if (p.q) s.set("q", p.q);
  return `/app/work/whiteboards${s.size ? `?${s}` : ""}`;
};
