"use client";

import { uploadWorkFile } from "@/lib/work-files";
import { PersonTrigger } from "@/components/chat/PersonTrigger";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Editor } from "@tiptap/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import { useFormat, useT } from "@/lib/i18n/client";
import { Avatar, useDirectory } from "@/lib/people";
import { btn, btnPrimary, btnSm, chipAccent, chipWarn, cx, input } from "@/lib/ui";
import { ScreenCrumb } from "@/components/shell/ScreenTitle";
import { Menu } from "@/components/ui/Menu";
import { ArrowRightIcon, BellIcon, ChevronRightIcon, MoreIcon, PlusIcon, ShareIcon, StarIcon } from "@/components/app/icons";
import { DocAiPanel } from "@/components/work/DocAiPanel";
import { DocHistory } from "@/components/work/DocHistory";
import { ShareModal } from "./ShareModal";
import dynamic from "next/dynamic";
import { DocBody } from "./DocBody";
import { docProse } from "./prose";
import type { LiveSession, Peer } from "./collab";
import { SpaceTree, type SpaceInfo, type TreePage } from "./SpaceTree";
import { DocComments } from "./DocComments";
import { PageOutline } from "./PageOutline";
import { findQuote, paintQuotes, selectionIn } from "./inlineComments";
import { docHref, taskHref } from "@/lib/links";

// The editor (ProseMirror and its extensions) is only for editing: reading uses DocBody.
const RichEditor = dynamic(() => import("./RichEditor").then((m) => m.RichEditor), {
  ssr: false,
  loading: () => <div className={cx(docProse, "min-h-[50vh]")} aria-busy="true" />,
});
const toHtml = async (md: string) => (await import("marked")).marked.parse(md, { async: false }) as string;

export interface PageContext {
  space: SpaceInfo | null;
  ancestors: { id: string; title: string; emoji: string }[];
  children: { id: string; title: string; emoji: string; lastEditorId: string; updatedAt: string }[];
  labels: string[];
  emoji: string;
  format: "markdown" | "html";
  lastEditorId: string;
  updatedAt: string;
  starred: boolean;
  watching?: boolean;
  readers: number;
  views: number;
  openComments: number;
  canEdit: boolean;
}
export interface PageDoc {
  id: string;
  code: string;
  title: string;
  ownerId: string;
  visibility: string;
  sharedWith: string[];
  version: number;
  /** Never published: only its author can open it. */
  draft?: boolean;
}

/**
 * A documentation page: the space's tree on the left; breadcrumb, title, byline,
 * labels and star; read mode by default with "Edit" → rich editor → "Publish"; child pages and
 * comments below; history, sharing, AI and print/PDF from the page menu.
 */
