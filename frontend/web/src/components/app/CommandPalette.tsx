"use client";

import { useTaskCodeRe } from "@/lib/task-refs";

import { ProjectBadge } from "@/components/ui/ProjectBadge";
import { Markdown } from "@/lib/markdown";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/client";
import { featureOfHref, useFeatures } from "@/lib/features-context";
import { useAiEnabled } from "@/lib/ai-context";
import { Avatar, useDirectory } from "@/lib/people";
import { cx } from "@/lib/ui";
import { useDialog } from "./useDialog";
import { Portal } from "@/components/ui/Portal";
import { useT } from "@/lib/i18n/client";
import type { MessageKey } from "@/lib/i18n/core";
import { formatMentions } from "@/lib/names";
import {
  ApprovalIcon,
  ArrowRightIcon,
  CheckIcon,
  CopyIcon,
  RefreshIcon,
  SparkleIcon,
  CalendarIcon,
  VideoIcon,
  ChatIcon,
  CheckCircleIcon,
  FileIcon,
  FolderIcon,
  HashIcon,
  PaperclipIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  UsersIcon,
  WhiteboardIcon,
} from "./icons";
import { approvalHref, docHref, meetingHref, projectHref, taskHref } from "@/lib/links";
import { fold } from "@/lib/fold";

interface Hit {
  entity_type: string;
  entity_id: string;
  title: string;
  body: string;
  url: string;
}
interface Row {
  key: string;
  label: string;
  sub?: string;
  kind: string;
  icon: React.ReactNode;
  run: () => void;
}

/** `admin`: only for admins (anyone else would land on an access-denied page). */
const COMMANDS: { label: MessageKey; href: string; icon: React.ReactNode; words: string; admin?: boolean }[] = [
  { label: "palette.cmd.newTask", href: "/app/work/tasks?new=task", icon: <PlusIcon />, words: "tao task viec moi" },
  { label: "palette.cmd.newProject", href: "/app/work/tasks?view=projects&new=project", icon: <FolderIcon />, words: "tao du an project" },
  { label: "palette.cmd.newDoc", href: "/app/work/docs?new=page", icon: <FileIcon />, words: "tao tai lieu doc" },
  { label: "palette.cmd.calendar", href: "/app/work/calendar", icon: <CalendarIcon />, words: "lich hop calendar meeting" },
  { label: "palette.cmd.approvals", href: "/app/work/ops", icon: <ApprovalIcon />, words: "phe duyet approval" },
  { label: "palette.cmd.board", href: "/app/work/tasks?view=projects", icon: <FolderIcon />, words: "kanban bang board" },
  { label: "palette.cmd.meetings", href: "/app/work/calendar?view=meetings", icon: <VideoIcon />, words: "cuoc hop meeting bien ban" },
  { label: "palette.cmd.leave", href: "/app/time?tab=leave", icon: <UsersIcon />, words: "nghi phep leave" },
  { label: "palette.cmd.attendance", href: "/app/time?tab=attendance", icon: <UsersIcon />, words: "cham cong attendance" },
  { label: "palette.cmd.searchMessages", href: "/app/search?type=message", icon: <SearchIcon />, words: "tim tin nhan search messages" },
  { label: "palette.cmd.password", href: "/app/me", icon: <SettingsIcon />, words: "doi mat khau password bao mat" },
  { label: "palette.cmd.people", href: "/app/me/people", icon: <UsersIcon />, words: "danh ba nguoi people" },
  { label: "palette.cmd.saved", href: "/app/chat/saved", icon: <ChatIcon />, words: "tin da luu saved" },
  { admin: true, label: "palette.cmd.invite", href: "/admin/workspace/members", icon: <UsersIcon />, words: "moi invite thanh vien" },
  { admin: true, label: "palette.cmd.settings", href: "/admin/workspace/settings", icon: <SettingsIcon />, words: "cai dat settings" },
  { admin: true, label: "palette.cmd.announce", href: "/admin/workspace/announcements", icon: <SettingsIcon />, words: "thong bao announcement dang" },
];
/** The app's destinations ("Đi tới …"): the sidebar's nine, Tin nhắn and its unread view, Danh bạ, and Quản trị for admins. */
const GOTO: { label: MessageKey; href: string; words: string; admin?: boolean }[] = [
  { label: "shell.nav.home", href: "/app/home", words: "trang chu home" },
  { label: "shell.nav.messages", href: "/app/chat", words: "tin nhan hop thu inbox chat direct messages" },
  { label: "shell.nav.unreadMessages", href: "/app/chat/unreads", words: "chua doc unread tin nhan moi" },
  { label: "shell.nav.tasks", href: "/app/work/tasks", words: "viec task du an project kanban" },
  { label: "shell.nav.aiHub", href: "/app/ai/progress", words: "ai tien do hoi dap ap dung goi y insights progress ask adoption" },
  { label: "shell.nav.docs", href: "/app/work/docs", words: "tai lieu docs tep files drive" },
  { label: "shell.nav.whiteboards", href: "/app/work/whiteboards", words: "bang trang whiteboard so do ve sticky giay nho" },
  { label: "shell.nav.calendar", href: "/app/work/calendar", words: "lich calendar cuoc hop" },
  { label: "shell.nav.requests", href: "/app/work/ops", words: "yeu cau phe duyet de nghi request approval" },
  { label: "shell.nav.me", href: "/app/me", words: "cua toi ho so me profile" },
  { label: "shell.nav.time", href: "/app/time", words: "cham cong nghi phep gio lam time attendance leave" },
  { label: "shell.nav.people", href: "/app/me/people", words: "danh ba nguoi dong nghiep people directory" },
  { admin: true, label: "shell.nav.admin", href: "/admin/workspace", words: "quan tri admin cai dat settings" },
];

