// A plain module (no React, no "use client"): the shell, drag sources and the ask panel all read it, and it stays a
// few hundred bytes in every route.

/**
 * What the ask panel (⌘J) knows about where it was opened and what is dragged or pasted into it: a reference to a
 * record by id or code, never its text (the server reads it as the asker).
 */
export type AskRefKind = "task" | "document" | "project" | "meeting" | "workflow" | "file" | "channel" | "message" | "person" | "report";
export interface AskContextRef {
  kind: AskRefKind;
  id: string;
  label: string;
  code?: string | null;
  /** The screen the panel was opened on (shown as "on screen"), not something the person added. */
  page?: boolean;
  /** A channel: the thread open in it. */
  thread?: string;
}

/** The drag type an app item carries for the ask box; plain links also work (their URL is read). */
export const ASK_DRAG_TYPE = "application/x-workspace-ref";
/** Opens the ask panel from anywhere (a button, a menu); `detail.refs` adds context. */
export const OPEN_ASK_EVENT = "wx:ask-open";

const ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const CODE = /^[A-Za-z][A-Za-z0-9]{0,9}-\d{1,7}(-\d{1,4})?$/;
/** A record segment of an address: an id, or a code like T-041 / D-007 / H-012-3. */
const isRef = (s: string | undefined): s is string => !!s && (ID.test(s) || CODE.test(s));

/** The screen's name from the tab title ("T-041 Launch post · workspace" → "T-041 Launch post"). */
export function titleLabel(title: string): string {
  const parts = title.split(" · ");
  return (parts.length > 1 ? parts.slice(0, -1).join(" · ") : title).trim().slice(0, 200);
}

/**
 * The record an in-app address shows, or null: tasks, projects, pages, meetings, workflows, a chat channel (with the
 * thread or message it opens at), a message, a person and the AI report screens. `label` names it on the chip.
 */
export function refFromPath(pathname: string, search: string, label: string): AskContextRef | null {
  const q = new URLSearchParams(search);
  const seg = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (seg[0] !== "app") return null;
  const [, area, kind, id] = seg;
  const named = label.trim() || id || "";
  if (area === "work" && isRef(id)) {
    const code = CODE.test(id) ? id : null;
    if (kind === "tasks") return { kind: "task", id, label: named, code };
    if (kind === "projects") return { kind: "project", id, label: named, code };
    if (kind === "docs") return { kind: "document", id, label: named, code };
    if (kind === "meetings") return { kind: "meeting", id, label: named, code };
  }
  if (area === "work" && kind === "people" && id) return { kind: "person", id, label: named };
  if (area === "me" && kind === "people" && q.get("u")) return { kind: "person", id: q.get("u")!, label: named };
  if (area === "ai" && kind === "workflows" && isRef(id)) return { kind: "workflow", id, label: named };
  if (area === "ai" && (kind === "progress" || kind === "adoption" || kind === "insights")) return { kind: "report", id: kind, label: named };
  if (area === "chat" && kind === "m" && id && ID.test(id)) return { kind: "message", id, label: named };
  if (area === "chat" && kind && ID.test(kind)) {
    const thread = q.get("thread");
    return { kind: "channel", id: kind, label: named, ...(thread && ID.test(thread) ? { thread } : {}) };
  }
  return null;
}

/** An address pasted or dropped into the ask box (absolute on this site, or a path), as a reference. */
export function refFromUrl(text: string, origin: string, label = ""): AskContextRef | null {
  const raw = text.trim();
  if (!raw || /\s/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  const ref = refFromPath(url.pathname, url.search, label);
  // A dropped link has no title: the code or the last part of the address names it until the answer does.
  return ref && !ref.label ? { ...ref, label: ref.code ?? ref.id } : ref;
}

/** Makes an element a drag source for the ask box (and a link anywhere else). */
export function dragRef(e: { dataTransfer: DataTransfer | null }, ref: AskContextRef, href: string) {
  if (!e.dataTransfer) return;
  e.dataTransfer.setData(ASK_DRAG_TYPE, JSON.stringify(ref));
  e.dataTransfer.setData("text/uri-list", new URL(href, window.location.origin).href);
  e.dataTransfer.setData("text/plain", new URL(href, window.location.origin).href);
  e.dataTransfer.effectAllowed = "copyLink";
}

/** What was dropped on the ask box: an app item, or a link to a record of this app; null for anything else. */
export function refFromDrop(data: Pick<DataTransfer, "getData" | "types">, origin: string): AskContextRef | null {
  if (data.types.includes(ASK_DRAG_TYPE)) {
    try {
      const r = JSON.parse(data.getData(ASK_DRAG_TYPE)) as AskContextRef;
      if (r && typeof r.id === "string" && typeof r.kind === "string") return { ...r, page: false };
    } catch {
      return null;
    }
  }
  const link =
    data
      .getData("text/uri-list")
      .split(/\r?\n/)
      .find((l) => l && !l.startsWith("#")) || data.getData("text/plain");
  return link ? refFromUrl(link, origin) : null;
}

/** Whether a drag may be a reference (its data is only readable on drop). */
export const mayBeRef = (types: readonly string[]) => types.includes(ASK_DRAG_TYPE) || types.includes("text/uri-list");

/** Opens the ask panel, optionally with something to ask about. */
export function openAsk(refs: AskContextRef[] = []) {
  window.dispatchEvent(new CustomEvent(OPEN_ASK_EVENT, { detail: { refs } }));
}
