"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { api } from "@/lib/client";
import { useT } from "@/lib/i18n/client";
import { ChevronRightIcon, FileIcon, PlusIcon, SettingsIcon } from "@/components/app/icons";
import { EditSpaceModal } from "./SpaceModal";
import { cx, navActive, navIcon, navIdle } from "@/lib/ui";
import { docHref } from "@/lib/links";

export interface TreePage {
  id: string;
  title: string;
  emoji: string;
  parentId: string | null;
  position: number;
}
export interface SpaceInfo {
  id: string;
  key: string;
  name: string;
  icon: string;
  homeId: string | null;
}

/**
 * The space's page tree: every page you can read, nested, the current one
 * highlighted with its parents open. "+" adds a child page; the space name opens its home page.
 */
export function SpaceTree({
  space,
  pages,
  current,
  canCreate,
  canManage = false,
}: {
  space: SpaceInfo;
  pages: TreePage[];
  current: string;
  canCreate: boolean;
  canManage?: boolean;
}) {
  const [settings, setSettings] = useState(false);
  const t = useT();
  const router = useRouter();
  const kids = useMemo(() => {
    const m = new Map<string | null, TreePage[]>();
    for (const p of [...pages].sort((a, b) => a.position - b.position)) {
      // The home page is the tree's root; its children show at the top level.
      const parent = p.id === space.homeId ? "__home" : p.parentId === space.homeId ? null : p.parentId;
      if (p.id === space.homeId) continue;
      m.set(parent, [...(m.get(parent) ?? []), p]);
    }
    return m;
  }, [pages, space.homeId]);
  // Open: the current page's ancestors.
  const initial = useMemo(() => {
    const open = new Set<string>();
    let p = pages.find((x) => x.id === current);
    while (p?.parentId) {
      open.add(p.parentId);
      p = pages.find((x) => x.id === p!.parentId);
    }
    return open;
  }, [pages, current]);
  const [open, setOpen] = useState(initial);
  const [busy, setBusy] = useState(false);
  const add = async (parentId: string | null) => {
    setBusy(true);
    try {
      const d = await api<{ id: string }>("work/docs", {
        method: "POST",
        // A draft with no title: only its author sees it until it is published, and each reader's own language fills in
        // the placeholder (a stored "Trang chưa đặt tên" showed up in English workspaces too).
        body: { title: "", draft: true, content: "", format: "html", ...(parentId ? { parentId } : { spaceId: space.id, parentId: space.homeId }) },
      });
      router.push(`${docHref(d)}?edit=1&new=1`);
    } finally {
      setBusy(false);
    }
  };
  const toggle = (id: string) => setOpen((o) => (o.has(id) ? new Set([...o].filter((x) => x !== id)) : new Set([...o, id])));
  // Every row has the same slots (indent, chevron, icon, title, actions) so titles line up whether or not a page has
  // children or an emoji; the selected row is the sidebar's soft ink fill, never a ringed pill.
  const node = (p: TreePage, depth: number): React.ReactNode => {
    const children = kids.get(p.id) ?? [];
    const isOpen = open.has(p.id);
    const active = p.id === current;
    const untitled = !p.title.trim() || p.title === t("docs.page.untitled");
    return (
      <li key={p.id}>
        <div
          className={cx("group relative flex h-8 items-center gap-1 rounded-md pr-1 transition-colors duration-100 max-md:h-10", active ? navActive : navIdle)}
          style={{ paddingLeft: 4 + depth * 14 }}
        >
          {children.length ? (
            <button
              type="button"
              onClick={() => toggle(p.id)}
              aria-label={t(isOpen ? "docs.tree.collapse" : "docs.tree.expand", { title: p.title })}
              aria-expanded={isOpen}
              className="text-ink-2 hover:bg-ink/[0.06] hover:text-ink grid size-4 shrink-0 place-items-center rounded-sm"
            >
              <ChevronRightIcon className={cx("size-3 transition-transform duration-150", isOpen && "rotate-90")} />
            </button>
          ) : (
            <span className="size-4 shrink-0" aria-hidden="true" />
          )}
          <Link
            href={docHref(p)}
            aria-current={active ? "page" : undefined}
            title={p.title}
            className="flex h-full min-w-0 flex-1 items-center gap-2 text-[13px] text-inherit no-underline"
          >
            <span className="grid size-[18px] shrink-0 place-items-center text-sm leading-none" aria-hidden="true">
              {p.emoji || <FileIcon className={navIcon(active)} />}
            </span>
            <span className={cx("min-w-0 truncate", untitled && !active && "text-ink-2")}>{p.title || t("docs.page.untitled")}</span>
          </Link>
          {canCreate ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void add(p.id)}
              aria-label={t("docs.tree.addChild", { title: p.title })}
              title={t("docs.tree.addPage")}
              className="text-ink-2 hover:bg-ink/[0.06] hover:text-ink grid size-6 shrink-0 place-items-center rounded-md opacity-0 focus-visible:opacity-100 group-hover:opacity-100 max-md:opacity-100"
            >
              <PlusIcon className="size-3.5" />
            </button>
          ) : null}
        </div>
        {children.length && isOpen ? (
          <ul
            className="before:bg-hairline relative m-0 mt-px flex list-none flex-col gap-px p-0 before:absolute before:inset-y-0.5 before:left-[var(--guide)] before:w-px"
            style={{ ["--guide" as string]: `${12 + depth * 14}px` }}
          >
            {children.map((c) => node(c, depth + 1))}
          </ul>
        ) : null}
      </li>
    );
  };
  const top = kids.get(null) ?? [];
  return (
    <nav aria-label={t("docs.tree.label", { space: space.name })} className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-0.5 text-sm">
      <div className="mb-3 flex h-9 items-center gap-1">
        <Link
          href={space.homeId ? `/app/work/docs/${space.homeId}` : "/app/work/docs"}
          title={space.name}
          className="text-ink hover:bg-ink/[0.04] flex h-full min-w-0 flex-1 items-center gap-2 rounded-md px-1 text-sm font-semibold no-underline"
        >
          <span className="bg-surface shadow-card grid size-6 shrink-0 place-items-center rounded-md text-sm leading-none">{space.icon || space.name.slice(0, 1)}</span>
          <span className="truncate">{space.name}</span>
        </Link>
        {canCreate ? (
          <button type="button" disabled={busy} onClick={() => void add(null)} className={headBtn} aria-label={t("docs.tree.addPage")} title={t("docs.tree.addPage")}>
            <PlusIcon className="size-4" />
          </button>
        ) : null}
        {canManage ? (
          <button type="button" onClick={() => setSettings(true)} className={headBtn} aria-label={t("docs.space.settings")} title={t("docs.space.settings")}>
            <SettingsIcon className="size-4" />
          </button>
        ) : null}
      </div>
      {settings ? <EditSpaceModal spaceKey={space.key} onClose={() => setSettings(false)} /> : null}
      <p className="text-ink-2 m-0 flex h-7 items-end px-1 pb-1 text-xs font-medium">{t("docs.tree.pages")}</p>
      <ul className="m-0 flex list-none flex-col gap-px p-0">{top.map((p) => node(p, 0))}</ul>
      {top.length === 0 ? <p className="text-ink-2 m-0 px-2 py-1 text-[13px]">{t("docs.tree.empty")}</p> : null}
    </nav>
  );
}

const headBtn = "text-ink-2 hover:bg-hover hover:text-ink grid size-7 shrink-0 place-items-center rounded-full";