/** ⌘K: people, channels, projects, permission-aware search, commands and "ask AI". Loaded only when opened. */
type ExactKind = "task" | "document" | "approval" | "meeting";
/** How a record found by its exact code shows and opens. */
const EXACT: Record<ExactKind, { icon: React.ReactNode; href: (r: { id: string; code: string }) => string }> = {
  task: { icon: <CheckCircleIcon />, href: taskHref },
  document: { icon: <FileIcon />, href: docHref },
  approval: { icon: <ApprovalIcon />, href: approvalHref },
  meeting: { icon: <CalendarIcon />, href: meetingHref },
};

export default function CommandPalette({ onClose, isAdmin = false }: { onClose: () => void; isAdmin?: boolean }) {
  const ref = useDialog<HTMLDivElement>(onClose);
  const router = useRouter();
  const dir = useDirectory();
  const t = useT();
  const aiOn = useAiEnabled();
  // Destinations and commands of a feature the deployment left out are not offered.
  const has = useFeatures();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [searchFailed, setSearchFailed] = useState(false);
  const [channels, setChannels] = useState<{ id: string; name: string | null; displayName?: string | null; kind: string }[]>([]);
  const [projects, setProjects] = useState<{ id: string; name: string; code: string }[]>([]);
  const [sel, setSel] = useState(0);
  const [answer, setAnswer] = useState<{ state: "loading" | "ready" | "error"; text?: string } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void api<{ channels: { id: string; name: string | null; displayName?: string | null; kind: string }[] }>("chat/channels")
      .then((r) => setChannels(r.channels.filter((c) => c.name)))
      .catch(() => undefined);
    void api<{ projects: { id: string; name: string; code: string }[] }>("work/projects")
      .then((r) => setProjects(r.projects))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    setAnswer(null);
    if (q.trim().length < 2) {
      setHits([]);
      return;
    }
    // Only the latest query's answer lands: a slow earlier search must not replace newer (or cleared) results.
    let live = true;
    const t = setTimeout(() => {
      api<{ hits: Hit[] }>(`chat/search?q=${encodeURIComponent(q.trim())}`)
        .then((r) => {
          if (!live) return;
          setHits(r.hits);
          setSearchFailed(false);
        })
        .catch(() => {
          if (!live) return;
          setHits([]);
          setSearchFailed(true);
        });
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q]);

  // A code typed whole (T-041, D-012, YC-007, H-012, any case): look the record up directly and offer it first, so Enter
  // opens it.
  const taskRe = useTaskCodeRe();
  const [exact, setExact] = useState<{ kind: ExactKind; id: string; code: string; title: string } | null>(null);
  useEffect(() => {
    setExact(null);
    const ref = q.trim();
    if (!/^(?=.*\d)(?=.*\p{L})[\p{L}\d._/#-]{2,40}$/u.test(ref)) return;
    let live = true;
    // A task code (the workspace's format) is only ever a task: one read instead of four, and no 404s from asking the
    // approvals, meetings and docs for it.
    const isTask = taskRe ? new RegExp(`^(?:${taskRe.source})$`, "i").test(ref) : false;
    const t = setTimeout(() => {
      const enc = encodeURIComponent(ref);
      const task = api<{ task: { id: string; code: string; title: string } }>(`work/tasks/${enc}`)
        .then((r) => ({ kind: "task" as const, ...r.task }))
        .catch(() => null);
      void (
        isTask
          ? Promise.all([task])
          : Promise.all([
              task,
              api<{ document: { id: string; code: string; title: string } }>(`work/docs/${enc}?track=0`)
                .then((r) => ({ kind: "document" as const, ...r.document }))
                .catch(() => null),
              api<{ id: string; code: string; title: string }>(`work/approvals/${enc}`)
                .then((r) => ({ kind: "approval" as const, id: r.id, code: r.code, title: r.title }))
                .catch(() => null),
              api<{ event: { id: string; code: string; title: string } }>(`work/meetings/${enc}`)
                .then((r) => ({ kind: "meeting" as const, id: r.event.id, code: r.event.code, title: r.event.title }))
                .catch(() => null),
            ])
      ).then((found: ({ kind: ExactKind; id: string; code: string; title: string } | null)[]) => {
        if (!live) return;
        const hit = found.find(Boolean) ?? null;
        setExact(hit);
        // It lands above whatever was highlighted: highlight it, so Enter opens the record typed.
        if (hit) setSel(0);
      });
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, taskRe]);

  const go = (href: string) => {
    onClose();
    router.push(href);
  };
  const ask = async () => {
    setAnswer({ state: "loading" });
    try {
      const r = await api<{ answer: string }>("ai/ask", { method: "POST", body: { question: q } });
      setAnswer({ state: "ready", text: r.answer });
    } catch {
      setAnswer({ state: "error" });
    }
  };
  const dm = async (userId: string) => {
    const r = await api<{ id: string }>("chat/dms", { method: "POST", body: { userId } });
    go(`/app/chat/${r.id}`);
  };

  const rows = useMemo<Row[]>(() => {
    const f = fold(q.trim());
    const match = (s: string) => !f || fold(s).includes(f);
    const out: Row[] = [];
    if (exact)
      out.push({
        key: `x:${exact.id}`,
        label: exact.title,
        sub: exact.code,
        kind: t(`palette.kind.${exact.kind}`),
        icon: EXACT[exact.kind].icon,
        run: () => go(EXACT[exact.kind].href(exact)),
      });
    if (aiOn && f.length >= 3)
      out.push({ key: "ai", label: t("palette.askAi", { q: q.trim() }), sub: t("palette.askAiSub"), kind: "AI", icon: <SparkleIcon />, run: () => void ask() });
    out.push(
      ...GOTO.filter((g) => has(featureOfHref(g.href)) && (isAdmin || !g.admin) && (match(t(g.label)) || (f && fold(g.words).includes(f))))
        .slice(0, f ? 3 : GOTO.length)
        .map((g) => ({ key: `goto:${g.href}`, label: t(g.label), kind: t("shell.keys.goTo"), icon: <ArrowRightIcon />, run: () => go(g.href) })),
    );
    out.push(
      ...COMMANDS.filter((c) => has(featureOfHref(c.href)) && (isAdmin || !c.admin) && (match(t(c.label)) || (f && fold(c.words).includes(f))))
        .slice(0, 4)
        .map((c) => ({ key: c.href, label: t(c.label), kind: t("palette.kind.command"), icon: c.icon, run: () => go(c.href) })),
    );
    if (f) {
      out.push(
        ...dir.people
          .filter((p) => p.userId !== dir.me && match(p.displayName))
          .slice(0, 4)
          .map((p) => ({
            key: `p:${p.userId}`,
            label: p.displayName,
            sub: p.email,
            kind: t("palette.kind.person"),
            icon: <Avatar id={p.userId} size="xs" />,
            run: () => void dm(p.userId),
          })),
      );
      out.push(
        ...channels
          .filter((c) => match(c.name ?? "") || (!!c.displayName && match(c.displayName)))
          .slice(0, 4)
          .map((c) => ({
            key: `c:${c.id}`,
            label: c.displayName ?? `#${c.name}`,
            sub: c.displayName ? `#${c.name}` : undefined,
            kind: t("palette.kind.channel"),
            icon: <HashIcon />,
            run: () => go(`/app/chat/${c.id}`),
          })),
      );
      out.push(
        ...projects
          .filter((p) => match(p.name) || match(p.code))
          .slice(0, 3)
          .map((p) => ({
            key: `pr:${p.id}`,
            label: p.name,
            sub: p.code,
            kind: t("palette.kind.project"),
            icon: <ProjectBadge id={p.id} name={p.name} size="sm" />,
            run: () => go(projectHref(p)),
          })),
      );
      const KIND: Record<string, [string, React.ReactNode]> = {
        message: [t("palette.kind.message"), <ChatIcon key="m" />],
        task: [t("palette.kind.task"), <CheckCircleIcon key="t" />],
        document: [t("palette.kind.document"), <FileIcon key="d" />],
        whiteboard: [t("palette.kind.whiteboard"), <WhiteboardIcon key="w" />],
        project: [t("palette.kind.project"), <FolderIcon key="p" />],
        file: [t("palette.kind.file"), <PaperclipIcon key="f" />],
        channel: [t("palette.kind.channel"), <HashIcon key="c" />],
        person: [t("palette.kind.person"), <SearchIcon key="u" />],
      };
      const names = dir.names;
      const shown = new Set(out.map((r) => r.key.replace(/^(p|c|pr|x):/, "")));
      out.push(
        ...hits
          .filter((h) => !shown.has(h.entity_id))
          // Messages outnumber everything else: three at most, so tasks, docs and people further down still show
          // ("Xem tất cả kết quả" has the rest).
          .filter((h, i, all) => h.entity_type !== "message" || all.slice(0, i).filter((x) => x.entity_type === "message").length < 3)
          .slice(0, 10)
          .map((h) => ({
            key: `h:${h.entity_type}:${h.entity_id}`,
            label: formatMentions(h.entity_type === "message" ? h.body : h.title || h.body, names),
            sub: h.entity_type === "message" ? (h.title ? `#${h.title}` : undefined) : h.body ? formatMentions(h.body, names) : undefined,
            kind: KIND[h.entity_type]?.[0] ?? h.entity_type,
            icon: h.entity_type === "person" ? <Avatar id={h.entity_id} size="xs" /> : (KIND[h.entity_type]?.[1] ?? <SearchIcon />),
            run: () => (h.entity_type === "person" ? void dm(h.entity_id) : go(h.url)),
          })),
      );
      if (f.length >= 2)
        out.push({
          key: "all",
          label: t("palette.allResults", { q: q.trim() }),
          kind: t("palette.kind.search"),
          icon: <SearchIcon />,
          run: () => go(`/app/search?q=${encodeURIComponent(q.trim())}`),
        });
    }
    return out;
  }, [q, hits, exact, channels, projects, dir, t, aiOn, isAdmin, has]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Portal>
      <div
        className="fixed inset-0 z-[70] bg-black/50"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div
          ref={ref}
          role="dialog"
          aria-modal="true"
          aria-label={t("palette.dialog")}
          className="bg-surface border-hairline shadow-popover mx-auto mt-[12vh] w-[min(640px,94vw)] overflow-hidden rounded-2xl border"
        >
          <div className="border-divider flex items-center gap-2.5 border-b px-4">
            <SearchIcon className="text-ink-2 size-[18px]" />
            <input
              autoFocus
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setSel(0);
              }}
              placeholder={t("palette.placeholder")}
              aria-label={t("palette.search")}
              role="combobox"
              aria-expanded="true"
              aria-controls="palette-list"
              aria-activedescendant={rows[sel] ? `pi-${sel}` : undefined}
              className="h-13 placeholder:text-ink-2 flex-1 bg-transparent text-base outline-none"
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setSel((s) => Math.min(s + 1, rows.length - 1));
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setSel((s) => Math.max(s - 1, 0));
                }
                if (e.key === "Enter" && rows[sel]) rows[sel]!.run();
              }}
            />
            <kbd className="bg-hover text-ink-2 rounded-sm px-1.5 py-0.5 text-[11px] font-medium">Esc</kbd>
          </div>
          {answer ? (
            <div className="border-divider bg-ground border-b px-4 pb-3 pt-2.5 text-sm" role="status" aria-live="polite">
              <div className="text-ink-2 mb-1 flex min-h-7 items-center gap-1.5 text-xs font-semibold">
                <SparkleIcon className="size-3.5" />
                <span className="flex-1">{t("palette.aiAnswer")}</span>
                {answer.state === "ready" ? (
                  <button
                    type="button"
                    aria-label={copied ? t("aiw.chat.copied") : t("aiw.chat.copy")}
                    title={copied ? t("aiw.chat.copied") : t("aiw.chat.copy")}
                    className="hover:bg-hover hover:text-ink -mr-1.5 grid size-7 place-items-center rounded-md transition-colors"
                    onClick={() =>
                      void navigator.clipboard
                        ?.writeText(answer.text ?? "")
                        .then(() => {
                          setCopied(true);
                          setTimeout(() => setCopied(false), 1500);
                        })
                        .catch(() => undefined)
                    }
                  >
                    {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
                  </button>
                ) : null}
              </div>
              {answer.state === "loading" ? (
                <span className="text-ink-2 inline-flex items-center gap-2 py-1">
                  <span className="inline-flex gap-1" aria-hidden="true">
                    <span className="bg-ink-2 size-1.5 animate-pulse rounded-full" />
                    <span className="bg-ink-2 size-1.5 animate-pulse rounded-full [animation-delay:200ms]" />
                    <span className="bg-ink-2 size-1.5 animate-pulse rounded-full [animation-delay:400ms]" />
                  </span>
                  {t("aiw.chat.thinking")}
                </span>
              ) : answer.state === "error" ? (
                <p className="text-block m-0 flex items-center gap-2">
                  <span className="flex-1">{t("palette.aiError")}</span>
                  <button type="button" onClick={() => void ask()} className="text-ink hover:bg-hover inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium">
                    <RefreshIcon className="size-3.5" />
                    {t("aiw.chat.retry")}
                  </button>
                </p>
              ) : (
                // Answers come back as Markdown (lists, bold), the same as in the assistant: render it, never the raw marks.
                // A long one scrolls in its own box so the results stay in view.
                <div className="max-h-[35vh] overflow-y-auto [&_ol]:my-1 [&_p]:my-1 [&_ul]:my-1">
                  <Markdown source={answer.text ?? ""} />
                </div>
              )}
            </div>
          ) : null}
          <ul id="palette-list" role="listbox" className="m-0 max-h-[50vh] list-none overflow-auto p-1.5">
            {rows.length === 0 ? (
              <li className="text-ink-2 px-3 py-6 text-center text-sm">{searchFailed ? `${t("search.failed")}: ${t("ui.loadFailed.body")}` : t("palette.noResults")}</li>
            ) : (
              rows.map((r, i) => (
                <li
                  key={r.key}
                  id={`pi-${i}`}
                  role="option"
                  aria-selected={i === sel}
                  // A real pointer move picks a row, not results landing under a resting cursor (Chrome fires
                  // mouseenter on layout changes): Enter must still run the first row, "Ask AI".
                  onMouseMove={() => i !== sel && setSel(i)}
                  onClick={r.run}
                  className={cx("flex min-h-10 cursor-pointer items-center gap-3 rounded-lg px-3 py-2", i === sel && "bg-hover")}
                >
                  <span className="text-ink-2 grid size-5 place-items-center">{r.icon}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{r.label}</span>
                    {r.sub ? <span className="text-ink-2 block truncate text-xs">{r.sub}</span> : null}
                  </span>
                  <span className="text-ink-2 text-xs">{r.kind}</span>
                </li>
              ))
            )}
          </ul>
        </div>
      </div>
    </Portal>
  );
}