export function PageView({
  doc,
  content,
  ctx,
  tree,
  canCreate,
  aiEnabled,
  startEditing,
  fresh = false,
  canManage = false,
}: {
  doc: PageDoc;
  content: string;
  ctx: PageContext;
  tree: TreePage[];
  canCreate: boolean;
  aiEnabled: boolean;
  startEditing: boolean;
  /** Just created and never published: an empty title to type, and "Huỷ" takes the empty page away again. */
  fresh?: boolean;
  canManage?: boolean;
}) {
  const t = useT();
  const { ago } = useFormat();
  const router = useRouter();
  const dir = useDirectory();
  // Older pages were Markdown: shown (and from now on saved) as rich text.
  // Already HTML from the server (older Markdown pages are converted there).
  const initialHtml = content;
  const [editing, setEditing] = useState(startEditing && ctx.canEdit);
  const [html, setHtml] = useState(initialHtml);
  const untitled = t("docs.page.untitled");
  const [isNew, setIsNew] = useState(fresh && startEditing && ctx.canEdit);
  const [title, setTitle] = useState(isNew && doc.title === untitled ? "" : doc.title);
  // A draft keeps an empty title; headings show the reader's placeholder instead.
  const shownTitle = (s: string) => s || untitled;
  const [saved, setSaved] = useState({ html: initialHtml, title: doc.title, version: doc.version });
  const [status, setStatus] = useState<{ text: string; tone: "ok" | "err" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [starred, setStarred] = useState(ctx.starred);
  const [watching, setWatching] = useState(!!ctx.watching);
  const [labels, setLabels] = useState(ctx.labels);
  const [newLabel, setNewLabel] = useState("");
  const [labeling, setLabeling] = useState(false);
  // Presence: who else has the page open, and who is editing it (polled every 20 s).
  const [others, setOthers] = useState<{ userId: string; editing: boolean }[]>([]);
  useEffect(() => {
    let alive = true;
    const beat = () =>
      api<{ others: { userId: string; editing: boolean }[] }>(`work/docs/${doc.id}/presence`, { method: "POST", body: { editing } })
        .then((r) => alive && setOthers(r.others))
        .catch(() => undefined);
    void beat();
    const timer = window.setInterval(beat, 20_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [doc.id, editing]);
  useEffect(
    () => () => {
      void api(`work/docs/${doc.id}/presence`, { method: "POST", body: { leaving: true } }).catch(() => undefined);
    },
    [doc.id],
  );
  const editors = others.filter((o) => o.editing);
  // Live co-editing: while editing, one shared draft with everyone else editing (./collab, loaded on demand).
  const [live, setLive] = useState<LiveSession | null>(null);
  const [joining, setJoining] = useState(false);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [offline, setOffline] = useState(false);
  const editorRef = useRef<Editor | null>(null);
  // Enter in the title before the editor has loaded: the caret goes to the body as soon as it exists.
  // Where the caret goes once the editor exists: a new page with a title already typed (in the "Trang mới" dialog)
  // starts in the body, and ?edit=1 on an existing page starts at its end. Nothing focused would leave keystrokes to
  // the app's single-key shortcuts, and focusing the filled title put the caret before its first letter.
  const bodyNext = useRef<"start" | "end" | null>(startEditing && ctx.canEdit ? (!(fresh && startEditing) ? "end" : doc.title && doc.title !== untitled ? "start" : null) : null);
  const onEditor = useCallback((e: Editor | null) => {
    editorRef.current = e;
    if (e && bodyNext.current) {
      const at = bodyNext.current;
      bodyNext.current = null;
      e.commands.focus(at);
    }
  }, []);
  // What the session needs at the moment it opens, without reopening it when these change.
  const openWith = useRef({ html, title, version: saved.version });
  openWith.current = { html, title, version: saved.version };
  const discardOnLeave = useRef(false);
  useEffect(() => {
    if (!editing) return;
    let alive = true;
    let session: LiveSession | null = null;
    // The title field stays editable while the draft opens; a title typed meanwhile wins over the draft's.
    const titleAtOpen = openWith.current.title;
    setJoining(true);
    void import("./collab")
      .then((m) =>
        m.openLive(
          { docId: doc.id, ...openWith.current, me: { id: dir.me, name: dir.name(dir.me) } },
          {
            onPeers: (p) => alive && setPeers(p),
            onTitle: (tt) => alive && setTitle(tt),
            onConnection: (on) => alive && setOffline(!on),
            onStale: () => window.location.replace(`${window.location.pathname}?edit=1`),
            onPublished: (e) => {
              if (!alive) return;
              setSaved({ html: editorRef.current?.getHTML() ?? openWith.current.html, title: e.title, version: e.version });
              setStatus({ text: t("docs.live.published", { name: dir.name(e.by), version: e.version }), tone: "ok" });
            },
          },
        ),
      )
      .catch(() => null)
      .then((s) => {
        if (s === "stale") return window.location.replace(`${window.location.pathname}?edit=1`);
        if (!alive) return void s?.close(false);
        session = s;
        setLive(s);
        if (s) {
          const typed = openWith.current.title;
          if (typed !== titleAtOpen) s.setTitle(typed);
          else setTitle(s.title());
        }
        if (!s) setStatus({ text: t("docs.live.solo"), tone: "err" });
        else if (s.resumed) setStatus({ text: t("docs.live.resumed"), tone: "ok" });
      })
      .finally(() => alive && setJoining(false));
    return () => {
      alive = false;
      setLive(null);
      setPeers([]);
      setOffline(false);
      void session?.close(discardOnLeave.current);
      discardOnLeave.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one session per editing spell; the rest is read through refs
  }, [editing, doc.id]);
  const prefetchLive = () => void import("./collab").catch(() => undefined);
  // Inline comments: the text picked for a new one, where to float the button, and open quotes to mark.
  const [picked, setPicked] = useState<{ text: string; top: number; left: number } | null>(null);
  const [quote, setQuote] = useState<string | null>(null);
  const [quotes, setQuotes] = useState<string[]>([]);
  const onQuotes = useCallback((q: string[]) => setQuotes((cur) => (JSON.stringify(cur) === JSON.stringify(q) ? cur : q)), []);
  useEffect(() => {
    if (editing) return;
    const root = document.querySelector("[data-doc-body]");
    if (!root) return;
    // After the read-only editor has rendered.
    let clean = () => undefined as void;
    const id = window.setTimeout(() => (clean = paintQuotes(root, quotes)), 50);
    return () => {
      window.clearTimeout(id);
      clean();
    };
  }, [quotes, editing, saved.version]);
  useEffect(() => {
    if (editing) return;
    const up = () =>
      window.setTimeout(() => {
        const root = document.querySelector("[data-doc-body]");
        const s = root ? selectionIn(root) : null;
        setPicked(s ? { text: s.text, top: Math.max(8, s.rect.top - 44), left: s.rect.left + s.rect.width / 2 } : null);
      }, 0);
    const away = () => setPicked(null);
    document.addEventListener("mouseup", up);
    document.addEventListener("keyup", up);
    window.addEventListener("scroll", away, true);
    return () => {
      document.removeEventListener("mouseup", up);
      document.removeEventListener("keyup", up);
      window.removeEventListener("scroll", away, true);
    };
  }, [editing]);
  const showQuote = (q: string) => {
    const root = document.querySelector("[data-doc-body]");
    const r = root ? findQuote(root, q) : null;
    if (!r) return;
    (r.startContainer.parentElement ?? root)?.scrollIntoView({ behavior: "smooth", block: "center" });
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(r);
  };
  const [panel, setPanel] = useState<"history" | "share" | "ai" | null>(null);
  const [meta, setMeta] = useState({ visibility: doc.visibility, sharedWith: doc.sharedWith });
  const dirty = editing && (html !== saved.html || (title.trim() || untitled) !== saved.title);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // A failed publish keeps what was written on this device, so a closed tab or a crash does not take it with it.
  const backupKey = `wos-doc-unsaved:${doc.id}`;
  const [backup, setBackup] = useState<{ title: string; html: string; at: number } | null>(null);
  useEffect(() => {
    if (!ctx.canEdit) return;
    try {
      const b = JSON.parse(localStorage.getItem(backupKey) ?? "null") as { title: string; html: string; at: number } | null;
      if (b && b.html !== initialHtml) setBackup(b);
      else if (b) localStorage.removeItem(backupKey);
    } catch {
      /* storage blocked: nothing kept */
    }
  }, [backupKey, ctx.canEdit, initialHtml]);
  const dropBackup = () => {
    setBackup(null);
    try {
      localStorage.removeItem(backupKey);
    } catch {
      /* storage blocked */
    }
  };
  const restoreBackup = () => {
    if (!backup) return;
    setHtml(backup.html);
    setTitle(backup.title);
    setEditing(true);
    setBackup(null);
  };

  const publish = async () => {
    setBusy(true);
    setStatus(null);
    // Straight from the editor: the last keys typed may not have reached `html` yet.
    const content = editorRef.current?.getHTML() ?? html;
    try {
      const d = await api<{ current_version: number }>(`work/docs/${doc.id}`, {
        method: "PUT",
        body: { title: title.trim() || untitled, content, baseVersion: saved.version, format: "html" },
      });
      const published = title.trim() || untitled;
      setHtml(content);
      setTitle(published);
      setSaved({ html: content, title: published, version: d.current_version });
      setIsNew(false);
      live?.published(d.current_version, published);
      discardOnLeave.current = true;
      setEditing(false);
      setStatus({ text: t("docs.page.published", { version: d.current_version }), tone: "ok" });
      dropBackup();
      router.refresh();
    } catch (e) {
      let kept = false;
      try {
        localStorage.setItem(backupKey, JSON.stringify({ title, html: content, at: Date.now() }));
        kept = true;
      } catch {
        /* storage blocked: the text is still in the editor */
      }
      setStatus({ text: t((e as { status?: number }).status === 409 ? "docs.page.conflict" : kept ? "docs.page.saveFailedKept" : "docs.page.saveFailed"), tone: "err" });
    } finally {
      setBusy(false);
    }
  };
  // "Tạo việc" from a checklist line: a task that links back to this page.
  const createTask = async (title: string) => {
    const tk = await api<{ id: string; code: string }>("work/tasks", { method: "POST", body: { title, source: { type: "document", documentId: doc.id } } });
    return { code: tk.code, url: taskHref(tk) };
  };
  // "Tải Markdown": the saved page as a .md file.
  const downloadMarkdown = async () => {
    const { htmlToMarkdown } = await import("./blocks");
    const md = `# ${doc.title}\n\n${htmlToMarkdown(saved.html)}\n`;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([md], { type: "text/markdown;charset=utf-8" }));
    a.download = `${doc.title.replace(/[\\/:*?"<>|]+/g, " ").trim() || "page"}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const upload = async (f: File) => `/files/${(await uploadWorkFile(f, { type: "document", id: doc.id })).fileId}`;
  const star = async () => {
    const on = !starred;
    setStarred(on);
    await api(`work/docs/${doc.id}/star`, { method: on ? "PUT" : "DELETE" }).catch(() => setStarred(!on));
  };
  const watch = async () => {
    const on = !watching;
    setWatching(on);
    await api(`work/docs/${doc.id}/watch`, { method: on ? "PUT" : "DELETE" }).catch(() => setWatching(!on));
  };
  const saveLabels = async (next: string[]) => {
    setLabels(next);
    await api(`work/docs/${doc.id}`, { method: "PATCH", body: { labels: next } }).catch(() => setLabels(labels));
  };
  const remove = async () => {
    if (!window.confirm(t("docs.page.confirmDelete", { title: shownTitle(doc.title) }))) return;
    try {
      await api(`work/docs/${doc.id}`, { method: "DELETE" });
      router.push(ctx.space?.homeId ? `/app/work/docs/${ctx.space.homeId}` : "/app/work/docs");
      router.refresh();
    } catch {
      setStatus({ text: t("docs.page.deleteFailed"), tone: "err" });
    }
  };
  const cancelEdit = () => {
    if (dirty && !peers.length && !window.confirm(t("docs.page.discard"))) return;
    // A page created a moment ago and never published: cancelling means "I didn't want it", so it goes.
    if (isNew && !peers.length && doc.ownerId === dir.me) {
      discardOnLeave.current = true;
      void api(`work/docs/${doc.id}`, { method: "DELETE" })
        .catch(() => undefined)
        .then(() => {
          router.replace(ctx.space?.homeId && ctx.space.homeId !== doc.id ? `/app/work/docs/${ctx.space.homeId}` : "/app/work/docs");
          router.refresh();
        });
      return;
    }
    discardOnLeave.current = true;
    setHtml(saved.html);
    setTitle(saved.title);
    setEditing(false);
  };
  // ⌘S / Ctrl+S publishes while editing, instead of the browser's "save page as".
  const publishRef = useRef(publish);
  publishRef.current = publish;
  useEffect(() => {
    if (!editing) return;
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void publishRef.current();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [editing]);
  const editActions = () => (
    <>
      <button type="button" className={btn} onClick={cancelEdit}>
        {t(isNew ? "docs.page.discardNew" : "common.cancel")}
      </button>
      <button type="button" className={btnPrimary} disabled={busy || joining} onClick={() => void publish()} title={t("docs.page.publishHint")}>
        {busy ? t("docs.page.publishing") : t("docs.page.publish")}
      </button>
    </>
  );
  const child = async () => {
    const d = await api<{ id: string }>("work/docs", { method: "POST", body: { title: "", draft: true, content: "", format: "html", parentId: doc.id } });
    router.push(`${docHref(d)}?edit=1&new=1`);
  };

  return (
    // Spacing: the space's tree is its own rail behind a divider; the page reads as a centred sheet with
    // room above the title, a 32px title, and 32px between the header and the body.
    <div className={cx("grid", ctx.space ? "lg:grid-cols-[248px_minmax(0,1fr)]" : "")}>
      {ctx.space ? (
        <aside className="border-divider hidden border-r lg:-mb-10 lg:-mt-5 lg:block lg:min-h-[calc(100dvh-48px)] lg:pr-4 lg:pt-5 print:!hidden">
          <div className="sticky top-[68px] max-h-[calc(100dvh-88px)] overflow-y-auto overflow-x-hidden p-1">
            <SpaceTree space={ctx.space} pages={tree} current={doc.id} canCreate={canCreate} canManage={canManage} />
          </div>
        </aside>
      ) : null}
      <div className={cx("grid min-w-0 gap-10 pb-10 pt-4 md:pt-8 2xl:grid-cols-[minmax(0,1fr)_200px]", ctx.space && "lg:pl-10")}>
        <article className="mx-auto w-full min-w-0 max-w-[760px]" aria-label={title}>
          {/* The top bar shows "Tài liệu / <page>" (one title per screen): this line is only the way up through
              parent pages, never the destination, the space or the page's own name again. */}
          <ScreenCrumb label={shownTitle(saved.title)} />
          {/* One row above the title: the way up on the left, the actions on the right. The title does not
              share its line with the buttons, so a long one wraps at the full measure instead of two words a line. */}
          {/* Editing: the row turns into the page's own bar, stuck under the top bar, with what state the
              draft is in on the left and Huỷ / Xuất bản on the right, apart from the formatting toolbar below. */}
          <div
            className={cx(
              "mb-5 flex min-h-8 items-center gap-3",
              editing && "bg-ground/95 border-divider sticky top-14 z-20 -mx-3 h-14 border-b px-3 backdrop-blur md:top-12 print:hidden",
            )}
          >
            {editing ? (
              <div className="flex min-w-0 items-center gap-2 text-sm" data-testid="doc-live" role="status">
                {peers.length ? (
                  <span className="flex -space-x-1.5">
                    {peers.slice(0, 5).map((o) => (
                      <span key={o.id} className="ring-accent rounded-full ring-2">
                        <Avatar id={o.id} size="xs" />
                      </span>
                    ))}
                  </span>
                ) : null}
                {joining ? (
                  <span className="text-ink-2 truncate">{t("docs.live.joining")}</span>
                ) : offline ? (
                  <span className={chipWarn}>{t("docs.live.offline")}</span>
                ) : peers.length ? (
                  <span className={cx(chipAccent, "truncate")}>{t("docs.live.with", { names: peers.map((o) => o.name).join(", ") })}</span>
                ) : (
                  <span className="text-ink-2 truncate">
                    <span className={cx("mr-1.5 inline-block size-1.5 rounded-full align-middle", dirty ? "bg-signal" : "bg-ok")} aria-hidden="true" />
                    {t(isNew ? "docs.page.draftNew" : dirty ? "docs.page.draftChanged" : "docs.page.draftSame")}
                  </span>
                )}
              </div>
            ) : null}
            {!editing &&
              (() => {
                // Only parent pages: the space is in the tree beside the page (and the top bar names Tài liệu).
                const up = ctx.ancestors.filter((a) => a.id !== ctx.space?.homeId).map((a) => ({ href: docHref(a), label: a.title, id: a.id }));
                // Below 1024px the tree is hidden: the space leads the line, the only way to its other pages.
                const sp = ctx.space?.homeId && ctx.space.homeId !== doc.id ? ctx.space : null;
                return up.length || sp ? (
                  <nav
                    aria-label={t("docs.page.breadcrumb")}
                    className={cx("text-ink-2 flex min-w-0 flex-wrap items-center gap-1 text-sm print:hidden", !up.length && "lg:hidden")}
                  >
                    {sp ? (
                      <span className="flex min-w-0 items-center gap-1 lg:hidden">
                        <Link href={`/app/work/docs/${sp.homeId}`} className="text-ink-2 hover:text-ink max-w-[24ch] truncate no-underline hover:underline">
                          {sp.icon ? `${sp.icon} ` : ""}
                          {sp.name}
                        </Link>
                        {up.length ? <ChevronRightIcon className="text-ink-2 size-3.5 shrink-0 opacity-60" /> : null}
                      </span>
                    ) : null}
                    {up.map((c, i) => (
                      <span key={c.id} className="flex min-w-0 items-center gap-1">
                        {i ? <ChevronRightIcon className="text-ink-2 size-3.5 shrink-0 opacity-60" /> : null}
                        <Link href={c.href} className="text-ink-2 hover:text-ink max-w-[24ch] truncate no-underline hover:underline">
                          {c.label}
                        </Link>
                      </span>
                    ))}
                  </nav>
                ) : null;
              })()}
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              {editing ? (
                editActions()
              ) : (
                <>
                  {ctx.canEdit ? (
                    <button type="button" className={btnPrimary} onPointerEnter={prefetchLive} onFocus={prefetchLive} onClick={() => setEditing(true)}>
                      {t("docs.page.edit")}
                    </button>
                  ) : null}
                  <button type="button" className={cx(btn, "max-sm:hidden")} onClick={() => setPanel("share")}>
                    <ShareIcon className="size-4" />
                    {t("docs.page.shareShort")}
                  </button>
                  <button
                    type="button"
                    onClick={() => void star()}
                    aria-pressed={starred}
                    aria-label={t(starred ? "docs.page.unstar" : "docs.page.star")}
                    title={t(starred ? "docs.page.unstar" : "docs.page.star")}
                    className={cx("grid size-8 place-items-center rounded-md", starred ? "text-signal [&_svg]:fill-current" : "text-ink-2 hover:bg-hover hover:text-ink")}
                  >
                    <StarIcon className="size-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void watch()}
                    aria-pressed={watching}
                    aria-label={t(watching ? "docs.page.watching" : "docs.page.watch")}
                    title={t(watching ? "docs.page.watchingHint" : "docs.page.watchHint")}
                    // A filled bell when watching, an outline one when not (a struck-out bell read as "muted").
                    className={cx("grid size-8 place-items-center rounded-md", watching ? "text-brand-text [&_svg]:fill-current" : "text-ink-2 hover:bg-hover hover:text-ink")}
                  >
                    <BellIcon className="size-4" />
                  </button>
                  <Menu
                    label={t("docs.page.more")}
                    items={[
                      ...(aiEnabled ? [{ label: t("docs.page.askAi"), onSelect: () => setPanel(panel === "ai" ? null : "ai") }] : []),
                      { label: t("docs.page.share"), onSelect: () => setPanel("share") },
                      { label: t("docs.page.historyAt", { version: saved.version }), onSelect: () => setPanel("history") },
                      ...(ctx.space && canCreate ? [{ label: t("docs.page.addChild"), onSelect: () => void child() }] : []),
                      { label: t("docs.page.print"), onSelect: () => window.print() },
                      { label: t("docs.page.markdown"), onSelect: () => void downloadMarkdown() },
                      {
                        label: t("docs.page.copyLink"),
                        onSelect: () =>
                          void navigator.clipboard.writeText(window.location.href.split("?")[0]!).then(() => setStatus({ text: t("docs.page.linkCopied"), tone: "ok" })),
                      },
                      ...(doc.ownerId === dir.me ? [{ label: t("docs.page.delete"), danger: true, onSelect: () => void remove() }] : []),
                    ]}
                    trigger={
                      <span className="text-ink-2 hover:bg-hover hover:text-ink grid size-8 place-items-center rounded-md">
                        <MoreIcon />
                      </span>
                    }
                  />
                </>
              )}
            </div>
          </div>
          <header className="flex flex-wrap items-start gap-3">
            {editing ? (
              <textarea
                aria-label={t("docs.page.title")}
                rows={1}
                // Grows with the title instead of cutting a long one off at the edge.
                className="text-ink font-display placeholder:text-ink-2/60 w-full min-w-0 resize-none bg-transparent text-[32px]/10 font-semibold tracking-[-0.03em] outline-none [field-sizing:content] max-md:text-2xl/8"
                value={title}
                onChange={(e) => {
                  const v = e.target.value.replace(/\n/g, " ");
                  setTitle(v);
                  live?.setTitle(v);
                }}
                // Enter goes on to the body, as in any writing app.
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    if (editorRef.current) editorRef.current.commands.focus("start");
                    else bodyNext.current = "start";
                  }
                }}
                autoFocus={isNew && !title}
                placeholder={untitled}
              />
            ) : (
              <h1 className="font-display m-0 w-full min-w-0 text-balance text-[32px]/10 font-semibold tracking-[-0.03em] max-md:text-2xl/8">
                {ctx.emoji ? `${ctx.emoji} ` : ""}
                {shownTitle(saved.title)}
              </h1>
            )}
          </header>
          <div className="text-ink-2 border-divider mt-3 flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b pb-6 text-[13px]">
            <PersonTrigger userId={ctx.lastEditorId} className="inline-flex items-center gap-1.5 rounded-md hover:underline">
              <Avatar id={ctx.lastEditorId} size="xs" />
              {t("docs.page.editedBy", { editor: dir.name(ctx.lastEditorId), when: ago(ctx.updatedAt) })}
            </PersonTrigger>
            <span aria-hidden="true">·</span>
            <span title={t("docs.page.views", { views: ctx.views, readers: ctx.readers })}>{t("docs.page.viewsShort", { views: ctx.views })}</span>
            <span aria-hidden="true">·</span>
            <span className="text-xs tabular-nums" title={t("docs.page.ownerIs", { owner: dir.name(doc.ownerId) })}>
              {doc.code}
            </span>
            {labels.map((l) => (
              <span key={l} className="bg-hover text-ink-2 inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-xs">
                <Link href={`/app/work/docs?label=${encodeURIComponent(l)}`} className="text-ink-2 no-underline hover:underline">
                  {l}
                </Link>
                {ctx.canEdit ? (
                  <button
                    type="button"
                    aria-label={t("docs.page.removeLabel", { label: l })}
                    className="hover:text-ink"
                    onClick={() => void saveLabels(labels.filter((x) => x !== l))}
                  >
                    ×
                  </button>
                ) : null}
              </span>
            ))}
            {ctx.canEdit ? (
              labeling ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (newLabel.trim()) void saveLabels([...labels, newLabel.trim()]);
                    setNewLabel("");
                    setLabeling(false);
                  }}
                >
                  <input
                    autoFocus
                    className={cx(input, "h-7 min-h-0 w-32 px-2 text-xs")}
                    value={newLabel}
                    onChange={(e) => setNewLabel(e.target.value)}
                    onBlur={() => !newLabel.trim() && setLabeling(false)}
                    onKeyDown={(e) => e.key === "Escape" && setLabeling(false)}
                    placeholder={t("docs.page.addLabel")}
                    aria-label={t("docs.page.addLabel")}
                  />
                </form>
              ) : (
                <button
                  type="button"
                  onClick={() => setLabeling(true)}
                  className="text-ink-2 hover:bg-hover hover:text-ink inline-flex h-6 items-center gap-1 rounded-sm px-1.5 text-xs print:hidden"
                >
                  <PlusIcon className="size-3" />
                  {t("docs.page.labelButton")}
                </button>
              )
            ) : null}
          </div>
          {editing ? null : others.length ? (
            <div className="mt-2.5 flex flex-wrap items-center gap-2 text-sm" data-testid="doc-presence">
              <span className="flex -space-x-1.5">
                {others.slice(0, 5).map((o) => (
                  <span key={o.userId} className={cx("rounded-full ring-2", o.editing ? "ring-accent" : "ring-surface")}>
                    <Avatar id={o.userId} size="xs" />
                  </span>
                ))}
              </span>
              {editors.length ? (
                <span className={chipAccent} role="status">
                  {t(editing ? "docs.presence.editing" : "docs.live.join", { names: editors.map((o) => dir.name(o.userId)).join(", ") })}
                </span>
              ) : (
                <span className="text-ink-2">{t("docs.presence.viewing", { count: others.length })}</span>
              )}
            </div>
          ) : null}
          {status ? (
            <p role="status" className={cx("m-0 mt-2 text-sm", status.tone === "ok" ? "text-ok" : "text-block")}>
              {status.text}
            </p>
          ) : null}
          {backup && !editing ? (
            <div role="status" className="bg-warn-wash text-ink mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg px-3 py-2 text-sm">
              <span className="min-w-0 flex-1">{t("docs.page.unsavedFound", { when: ago(new Date(backup.at).toISOString()) })}</span>
              <button type="button" className={cx(btn, btnSm)} onClick={dropBackup}>
                {t("docs.page.unsavedDrop")}
              </button>
              <button type="button" className={cx(btnPrimary, btnSm)} onClick={restoreBackup}>
                {t("docs.page.unsavedRestore")}
              </button>
            </div>
          ) : null}
          {panel === "ai" ? (
            <div className="mt-4">
              <DocAiPanel
                docId={doc.id}
                title={title}
                dirty={dirty}
                onClose={() => setPanel(null)}
                onInsert={async (md) => {
                  const add = await toHtml(md);
                  const ed = editing ? editorRef.current : null;
                  if (ed) ed.commands.insertContentAt(ed.state.doc.content.size, add);
                  else {
                    setHtml((h) => `${h}${add}`);
                    setEditing(true);
                  }
                }}
              />
            </div>
          ) : null}
          <div className="mt-8" data-doc-body="">
            {!editing ? (
              <DocBody key={saved.version} html={saved.html} title={saved.title} />
            ) : joining ? (
              <div className={cx(docProse, "min-h-[50vh]")} aria-busy="true" />
            ) : (
              <RichEditor
                key={live ? "live" : "edit"}
                html={html}
                editable
                onChange={setHtml}
                onUpload={upload}
                onCreateTask={createTask}
                live={live}
                onEditor={onEditor}
                stickyClass="top-[120px] md:top-[112px]"
              />
            )}
          </div>
          {ctx.children.length ? (
            <section aria-labelledby="children-h" className="border-divider mt-12 border-t pt-6">
              <h2 id="children-h" className="mb-3 text-sm font-semibold">
                {t("docs.page.children", { count: ctx.children.length })}
              </h2>
              <ul className="m-0 grid list-none gap-2 p-0 sm:grid-cols-2">
                {ctx.children.map((c) => (
                  <li key={c.id}>
                    <Link
                      href={docHref(c)}
                      className="bg-surface shadow-card hover:shadow-lift ease-out-soft text-ink group flex items-center gap-3 rounded-xl px-4 py-3 no-underline transition-[box-shadow,transform] duration-300 motion-safe:hover:-translate-y-px"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">
                          {c.emoji ? `${c.emoji} ` : ""}
                          {c.title}
                        </span>
                        <span className="text-ink-2 block truncate text-xs">{t("docs.page.childBy", { editor: dir.name(c.lastEditorId), when: ago(c.updatedAt) })}</span>
                      </span>
                      <ArrowRightIcon
                        aria-hidden="true"
                        className="text-ink-2 group-hover:text-ink size-4 shrink-0 transition-transform duration-200 group-hover:translate-x-0.5"
                      />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {picked && !editing ? (
            <button
              type="button"
              className={cx(btnPrimary, "shadow-soft fixed z-30 min-h-8 -translate-x-1/2 px-3 text-sm print:hidden")}
              style={{ top: picked.top, left: picked.left }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setQuote(picked.text);
                setPicked(null);
                window.getSelection()?.removeAllRanges();
                document.getElementById("doc-comment-form")?.scrollIntoView({ behavior: "smooth", block: "center" });
              }}
            >
              {t("docs.comments.onSelection")}
            </button>
          ) : null}
          {editing ? null : <DocComments docId={doc.id} canResolve={ctx.canEdit} quote={quote} onQuoteDone={() => setQuote(null)} onQuotes={onQuotes} onShowQuote={showQuote} />}
        </article>
        {!editing ? (
          <aside className="hidden 2xl:block print:!hidden">
            <div className="sticky top-16 max-h-[calc(100dvh-80px)] overflow-y-auto pt-12">
              <PageOutline root="[data-doc-body]" />
            </div>
          </aside>
        ) : null}
      </div>
      {panel === "share" ? (
        <ShareModal
          docId={doc.id}
          meta={meta}
          owner={doc.ownerId}
          inSpace={!!ctx.space}
          onClose={() => setPanel(null)}
          onSaved={(m) => {
            setMeta(m);
            setPanel(null);
          }}
        />
      ) : null}
      {panel === "history" ? (
        <DocHistory
          docId={doc.id}
          current={saved.version}
          currentText={saved.html}
          dirty={dirty}
          onClose={() => setPanel(null)}
          onRestored={async (r) => {
            // The restored page as the server cleans it for reading (it may be an older Markdown version).
            const restored = await api<{ html: string }>(`work/docs/${doc.id}?track=0`)
              .then((x) => x.html)
              .catch(() => {
                window.location.reload();
                return saved.html;
              });
            setPanel(null);
            discardOnLeave.current = true;
            setEditing(false);
            setHtml(restored);
            setSaved({ html: restored, title: saved.title, version: r.version });
            setStatus({ text: t("docs.page.restored", { version: r.version }), tone: "ok" });
          }}
        />
      ) : null}
    </div>
  );
}
