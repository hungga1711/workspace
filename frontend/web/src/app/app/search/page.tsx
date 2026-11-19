import { featureOn } from "@/lib/features";
import Link from "next/link";
import {
  ApprovalIcon,
  ArrowRightIcon,
  CalendarIcon,
  ChatIcon,
  CheckCircleIcon,
  FileIcon,
  FolderIcon,
  HashIcon,
  PaperclipIcon,
  SearchIcon,
  UsersIcon,
  WhiteboardIcon,
} from "@/components/app/icons";
import { gw } from "@/lib/gateway";
import { PageHead } from "@/components/chat/PageHead";
import { card, IconTile, type Tone } from "@/components/ui/Bento";
import { SpotArea } from "@/components/ui/SpotArea";
import { Segmented } from "@/components/ui/Segmented";
import { SearchResults, type Hit } from "@/components/app/SearchResults";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { cx, searchPill } from "@/lib/ui";
import { getT } from "@/lib/i18n/server";
import type { Metadata } from "next";
import { refParam } from "@/components/work/loaders";
import { approvalHref, docHref, meetingHref, projectHref, taskHref, whiteboardHref } from "@/lib/links";

export async function generateMetadata({ searchParams }: { searchParams: Promise<{ q?: string }> }): Promise<Metadata> {
  const t = await getT();
  const q = ((await searchParams).q ?? "").trim();
  return { title: q ? `${q} · ${t("search.title")}` : t("search.title") };
}

// Work first (tasks and documents are what people look for most), conversations after.
const TYPES = ["", "task", "document", "project", "whiteboard", "person", "message", "file", "channel"] as const;
type Kind = Exclude<(typeof TYPES)[number], "">;
/** In "Tất cả", each kind shows its best few; the rest is one click away on that kind's tab. */
const PER_GROUP = 4;
/** A query that could be a record code (T-041, P-001, D-012…): one word with a letter and a digit. */
const CODE_LIKE = /^(?=.*\d)(?=.*\p{L})[\p{L}\d._/#-]{2,40}$/u;

/** The task, project, document, request or meeting whose code is exactly `text` (any case), as a search hit; null when none. */
async function byCode(text: string): Promise<Hit | null> {
  if (!CODE_LIKE.test(text)) return null;
  const ref = refParam(text);
  const [task, project, doc, request, meeting, board] = await Promise.all([
    gw<{ task: { id: string; code: string; title: string; updatedAt: string } }>(`/api/work/tasks/${ref}`).catch(() => null),
    gw<{ id: string; code: string; name: string; description: string }>(`/api/work/projects/${ref}`).catch(() => null),
    gw<{ document: { id: string; code: string; title: string } }>(`/api/work/docs/${ref}?track=0`).catch(() => null),
    gw<{ id: string; code: string; title: string; createdAt: string }>(`/api/work/approvals/${ref}`).catch(() => null),
    gw<{ event: { id: string; code: string; title: string; startsAt: string } }>(`/api/work/meetings/${ref}`).catch(() => null),
    // Whiteboards answer by code too (W-001); only the summary fields are read.
    gw<{ id: string; code: string; title: string; updatedAt: string }>(`/api/work/whiteboards/${ref}`).catch(() => null),
  ]);
  const at = new Date().toISOString();
  if (task) return { entity_type: "task", entity_id: task.task.id, title: task.task.title, body: task.task.code, url: taskHref(task.task), updated_at: task.task.updatedAt ?? at };
  if (project) return { entity_type: "project", entity_id: project.id, title: project.name, body: project.code, url: projectHref(project), updated_at: at };
  if (doc) return { entity_type: "document", entity_id: doc.document.id, title: doc.document.title, body: doc.document.code, url: docHref(doc.document), updated_at: at };
  if (request) return { entity_type: "approval", entity_id: request.id, title: request.title, body: request.code, url: approvalHref(request), updated_at: request.createdAt ?? at };
  if (meeting)
    return {
      entity_type: "meeting",
      entity_id: meeting.event.id,
      title: meeting.event.title,
      body: meeting.event.code,
      url: meetingHref(meeting.event),
      updated_at: meeting.event.startsAt ?? at,
    };
  if (board) return { entity_type: "whiteboard", entity_id: board.id, title: board.title, body: board.code, url: whiteboardHref(board), updated_at: board.updatedAt ?? at };
  return null;
}

/** Full search results: every type, permission-filtered by the server, grouped by kind. */
export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string; type?: string }> }) {
  const { q = "", type = "" } = await searchParams;
  const text = q.trim();
  const t = await getT();
  const [found, exact] = await Promise.all([
    text.length >= 2
      ? // A failed search must not pass for "no results": the page says so and offers a retry.
        gw<{ hits: Hit[]; partial?: boolean }>(`/api/chat/search?q=${encodeURIComponent(text)}${type ? `&types=${type}` : ""}`).catch(() => ({
          hits: [] as Hit[],
          failed: true as const,
        }))
      : { hits: [] as Hit[] },
    byCode(text),
  ]);
  // A record whose code was typed whole comes first, once (it may also be among the ranked hits).
  const r = { hits: exact && (!type || type === exact.entity_type) ? [exact, ...found.hits.filter((h) => h.entity_id !== exact.entity_id)] : found.hits };
  const href = (k: string) => `/app/search?q=${encodeURIComponent(text)}${k ? `&type=${k}` : ""}`;
  // Kinds in the order of the filter row, each with its hits (the server already ranks within a kind).
  // Kinds of a feature the deployment left out are not offered as a filter (the server never returns them).
  const [docsOn, boardsOn] = await Promise.all([featureOn("docs"), featureOn("whiteboards")]);
  const kinds = TYPES.filter((k) => !(k === "document" && !docsOn) && !(k === "whiteboard" && !boardsOn));
  const groups = kinds
    .filter((k): k is Kind => k !== "")
    .map((k) => ({ kind: k, hits: r.hits.filter((h) => h.entity_type === k && h.entity_id !== exact?.entity_id) }))
    .filter((g) => g.hits.length);
  return (
    <SpotArea className="flex flex-col gap-5 max-md:gap-4">
      <PageHead title={text ? `“${text}”` : t("search.title")} meta={text ? t("search.resultCount", { count: r.hits.length }) : t("search.intro")} />
      <form action="/app/search" role="search" className={cx(searchPill, "max-w-[640px] md:min-h-10")}>
        <SearchIcon className="pointer-events-none size-4 shrink-0" />
        <input
          name="q"
          type="text"
          enterKeyHint="search"
          defaultValue={text}
          aria-label={t("search.keyword")}
          placeholder={t("search.placeholder")}
          className="text-ink placeholder:text-ink-2 min-h-10 min-w-0 flex-1 bg-transparent outline-none"
          autoFocus
        />
        {type ? <input type="hidden" name="type" value={type} /> : null}
      </form>
      {text ? (
        <div className="-mt-1 min-w-0 max-w-full overflow-x-auto">
          <Segmented label={t("search.types")} value={type} options={kinds.map((k) => ({ value: k, label: t(`search.type.${k || "all"}`), href: href(k) }))} />
        </div>
      ) : null}
      {text && "partial" in found && found.partial ? <p className="text-ink-2 -mt-2 text-xs">{t("search.partial")}</p> : null}
      {!text ? null : "failed" in found && r.hits.length === 0 ? (
        <LoadFailed what={t("search.failed")} className="max-w-[640px]" />
      ) : r.hits.length === 0 ? (
        <div className="bg-surface shadow-card flex min-h-[4.75rem] max-w-[640px] items-center gap-3.5 rounded-xl px-5 py-4 max-sm:px-4">
          <IconTile tone="sky">
            <SearchIcon />
          </IconTile>
          <span className="min-w-0 flex-1 leading-[1.35]">
            <span className="block text-sm font-semibold tracking-[-0.01em]">{t("search.noResults")}</span>
            <span className="text-ink-2 block text-pretty text-[13px]">{t("search.noResultsHint")}</span>
          </span>
        </div>
      ) : type ? (
        <div className="max-w-4xl">
          <SearchResults hits={r.hits} q={text} />
        </div>
      ) : (
        <div className="grid items-start gap-4 xl:grid-cols-2">
          {exact ? (
            <KindTile id="sr-exact" kind={exact.entity_type} title={t("search.exactCode")} className="xl:col-span-2">
              <SearchResults hits={[exact]} q={text} bare />
            </KindTile>
          ) : null}
          {groups.map((g) => (
            <KindTile
              key={g.kind}
              id={`sr-${g.kind}`}
              kind={g.kind}
              title={t(`search.type.${g.kind}`)}
              count={g.hits.length}
              more={g.hits.length > PER_GROUP ? { href: href(g.kind), label: t("search.seeAll", { count: g.hits.length }) } : undefined}
            >
              <SearchResults hits={g.hits.slice(0, PER_GROUP)} q={text} bare />
            </KindTile>
          ))}
        </div>
      )}
    </SpotArea>
  );
}

