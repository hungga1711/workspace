"use client";

import { mergeAttributes, Node, type AnyExtension, type Editor } from "@tiptap/core";
import Highlight from "@tiptap/extension-highlight";
import Image from "@tiptap/extension-image";
import LinkExt from "@tiptap/extension-link";
import Mention from "@tiptap/extension-mention";
import Placeholder from "@tiptap/extension-placeholder";
import Table from "@tiptap/extension-table";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TableRow from "@tiptap/extension-table-row";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import Underline from "@tiptap/extension-underline";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n/client";
import type { MessageKey } from "@/lib/i18n/core";
import { useDirectory } from "@/lib/people";
import { cx, menuItem, popover } from "@/lib/ui";
import { Picker } from "@/components/ui/Picker";
import { Toc, Toggle } from "./blocks";
import { docProse } from "./prose";
import { fold } from "@/lib/fold";
import { BoldIcon, ChecklistIcon, CodeIcon, GridIcon, InfoIcon, ItalicIcon, LinkIcon, ListIcon, ListOrderedIcon, StrikeIcon } from "@/components/app/icons";

/** Info / note / warning / success panels. */
const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,
  addAttributes() {
    return { type: { default: "info", parseHTML: (el) => el.getAttribute("data-callout") ?? "info", renderHTML: (a) => ({ "data-callout": a.type }) } };
  },
  parseHTML() {
    return [{ tag: "div[data-callout]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes), 0];
  },
});

