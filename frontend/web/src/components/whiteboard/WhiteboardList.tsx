"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/client";
import { useFormat, useT } from "@/lib/i18n/client";
import { whiteboardHref } from "@/lib/links";
import { useDirectory } from "@/lib/people";
import { btn, btnPrimary, btnSm, countPill, cx, iconBtn, mono, searchPill, tag } from "@/lib/ui";
import { PageHeader } from "@/components/ui/PageHeader";
import { Segmented } from "@/components/ui/Segmented";
import { Picker } from "@/components/ui/Picker";
import { EmptyState } from "@/components/ui/EmptyState";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { Menu } from "@/components/ui/Menu";
import { useToast } from "@/components/ui/Toast";
import {
  ChevronRightIcon,
  FolderIcon,
  LockIcon,
  MoreIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  ShareIcon,
  TrashIcon,
  UsersIcon,
  WhiteboardIcon,
  ArrowRightIcon,
} from "@/components/app/icons";
import { card, IconTile } from "@/components/ui/Bento";
import { SpotArea } from "@/components/ui/SpotArea";
import { flattenFolders, folderTrail, whiteboardsHref } from "./folders";
import type { AccessSummary, TemplateKey, WbFolder, WbFolders, WhiteboardSummary } from "./types";

// The picker, the template cards and the folder/share dialogs load when needed.
const NewWhiteboardDialog = dynamic(() => import("./NewWhiteboardDialog").then((m) => m.NewWhiteboardDialog), { ssr: false });
const TemplateCards = dynamic(() => import("./NewWhiteboardDialog").then((m) => m.TemplateCards), { ssr: false });
const FolderNameDialog = dynamic(() => import("./list-panels").then((m) => m.FolderNameDialog), { ssr: false });
const DeleteFolderDialog = dynamic(() => import("./list-panels").then((m) => m.DeleteFolderDialog), { ssr: false });
const MoveDialog = dynamic(() => import("./list-panels").then((m) => m.MoveDialog), { ssr: false });
const AccessDialog = dynamic(() => import("./list-panels").then((m) => m.AccessDialog), { ssr: false });