/** Each kind's tone and icon, as in the result rows: a kind's tile is led by them (Home's bento tile). */
const KIND_MARK: Record<string, [Tone, (p: { className?: string }) => React.ReactNode]> = {
  message: ["violet", ChatIcon],
  task: ["sky", CheckCircleIcon],
  document: ["green", FileIcon],
  whiteboard: ["tangerine", WhiteboardIcon],
  project: ["violet", FolderIcon],
  file: ["rose", PaperclipIcon],
  channel: ["tangerine", HashIcon],
  person: ["rose", UsersIcon],
  approval: ["green", ApprovalIcon],
  meeting: ["tangerine", CalendarIcon],
};

function KindTile({
  id,
  kind,
  title,
  count,
  more,
  className,
  children,
}: {
  id: string;
  kind: string;
  title: string;
  count?: number;
  more?: { href: string; label: string };
  className?: string;
  children: React.ReactNode;
}) {
  const [tone, Icon] = KIND_MARK[kind] ?? ["sky", FileIcon];
  return (
    <section aria-labelledby={id} className={cx(card, "group/tile min-w-0 rounded-xl p-5 max-sm:p-4", className)}>
      <header className="flex min-h-8 items-center gap-3">
        <IconTile tone={tone}>
          <Icon />
        </IconTile>
        <h2 id={id} className="m-0 min-w-0 truncate text-sm font-semibold tracking-[-0.01em]">
          {title}
        </h2>
        {count ? <span className="text-ink-2 text-xs tabular-nums">{count}</span> : null}
        <span className="flex-1" />
        {more ? (
          <Link href={more.href} className="text-ink-2 hover:text-ink group/more relative z-[2] inline-flex items-center gap-1 text-xs font-medium no-underline">
            {more.label}
            <ArrowRightIcon aria-hidden="true" className="size-3.5 transition-transform group-hover/more:translate-x-0.5" />
          </Link>
        ) : null}
      </header>
      {children}
    </section>
  );
}
