import { strFromU8, unzipSync } from "fflate";

/**
 * A Notion "Markdown & CSV" export (.zip): databases are CSV files (become tasks), pages are Markdown files (become
 * documents, nested as in Notion). Notion appends a 32-hex id to every file and folder name; the rows of a database
 * are also exported as pages inside the database's folder, so those are skipped (they arrive as tasks). Large
 * workspaces come as a zip of zips ("Part-1.zip"…), which is unpacked one level. Images and attachments stay behind:
 * their references are dropped and counted, so the dialog can say so.
 */

export interface NotionDatabase {
  /** Name without Notion's id, e.g. "Tasks". */
  name: string;
  path: string;
  csv: string;
  rows: number;
}
export interface NotionPage {
  path: string;
  title: string;
  markdown: string;
  /** The page this one sits under in Notion, if it is part of the export. */
  parentPath: string | null;
  images: number;
}
export interface NotionPlan {
  databases: NotionDatabase[];
  pages: NotionPage[];
  images: number;
}

const ID = /\s+[0-9a-f]{32}$/i;
/** "Roadmap 2026 3f2a…(32 hex)" → "Roadmap 2026". */
export const notionName = (s: string) => s.replace(ID, "").trim();
const stem = (path: string) => path.replace(/\.(md|csv)$/i, "");
const segs = (path: string) => path.split("/").filter(Boolean);

/** Unpacks the export, following nested zips one level; drops macOS metadata. */
function entries(zip: Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const [name, data] of Object.entries(unzipSync(zip))) {
    if (name.startsWith("__MACOSX/") || name.endsWith("/")) continue;
    if (/\.zip$/i.test(name)) {
      for (const [inner, d] of Object.entries(unzipSync(data))) if (!inner.startsWith("__MACOSX/") && !inner.endsWith("/")) out.set(inner, d);
    } else out.set(name, data);
  }
  return out;
}

/**
 * Turns Notion's Markdown into what the editor imports: the first "# Title" becomes the document title, images go,
 * links to other exported pages keep their text only (their files are renamed here), everything else is kept.
 */
export function cleanNotionMarkdown(md: string): { title: string | null; body: string; images: number } {
  let images = 0;
  const lines = md.replace(/^﻿/, "").split(/\r?\n/);
  let title: string | null = null;
  const first = lines.findIndex((l) => l.trim() !== "");
  if (first >= 0 && /^#\s+/.test(lines[first]!)) {
    title = lines[first]!.replace(/^#\s+/, "").trim();
    lines.splice(first, 1);
  }
  const body = lines
    .join("\n")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, () => {
      images++;
      return "";
    })
    // [Other page](Other%20page%20<id>.md) → Other page
    .replace(/\[([^\]]+)\]\((?!https?:|mailto:)[^)]*\.(md|csv)\)/gi, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, body, images };
}

export function planNotion(zip: ArrayBuffer): NotionPlan {
  const files = entries(new Uint8Array(zip));
  const databases: NotionDatabase[] = [];
  const csvStems = new Set<string>();
  // Newer exports write both "Tasks <id>.csv" and "Tasks <id>_all.csv"; the _all one has every row.
  const csvs = [...files.keys()].filter((n) => /\.csv$/i.test(n));
  for (const n of csvs) {
    const all = n.replace(/\.csv$/i, "_all.csv");
    if (!/_all\.csv$/i.test(n) && files.has(all)) continue;
    const base = n.replace(/_all\.csv$/i, ".csv");
    csvStems.add(stem(base));
    const csv = strFromU8(files.get(n)!);
    databases.push({ name: notionName(segs(stem(base)).at(-1) ?? base), path: n, csv, rows: Math.max(csv.split(/\r?\n/).filter((l) => l.trim()).length - 1, 0) });
  }
  const pages: NotionPage[] = [];
  let images = 0;
  for (const [n, data] of files) {
    if (!/\.md$/i.test(n)) continue;
    // A row of a database, exported as a page inside the database's folder: it arrives as a task instead.
    const dir = segs(n).slice(0, -1).join("/");
    if ([...csvStems].some((s) => dir === s || dir.startsWith(`${s}/`))) continue;
    const c = cleanNotionMarkdown(strFromU8(data));
    images += c.images;
    const own = stem(n);
    // A child page sits in a folder named like its parent's file: "A <id>.md" + "A <id>/B <id>.md".
    const parent = files.has(`${dir}.md`) ? `${dir}.md` : null;
    pages.push({ path: n, title: (c.title || notionName(segs(own).at(-1) ?? own) || "Untitled").slice(0, 300), markdown: c.body, parentPath: parent, images: c.images });
  }
  // Parents before children, so each page can be created under one that already exists.
  const depth = (p: NotionPage): number => {
    let d = 0;
    let cur = p.parentPath;
    while (cur && d < 50) {
      d++;
      cur = pages.find((x) => x.path === cur)?.parentPath ?? null;
    }
    return d;
  };
  pages.sort((a, b) => depth(a) - depth(b) || a.path.localeCompare(b.path));
  return { databases, pages, images };
}