/** A board's thumbnail as an image: an SVG in an <img> cannot run scripts or reach the page, so it is safe as is. */
const thumbSrc = (svg: string | null) => (svg && svg.trimStart().startsWith("<svg") ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` : null);
const DRAG = "application/x-whiteboard";

type Dialog =
  | { kind: "new"; template: TemplateKey }
  | { kind: "folder"; parentId: string | null }
  | { kind: "rename"; folder: WbFolder }
  | { kind: "deleteFolder"; folder: WbFolder }
  | { kind: "move"; item: { type: "board" | "folder"; id: string; name: string; folderId: string | null } }
  | { kind: "share"; target: { type: "board" | "folder"; id: string; name: string }; parentName: string | null; link?: string };

function AccessMark({ v, className }: { v: AccessSummary; className?: string }) {
  const t = useT();
  if (v === "private") return <LockIcon className={cx("text-ink-2 size-3.5 shrink-0", className)} aria-label={t("whiteboard.vis.private")} />;
  if (v === "restricted") return <UsersIcon className={cx("text-ink-2 size-3.5 shrink-0", className)} aria-label={t("whiteboard.vis.restricted")} />;
  return null;
}

/**
 * Bảng trắng: folders on the left (nested, with how many boards each holds), the open folder's sub-folders and boards
 * on the right under a breadcrumb. "Của tôi", a project or a search list boards across every folder. Boards drag onto a
 * folder (or use "Chuyển đến…"); sharing a folder shares what inherits from it. On phones the tree folds into the
 * breadcrumb and the folder cards.
 */
export function WhiteboardList({
  boards: boardData,
  folders: folderData,
  folderId,
  projects,
  scope,
  projectId,
  q,
  openNew,
}: {
  /** null: the boards did not load (the folders still show). */
  boards: WhiteboardSummary[] | null;
  /** null: the folder list did not load (the boards still show). */
  folders: WbFolders | null;
  folderId: string | null;
  projects: { id: string; name: string }[];
  scope: "all" | "mine" | "project";
  projectId?: string;
  q?: string;
  openNew?: boolean;
}) {
  const t = useT();
  const fmt = useFormat();
  const dir = useDirectory();
  const router = useRouter();
  const toast = useToast();
  const [dialog, setDialog] = useState<Dialog | null>(openNew ? { kind: "new", template: "blank" } : null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const folders = folderData?.folders ?? [];
  const boards = boardData ?? [];
  // A folder in the link that is not (or no longer) visible: deleted, moved out of reach, or never shared.
  const missing = !!folderId && !!folderData && !folders.some((f) => f.id === folderId);
  const flat = flattenFolders(folders);
  const filtered = scope !== "all" || !!q;
  const current = folderId ? (folders.find((f) => f.id === folderId) ?? null) : null;
  const trail = folderTrail(folders, folderId);
  const subfolders = filtered ? [] : folders.filter((f) => f.parentId === (current?.id ?? null));
  const canCreateHere = current ? current.canEdit : (folderData?.canCreate ?? true);
  const parentName = (id: string | null) => (id ? (folders.find((f) => f.id === id)?.name ?? null) : null);
  const done = () => router.refresh();

  const moveBoard = (boardId: string, to: string | null) => {
    const b = boards.find((x) => x.id === boardId);
    if (!b || b.folderId === to) return;
    void api(`work/whiteboards/${boardId}`, { method: "PATCH", body: { folderId: to } })
      .then(() => {
        toast({ message: t("whiteboard.folder.moved", { name: parentName(to) ?? t("whiteboard.folder.all") }) });
        done();
      })
      .catch(() => toast({ message: t("whiteboard.folder.moveFailed") }));
  };
  // A folder (or "all boards") as a drop target for dragged boards: only where the reader may add.
  const drop = (id: string | null, enabled: boolean) =>
    enabled
      ? {
          onDragOver: (e: React.DragEvent) => {
            if (!e.dataTransfer.types.includes(DRAG)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            setDropOn(id ?? "root");
          },
          onDragLeave: () => setDropOn((d) => (d === (id ?? "root") ? null : d)),
          onDrop: (e: React.DragEvent) => {
            const boardId = e.dataTransfer.getData(DRAG);
            setDropOn(null);
            if (boardId) {
              e.preventDefault();
              moveBoard(boardId, id);
            }
          },
        }
      : {};
  const dropRing = (id: string | null) => dropOn === (id ?? "root") && "ring-accent bg-accent-wash ring-2";

  const folderMenu = (f: WbFolder) => [
    ...(f.canEdit ? [{ label: t("whiteboard.folder.newSub"), icon: <PlusIcon />, onSelect: () => setDialog({ kind: "folder", parentId: f.id }) }] : []),
    {
      label: t("whiteboard.share"),
      icon: <ShareIcon />,
      onSelect: () => setDialog({ kind: "share", target: { type: "folder", id: f.id, name: f.name }, parentName: parentName(f.parentId) }),
    },
    ...(f.canManage
      ? [
          { label: t("whiteboard.folder.rename"), icon: <PencilIcon />, onSelect: () => setDialog({ kind: "rename", folder: f }) },
          {
            label: t("whiteboard.folder.moveTo"),
            icon: <ArrowRightIcon />,
            onSelect: () => setDialog({ kind: "move", item: { type: "folder", id: f.id, name: f.name, folderId: f.parentId } }),
          },
          { label: t("whiteboard.folder.delete"), icon: <TrashIcon />, danger: true, onSelect: () => setDialog({ kind: "deleteFolder", folder: f }) },
        ]
      : []),
  ];

  const tree = (
    <nav aria-label={t("whiteboard.folder.tree")} className="grid content-start gap-0.5">
      <Link
        href={whiteboardsHref()}
        aria-current={!filtered && !folderId ? "page" : undefined}
        className={cx(
          "flex min-h-8 items-center gap-2 rounded-md px-2 text-sm no-underline transition-colors",
          !filtered && !folderId ? "bg-selected text-ink font-medium" : "text-ink-soft hover:bg-hover hover:text-ink",
          dropRing(null),
        )}
        {...drop(null, folderData?.canCreate ?? false)}
      >
        <WhiteboardIcon className="text-ink-2 size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{t("whiteboard.folder.all")}</span>
        {folderData ? <span className="text-ink-2 text-xs tabular-nums">{folderData.rootBoards}</span> : null}
      </Link>
      {flat.map(({ folder: f, depth }) => {
        const on = !filtered && folderId === f.id;
        return (
          <Link
            key={f.id}
            href={whiteboardsHref({ folder: f.id })}
            aria-current={on ? "page" : undefined}
            className={cx(
              "flex min-h-8 items-center gap-2 rounded-md pr-2 text-sm no-underline transition-colors",
              on ? "bg-selected text-ink font-medium" : "text-ink-soft hover:bg-hover hover:text-ink",
              dropRing(f.id),
            )}
            // Indentation is the folder's depth: a dynamic value.
            style={{ paddingLeft: `${8 + depth * 14}px` }}
            {...drop(f.id, f.canEdit)}
          >
            <FolderIcon className="text-ink-2 size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{f.name}</span>
            <AccessMark v={f.visibility} />
            <span className="text-ink-2 text-xs tabular-nums">{f.boards}</span>
          </Link>
        );
      })}
      {folderData?.canCreate ? (
        <button
          type="button"
          className="text-ink-2 hover:bg-hover hover:text-ink flex min-h-8 items-center gap-2 rounded-md px-2 text-left text-sm transition-colors"
          onClick={() => setDialog({ kind: "folder", parentId: null })}
        >
          <PlusIcon className="size-4 shrink-0" />
          {t("whiteboard.folder.new")}
        </button>
      ) : null}
      {folderData ? null : <LoadFailed what={t("whiteboard.folder.tree")} className="px-2 pt-2" />}
    </nav>
  );

  return (
    <>
      <PageHeader
        title={t("whiteboard.tab")}
        lead={
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Segmented
              label={t("whiteboard.filterLabel")}
              value={scope === "mine" ? "mine" : scope === "all" ? "all" : ""}
              options={[
                { value: "all", label: t("whiteboard.scopeFolders"), href: whiteboardsHref({ q }) },
                { value: "mine", label: t("whiteboard.scopeMine"), href: whiteboardsHref({ scope: "mine", q }) },
              ]}
            />
            {projects.length ? (
              <Picker
                variant="button"
                label={t("whiteboard.projectLabel")}
                value={scope === "project" ? (projectId ?? "") : ""}
                onChange={(v) => router.push(v ? `/app/work/whiteboards?project=${encodeURIComponent(v)}${q ? `&q=${encodeURIComponent(q)}` : ""}` : whiteboardsHref({ q }))}
                options={[{ value: "", label: t("whiteboard.allProjects") }, ...projects.map((p) => ({ value: p.id, label: p.name }))]}
              />
            ) : null}
          </div>
        }
        actions={
          <>
            <form action="/app/work/whiteboards" role="search" className={cx(searchPill, "w-56")}>
              <SearchIcon className="pointer-events-none size-4 shrink-0" />
              {scope === "mine" ? <input type="hidden" name="scope" value="mine" /> : null}
              {scope === "project" && projectId ? <input type="hidden" name="project" value={projectId} /> : null}
              <input
                name="q"
                type="search"
                defaultValue={q}
                aria-label={t("whiteboard.search")}
                placeholder={t("whiteboard.search")}
                className="text-ink placeholder:text-ink-2 min-h-10 min-w-0 flex-1 bg-transparent outline-none"
              />
            </form>
            <button type="button" className={btnPrimary} disabled={!filtered && !canCreateHere} onClick={() => setDialog({ kind: "new", template: "blank" })}>
              <PlusIcon />
              <span className="max-sm:sr-only">{t("whiteboard.newBoard")}</span>
            </button>
          </>
        }
      />

      <div className="grid min-w-0 gap-6 md:grid-cols-[220px_minmax(0,1fr)]">
        <aside className="min-w-0 max-md:hidden">{tree}</aside>

        {/* Board and folder cards are Home cards: they lift and light under the pointer (one listener here). */}
        <SpotArea className="min-w-0">
          <section className="grid min-w-0 content-start gap-4" aria-labelledby="wb-where">
            {/* Where we are: the breadcrumb (also the phone's way up), and the open folder's actions. */}
            <div className="flex min-h-9 min-w-0 items-center gap-2">
              <nav aria-label={t("whiteboard.folder.breadcrumb")} className="min-w-0 flex-1">
                <ol id="wb-where" className="m-0 flex min-w-0 list-none items-center gap-1 p-0 text-sm">
                  {filtered ? (
                    <li className="text-ink truncate font-medium">{scope === "mine" ? t("whiteboard.scopeMine") : t("whiteboard.folder.searchAll")}</li>
                  ) : (
                    <>
                      <li className={cx("min-w-0", trail.length ? "shrink" : "")}>
                        {trail.length ? (
                          <Link
                            href={whiteboardsHref()}
                            className={cx("text-ink-2 hover:text-ink block truncate rounded-sm px-1 no-underline", dropRing(null))}
                            {...drop(null, folderData?.canCreate ?? false)}
                          >
                            {t("whiteboard.folder.all")}
                          </Link>
                        ) : (
                          <span className="text-ink block truncate px-1 font-medium">{t("whiteboard.folder.all")}</span>
                        )}
                      </li>
                      {trail.map((f, i) => (
                        <li key={f.id} className="flex min-w-0 shrink items-center gap-1">
                          <ChevronRightIcon className="text-ink-2 size-3.5 shrink-0" aria-hidden="true" />
                          {i === trail.length - 1 ? (
                            <span className="text-ink flex min-w-0 items-center gap-1.5 px-1 font-medium" aria-current="page">
                              <span className="truncate">{f.name}</span>
                              <AccessMark v={f.visibility} />
                            </span>
                          ) : (
                            <Link
                              href={whiteboardsHref({ folder: f.id })}
                              className={cx("text-ink-2 hover:text-ink block truncate rounded-sm px-1 no-underline", dropRing(f.id))}
                              {...drop(f.id, f.canEdit)}
                            >
                              {f.name}
                            </Link>
                          )}
                        </li>
                      ))}
                    </>
                  )}
                </ol>
              </nav>
              {!filtered && current ? (
                <>
                  <button
                    type="button"
                    className={cx(btn, btnSm, "max-sm:px-2")}
                    onClick={() => setDialog({ kind: "share", target: { type: "folder", id: current.id, name: current.name }, parentName: parentName(current.parentId) })}
                  >
                    <ShareIcon />
                    <span className="max-sm:sr-only">{t("whiteboard.share")}</span>
                  </button>
                  <Menu
                    label={t("whiteboard.folder.actions")}
                    trigger={
                      <span className={iconBtn}>
                        <MoreIcon />
                      </span>
                    }
                    items={folderMenu(current)}
                  />
                </>
              ) : !filtered && folderData?.canCreate ? (
                <button type="button" className={cx(btn, btnSm, "md:hidden")} onClick={() => setDialog({ kind: "folder", parentId: null })}>
                  <PlusIcon />
                  {t("whiteboard.folder.new")}
                </button>
              ) : null}
            </div>

            {subfolders.length ? (
              <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3 p-0" aria-label={t("whiteboard.folder.tree")}>
                {subfolders.map((f) => (
                  <li key={f.id} className={cx(card, "flex min-w-0 items-center gap-3 rounded-xl px-3.5 py-3", dropRing(f.id))} {...drop(f.id, f.canEdit)}>
                    <IconTile tone="tangerine">
                      <FolderIcon />
                    </IconTile>
                    <Link href={whiteboardsHref({ folder: f.id })} className="text-ink min-w-0 flex-1 truncate text-sm font-medium no-underline after:absolute after:inset-0">
                      {f.name}
                    </Link>
                    <AccessMark v={f.visibility} />
                    <span className={countPill}>{f.boards}</span>
                  </li>
                ))}
              </ul>
            ) : null}

            {boardData === null ? (
              <LoadFailed what={t("whiteboard.tab")} />
            ) : missing ? (
              <EmptyState
                kind="none"
                title={t("whiteboard.folder.missing")}
                action={
                  <Link href={whiteboardsHref()} className="text-sm">
                    {t("whiteboard.folder.backToAll")}
                  </Link>
                }
              />
            ) : boards.length === 0 ? (
              filtered ? (
                <EmptyState
                  kind="filtered"
                  title={t("whiteboard.noMatch")}
                  action={
                    <Link href={whiteboardsHref()} className="text-sm">
                      {t("whiteboard.clearFilters")}
                    </Link>
                  }
                />
              ) : current || subfolders.length ? (
                <EmptyState
                  kind="none"
                  compact={subfolders.length > 0}
                  title={current ? t("whiteboard.folder.empty") : t("whiteboard.empty")}
                  hint={canCreateHere ? t("whiteboard.folder.emptyHint") : t("whiteboard.folder.emptyViewOnly")}
                  action={
                    canCreateHere ? (
                      <button type="button" className={btn} onClick={() => setDialog({ kind: "new", template: "blank" })}>
                        <PlusIcon />
                        {t("whiteboard.newBoard")}
                      </button>
                    ) : undefined
                  }
                />
              ) : (
                <section aria-labelledby="wb-empty" className="bg-surface shadow-card grid gap-4 rounded-xl p-6 max-md:p-4">
                  <div>
                    <h2 id="wb-empty" className="m-0 text-[14px]/6 font-semibold">
                      {t("whiteboard.empty")}
                    </h2>
                    <p className="text-ink-2 m-0 text-sm">{t("whiteboard.emptyHint")}</p>
                  </div>
                  <TemplateCards onPick={(template) => setDialog({ kind: "new", template })} />
                </section>
              )
            ) : (
              <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4 p-0 max-sm:grid-cols-1" aria-label={t("whiteboard.tab")}>
                {boards.map((b) => {
                  const src = thumbSrc(b.thumbnail);
                  const folderName = filtered ? parentName(b.folderId) : null;
                  return (
                    <li
                      key={b.id}
                      draggable={b.canManage}
                      onDragStart={(e) => {
                        e.dataTransfer.setData(DRAG, b.id);
                        e.dataTransfer.effectAllowed = "move";
                      }}
                      // No overflow clip on the card itself: the board's menu opens below its title and must not be cut off.
                      className={cx(card, "group/board flex min-w-0 flex-col rounded-xl has-[[aria-expanded=true]]:z-20")}
                    >
                      {/* The image is pinned inside the frame: at its own size a tall board made its card taller than the rest. */}
                      <div className="bg-lane border-divider relative grid aspect-[16/10] place-items-center overflow-hidden rounded-t-xl border-b">
                        {src ? (
                          <img
                            src={src}
                            alt={t("whiteboard.previewOf", { title: b.title })}
                            className="ease-out-soft absolute inset-0 size-full object-contain p-3 transition-transform duration-500 motion-safe:group-hover/board:scale-[1.03]"
                            loading="lazy"
                            decoding="async"
                            draggable={false}
                          />
                        ) : (
                          <span className="text-ink-2 text-xs">{t("whiteboard.emptyBoard")}</span>
                        )}
                      </div>
                      <div className="grid min-w-0 gap-1 px-3.5 py-3">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <Link href={whiteboardHref(b)} className="text-ink flex min-w-0 flex-1 items-center gap-1.5 font-medium no-underline after:absolute after:inset-0">
                            <AccessMark v={b.visibility} />
                            <span className="truncate" title={b.title}>
                              {b.title}
                            </span>
                          </Link>
                          <Menu
                            label={t("whiteboard.folder.boardActions", { title: b.title })}
                            trigger={
                              <span className={cx(iconBtn, "relative z-10 -my-1 -mr-1.5")}>
                                <MoreIcon />
                              </span>
                            }
                            items={[
                              {
                                label: t("whiteboard.share"),
                                icon: <ShareIcon />,
                                onSelect: () =>
                                  setDialog({ kind: "share", target: { type: "board", id: b.id, name: b.title }, parentName: parentName(b.folderId), link: whiteboardHref(b) }),
                              },
                              ...(b.canManage
                                ? [
                                    {
                                      label: t("whiteboard.folder.moveTo"),
                                      icon: <ArrowRightIcon />,
                                      onSelect: () => setDialog({ kind: "move", item: { type: "board", id: b.id, name: b.title, folderId: b.folderId } }),
                                    },
                                  ]
                                : []),
                            ]}
                          />
                        </div>
                        <div className="text-ink-2 flex min-w-0 items-center gap-2 text-xs max-md:text-[13px]">
                          <span className={cx(mono, "shrink-0")}>{b.code}</span>
                          {folderName ? (
                            <span className="flex min-w-0 items-center gap-1" title={folderName}>
                              <FolderIcon className="size-3 shrink-0" />
                              <span className="truncate">{folderName}</span>
                            </span>
                          ) : null}
                          {b.projectName ? (
                            <span className={cx(tag, "min-w-0")} title={b.projectName}>
                              <span className="truncate">{b.projectName}</span>
                            </span>
                          ) : null}
                        </div>
                        {/* Its own line: beside the code and the project it was cut to "Lily Chen sửa …". */}
                        <span className="text-ink-2 truncate text-xs max-md:text-[13px]">
                          {t("whiteboard.updatedBy", { name: dir.name(b.updatedBy ?? b.ownerId), when: fmt.ago(b.updatedAt) })}
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </SpotArea>
      </div>

      {dialog?.kind === "new" ? (
        <NewWhiteboardDialog
          projects={projects}
          initialTemplate={dialog.template}
          initialProject={scope === "project" ? projectId : undefined}
          folder={!filtered && current ? { id: current.id, name: current.name } : null}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === "folder" ? (
        <FolderNameDialog parentId={dialog.parentId} onClose={() => setDialog(null)} onDone={(f) => router.push(whiteboardsHref({ folder: f.id }))} />
      ) : null}
      {dialog?.kind === "rename" ? <FolderNameDialog folder={dialog.folder} onClose={() => setDialog(null)} onDone={done} /> : null}
      {dialog?.kind === "deleteFolder" ? (
        <DeleteFolderDialog
          folder={dialog.folder}
          parentName={parentName(dialog.folder.parentId)}
          onClose={() => setDialog(null)}
          onDone={() => {
            if (folderId === dialog.folder.id) router.push(whiteboardsHref({ folder: dialog.folder.parentId }));
            else done();
          }}
        />
      ) : null}
      {dialog?.kind === "move" ? <MoveDialog item={dialog.item} folders={folders} canTop={folderData?.canCreate ?? false} onClose={() => setDialog(null)} onDone={done} /> : null}
      {dialog?.kind === "share" ? <AccessDialog target={dialog.target} parentName={dialog.parentName} link={dialog.link} onClose={() => setDialog(null)} onSaved={done} /> : null}
    </>
  );
}