type Cmd = { key: string; label: MessageKey; hint: MessageKey; run: (e: Editor) => void };
const COMMANDS: Cmd[] = [
  { key: "h1", label: "docs.cmd.h1", hint: "docs.cmd.h1Hint", run: (e) => e.chain().focus().setNode("heading", { level: 1 }).run() },
  { key: "h2", label: "docs.cmd.h2", hint: "docs.cmd.h2Hint", run: (e) => e.chain().focus().setNode("heading", { level: 2 }).run() },
  { key: "h3", label: "docs.cmd.h3", hint: "docs.cmd.h3Hint", run: (e) => e.chain().focus().setNode("heading", { level: 3 }).run() },
  { key: "bullet", label: "docs.cmd.bullet", hint: "docs.cmd.bulletHint", run: (e) => e.chain().focus().toggleBulletList().run() },
  { key: "numbered", label: "docs.cmd.numbered", hint: "docs.cmd.numberedHint", run: (e) => e.chain().focus().toggleOrderedList().run() },
  { key: "todo", label: "docs.cmd.todo", hint: "docs.cmd.todoHint", run: (e) => e.chain().focus().toggleTaskList().run() },
  { key: "table", label: "docs.cmd.table", hint: "docs.cmd.tableHint", run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  { key: "info", label: "docs.cmd.info", hint: "docs.cmd.infoHint", run: (e) => e.chain().focus().wrapIn("callout", { type: "info" }).run() },
  { key: "warning", label: "docs.cmd.warning", hint: "docs.cmd.warningHint", run: (e) => e.chain().focus().wrapIn("callout", { type: "warning" }).run() },
  { key: "success", label: "docs.cmd.success", hint: "docs.cmd.successHint", run: (e) => e.chain().focus().wrapIn("callout", { type: "success" }).run() },
  { key: "quote", label: "docs.cmd.quote", hint: "docs.cmd.quoteHint", run: (e) => e.chain().focus().toggleBlockquote().run() },
  { key: "code", label: "docs.cmd.code", hint: "docs.cmd.codeHint", run: (e) => e.chain().focus().toggleCodeBlock().run() },
  { key: "divider", label: "docs.cmd.divider", hint: "docs.cmd.dividerHint", run: (e) => e.chain().focus().setHorizontalRule().run() },
  { key: "toggle", label: "docs.cmd.toggle", hint: "docs.cmd.toggleHint", run: (e) => e.chain().focus().wrapIn("toggle").run() },
  { key: "toc", label: "docs.cmd.toc", hint: "docs.cmd.tocHint", run: (e) => e.chain().focus().insertContent({ type: "toc" }).run() },
];

/** "@Name" for a mention node; never the suggestion trigger, which is a NUL here. */
export const mentionLabel = (attrs: { label?: unknown; id?: unknown }) => `@${String(attrs.label ?? attrs.id ?? "")}`;

/** The page schema and behaviour; live editing builds its first draft from the same list. */
export function pageExtensions(opts: { editable: boolean; placeholder: string; history?: boolean }): AnyExtension[] {
  const { editable, placeholder } = opts;
  return [
    // Live editing brings its own undo (only your own changes), so the plain history is off then.
    StarterKit.configure({ heading: { levels: [1, 2, 3] }, ...(opts.history === false ? { history: false } : {}) }),
    Underline,
    Highlight,
    LinkExt.configure({ openOnClick: !editable, autolink: true, protocols: ["http", "https", "mailto"] }),
    Placeholder.configure({ placeholder }),
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    TaskList,
    TaskItem.configure({ nested: true }),
    Image,
    Callout,
    Toggle,
    Toc,
    // Mentions are inserted from our own "@" menu below, so the suggestion plug-in gets a trigger nobody can type and
    // stays idle. The label is rendered with "@" explicitly: by default Mention prefixes it with the trigger char,
    // which put a NUL into the saved HTML and Postgres refused every save of a page with a mention.
    Mention.configure({
      HTMLAttributes: { "data-type": "mention" },
      suggestion: { char: "\u0000", items: () => [] },
      renderText: ({ node }) => mentionLabel(node.attrs),
      renderHTML: ({ options, node }) => ["span", options.HTMLAttributes, mentionLabel(node.attrs)],
    }),
  ];
}

/**
 * The page editor: headings, lists, checklists, tables, info/warning panels, code,
 * images, links and @mentions. "/" opens the block menu; read-only mode renders the same content.
 */
export function RichEditor({
  html,
  editable,
  onChange,
  onUpload,
  placeholder,
  onCreateTask,
  live,
  onEditor,
  stickyClass = "top-14 md:top-12",
}: {
  html: string;
  editable: boolean;
  onChange?: (html: string) => void;
  /** Uploads an image and returns the address to show it from. */
  onUpload?: (file: File) => Promise<string>;
  placeholder?: string;
  /** "Tạo việc" on a checklist line: creates a task from its text and returns where it lives. */
  onCreateTask?: (title: string) => Promise<{ code: string; url: string }>;
  /** Live co-editing: the shared draft and cursors (see ./collab). */
  live?: { extensions: AnyExtension[] } | null;
  /** The editor once it exists, for reading the page without waiting for onChange. */
  onEditor?: (editor: Editor | null) => void;
  /** Where the toolbar sticks while scrolling (below whatever bar the page keeps above it). */
  stickyClass?: string;
}) {
  const t = useT();
  const dir = useDirectory();
  const [menu, setMenu] = useState<{ kind: "/" | "@"; q: string; from: number; x: number; y: number; i: number } | null>(null);
  const menuRef = useRef(menu);
  menuRef.current = menu;
  const fileInput = useRef<HTMLInputElement>(null);
  const changeTimer = useRef<number | undefined>(undefined);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const editor = useEditor({
    immediatelyRender: false,
    // Typing does not re-render the toolbar; it follows `on` below, which changes only when a button's state does.
    shouldRerenderOnTransaction: false,
    editable,
    // With a live session the shared draft is the content, so none is passed in.
    ...(live ? {} : { content: html }),
    extensions: [...pageExtensions({ editable, placeholder: placeholder ?? t("docs.placeholder"), history: !live }), ...(live?.extensions ?? [])],
    onUpdate: ({ editor: e, transaction }) => {
      // Serialising the whole page on every key is the slow part of typing in a long page: once typing pauses.
      window.clearTimeout(changeTimer.current);
      changeTimer.current = window.setTimeout(() => onChangeRef.current?.(e.getHTML()), 250);
      // Someone else's change (live editing) never opens this person's "/" or "@" menu.
      if ((transaction.getMeta("y-sync$") as { isChangeOrigin?: boolean } | undefined)?.isChangeOrigin) return;
      // "/" and "@" menus: the text typed since the trigger in the current paragraph.
      const { from } = e.state.selection;
      const before = e.state.doc.textBetween(Math.max(0, from - 40), from, "\n", "\u0000");
      const m = before.match(/(?:^|\s)([/@])([\p{L}\p{N}]*)$/u);
      if (!m) return setMenu(null);
      const start = from - m[2]!.length - 1;
      const c = e.view.coordsAtPos(from);
      setMenu((cur) => ({ kind: m[1] as "/" | "@", q: m[2]!, from: start, x: c.left, y: c.bottom, i: cur && cur.kind === m[1] ? Math.min(cur.i, 7) : 0 }));
    },
    editorProps: {
      // The whole sheet below the toolbar is the writing area: a click anywhere in it puts the caret there.
      attributes: { class: cx("focus:outline-none", editable && "min-h-[55vh] cursor-text pb-24") },
      handleKeyDown: (_view, ev) => {
        const cur = menuRef.current;
        if (!cur) return false;
        if (ev.key === "Escape") {
          setMenu(null);
          return true;
        }
        if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
          setMenu({ ...cur, i: Math.max(0, cur.i + (ev.key === "ArrowDown" ? 1 : -1)) });
          return true;
        }
        if (ev.key === "Enter" || ev.key === "Tab") {
          pickRef.current?.(cur.i);
          return true;
        }
        return false;
      },
    },
  });
  // What the toolbar shows as on, recomputed per change but only re-rendering when it differs.
  const on = useEditorState({
    editor,
    selector: ({ editor: e }) =>
      e && e.isEditable
        ? {
            block: e.isActive("heading", { level: 1 }) ? "h1" : e.isActive("heading", { level: 2 }) ? "h2" : e.isActive("heading", { level: 3 }) ? "h3" : "p",
            bold: e.isActive("bold"),
            italic: e.isActive("italic"),
            underline: e.isActive("underline"),
            strike: e.isActive("strike"),
            highlight: e.isActive("highlight"),
            code: e.isActive("code"),
            link: e.isActive("link"),
            bulletList: e.isActive("bulletList"),
            orderedList: e.isActive("orderedList"),
            taskList: e.isActive("taskList"),
            table: e.isActive("table"),
            callout: e.isActive("callout"),
            taskItem: e.isActive("taskItem"),
          }
        : null,
  });
  useEffect(() => {
    editor?.setEditable(editable);
  }, [editor, editable]);
  useEffect(() => {
    onEditor?.(editor);
    return () => {
      window.clearTimeout(changeTimer.current);
      onEditor?.(null);
    };
  }, [editor, onEditor]);

  const items =
    menu?.kind === "/"
      ? COMMANDS.filter((c) => !menu.q || fold(t(c.label)).includes(fold(menu.q)) || c.key.includes(fold(menu.q)))
      : menu?.kind === "@"
        ? [...dir.byId.values()].filter((p) => !menu.q || fold(p.displayName).includes(fold(menu.q))).slice(0, 8)
        : [];
  const pick = (i: number) => {
    if (!editor || !menu) return;
    const range = { from: menu.from, to: editor.state.selection.from };
    if (menu.kind === "/") {
      const c = (items as Cmd[])[Math.min(i, items.length - 1)];
      if (!c) return setMenu(null);
      editor.chain().focus().deleteRange(range).run();
      c.run(editor);
    } else {
      const p = (items as { userId: string; displayName: string }[])[Math.min(i, items.length - 1)];
      if (!p) return setMenu(null);
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertContent([
          { type: "mention", attrs: { id: p.userId, label: p.displayName } },
          { type: "text", text: " " },
        ])
        .run();
    }
    setMenu(null);
  };
  const pickRef = useRef(pick);
  pickRef.current = pick;

  const upload = async (f: File | undefined) => {
    if (!f || !editor || !onUpload) return;
    const src = await onUpload(f);
    editor.chain().focus().setImage({ src, alt: f.name }).run();
  };
  if (!editor) return <div className={cx(docProse, "min-h-[50vh]")} />;
  const tb = (on: boolean) =>
    cx(
      "grid h-8 min-w-8 shrink-0 place-items-center rounded-md px-1.5 text-sm font-semibold transition-colors [&_svg]:size-4",
      on ? "bg-ink text-surface" : "text-ink-2 hover:bg-hover hover:text-ink",
    );
  const link = () => {
    const prev = editor.getAttributes("link").href as string | undefined;
    const url = window.prompt(t("docs.linkPrompt"), prev ?? "https://");
    if (url === null) return;
    if (!url.trim()) editor.chain().focus().unsetLink().run();
    else editor.chain().focus().extendMarkRange("link").setLink({ href: url.trim() }).run();
  };
  return (
    <div>
      {editable ? (
        <div
          // Formatting only: one row of icons on its own card, scrolling sideways when narrow; Huỷ / Xuất bản
          // live on the page's bar above, so a stray click while formatting never publishes or throws the draft away.
          className={cx("bg-surface shadow-card sticky z-10 mb-6 flex items-center gap-0.5 overflow-x-auto rounded-xl px-1.5 py-1 [scrollbar-width:none]", stickyClass)}
          role="toolbar"
          aria-label={t("docs.toolbar")}
        >
          <Picker
            variant="button"
            label={t("docs.blockType")}
            value={on?.block ?? "p"}
            className="[&>button]:border-transparent [&>button]:shadow-none"
            options={[
              { value: "p", label: t("docs.paragraph") },
              { value: "h1", label: t("docs.cmd.h1") },
              { value: "h2", label: t("docs.cmd.h2") },
              { value: "h3", label: t("docs.cmd.h3") },
            ]}
            onChange={(v) => {
              if (v === "p") editor.chain().focus().setParagraph().run();
              else
                editor
                  .chain()
                  .focus()
                  .setNode("heading", { level: Number(v.slice(1)) as 1 | 2 | 3 })
                  .run();
            }}
          />
          <span className="bg-hairline mx-1 h-5 w-px shrink-0" />
          <button type="button" className={tb(!!on?.bold)} onClick={() => editor.chain().focus().toggleBold().run()} aria-label={t("docs.bold")} title={t("docs.bold")}>
            <BoldIcon />
          </button>
          <button type="button" className={tb(!!on?.italic)} onClick={() => editor.chain().focus().toggleItalic().run()} aria-label={t("docs.italic")} title={t("docs.italic")}>
            <ItalicIcon />
          </button>
          <button
            type="button"
            className={cx(tb(!!on?.underline), "underline")}
            onClick={() => editor.chain().focus().toggleUnderline().run()}
            aria-label={t("docs.underline")}
            title={t("docs.underline")}
          >
            U
          </button>
          <button type="button" className={tb(!!on?.strike)} onClick={() => editor.chain().focus().toggleStrike().run()} aria-label={t("docs.strike")} title={t("docs.strike")}>
            <StrikeIcon />
          </button>
          <button
            type="button"
            className={tb(!!on?.highlight)}
            onClick={() => editor.chain().focus().toggleHighlight().run()}
            aria-label={t("docs.highlight")}
            title={t("docs.highlight")}
          >
            <span className="bg-signal-wash rounded-sm px-0.5">A</span>
          </button>
          <button type="button" className={tb(!!on?.code)} onClick={() => editor.chain().focus().toggleCode().run()} aria-label={t("docs.code")} title={t("docs.code")}>
            <CodeIcon />
          </button>
          <button type="button" className={tb(!!on?.link)} onClick={link} aria-label={t("docs.link")} title={t("docs.link")}>
            <LinkIcon />
          </button>
          <span className="bg-hairline mx-1 h-5 w-px shrink-0" />
          <button
            type="button"
            className={tb(!!on?.bulletList)}
            onClick={() => editor.chain().focus().toggleBulletList().run()}
            aria-label={t("docs.cmd.bullet")}
            title={t("docs.cmd.bullet")}
          >
            <ListIcon />
          </button>
          <button
            type="button"
            className={tb(!!on?.orderedList)}
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
            aria-label={t("docs.cmd.numbered")}
            title={t("docs.cmd.numbered")}
          >
            <ListOrderedIcon />
          </button>
          <button
            type="button"
            className={tb(!!on?.taskList)}
            onClick={() => editor.chain().focus().toggleTaskList().run()}
            aria-label={t("docs.cmd.todo")}
            title={t("docs.cmd.todo")}
          >
            <ChecklistIcon />
          </button>
          <button
            type="button"
            className={tb(!!on?.table)}
            onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
            aria-label={t("docs.cmd.table")}
            title={t("docs.cmd.table")}
          >
            <GridIcon />
          </button>
          <button
            type="button"
            className={tb(!!on?.callout)}
            onClick={() => editor.chain().focus().wrapIn("callout", { type: "info" }).run()}
            aria-label={t("docs.cmd.info")}
            title={t("docs.cmd.info")}
          >
            <InfoIcon />
          </button>
          {onCreateTask && !!on?.taskItem ? (
            <button
              type="button"
              className={cx(tb(false), "w-auto whitespace-nowrap px-2 text-sm font-medium")}
              onClick={async () => {
                const { $from } = editor.state.selection;
                let text = "";
                for (let d = $from.depth; d > 0; d--) {
                  if ($from.node(d).type.name === "taskItem") {
                    text = $from.node(d).firstChild?.textContent.trim() ?? "";
                    break;
                  }
                }
                if (!text) return;
                const end = $from.end();
                const r = await onCreateTask(text.slice(0, 300));
                editor
                  .chain()
                  .focus()
                  .insertContentAt(end, [
                    { type: "text", text: " " },
                    { type: "text", text: r.code, marks: [{ type: "link", attrs: { href: r.url } }] },
                  ])
                  .run();
              }}
              title={t("docs.toTask.hint")}
            >
              {t("docs.toTask.button")}
            </button>
          ) : null}
          {onUpload ? (
            <>
              <button type="button" className={tb(false)} onClick={() => fileInput.current?.click()} aria-label={t("docs.image")} title={t("docs.image")}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-4" aria-hidden="true">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <circle cx="9" cy="9" r="2" />
                  <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
                </svg>
              </button>
              <input ref={fileInput} type="file" accept="image/*" hidden onChange={(e) => void upload(e.target.files?.[0])} />
            </>
          ) : null}
          {!!on?.table ? (
            <span className="ml-1 flex shrink-0 gap-0.5 whitespace-nowrap text-xs">
              <button type="button" className={tb(false)} onClick={() => editor.chain().focus().addRowAfter().run()}>
                {t("docs.addRow")}
              </button>
              <button type="button" className={tb(false)} onClick={() => editor.chain().focus().addColumnAfter().run()}>
                {t("docs.addCol")}
              </button>
              <button type="button" className={tb(false)} onClick={() => editor.chain().focus().deleteTable().run()}>
                {t("docs.deleteTable")}
              </button>
            </span>
          ) : null}
          <span className="text-ink-2 ml-auto hidden shrink-0 whitespace-nowrap px-2 text-xs xl:inline">{t("docs.slashHint")}</span>
        </div>
      ) : null}
      <EditorContent editor={editor} className={docProse} />
      {menu && items.length ? (
        <div
          role="listbox"
          aria-label={menu.kind === "/" ? t("docs.blocks") : t("docs.people")}
          className={cx(popover, "fixed z-50 max-h-72 w-72 overflow-y-auto")}
          style={{ left: Math.min(menu.x, window.innerWidth - 300), top: menu.y + 6 }}
        >
          {items.map((it, i) => {
            const on = i === Math.min(menu.i, items.length - 1);
            return "key" in it ? (
              <button
                key={it.key}
                type="button"
                role="option"
                aria-selected={on}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(i);
                }}
                className={cx(menuItem, "flex-col items-start gap-0 py-2", on && "bg-hover")}
              >
                <span className="font-medium">{t(it.label)}</span>
                <span className="text-ink-2 text-xs">{t(it.hint)}</span>
              </button>
            ) : (
              <button
                key={it.userId}
                type="button"
                role="option"
                aria-selected={on}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(i);
                }}
                className={cx(menuItem, on && "bg-hover")}
              >
                {it.displayName}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
