"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import { topicLabel, topicLabels } from "@/lib/ai-labels";
import { useFormat, useT } from "@/lib/i18n/client";
import { Avatar, useDirectory } from "@/lib/people";
import { btn, btnPrimary, btnSm, chip, chipWarn, cx, iconBtn } from "@/lib/ui";
import { CheckIcon, CopyIcon, GlobeIcon, LockIcon, MoreIcon, PinIcon, PlusIcon, SearchIcon, SparkleIcon, UsersIcon } from "@/components/app/icons";
import { EmptyState } from "@/components/ui/EmptyState";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { Menu, type MenuItem } from "@/components/ui/Menu";
import { Picker } from "@/components/ui/Picker";
import { Segmented } from "@/components/ui/Segmented";
import { TopicIcon } from "@/components/ai/TopicIcon";
import type { TopicRow } from "./SharePromptDialog";

// The detail, editor and review panel: only fetched once a prompt is opened or created.
const PromptDrawer = dynamic(() => import("./PromptDrawer").then((m) => m.PromptDrawer));

export type LibraryTab = "company" | "mine" | "team" | "review";
export type Manage = "workspace" | "department" | null;

export interface LibraryPrompt {
  id: string;
  level: "company" | "personal";
  visibility: "private" | "department" | "everyone";
  status: "live" | "proposed" | "declined";
  audience: string[];
  authorId: string;
  title: string;
  body: string;
  description: string;
  topic: string;
  uses: number;
  pinned: boolean;
  reviewNote: string | null;
  createdAt: string;
  updatedAt: string;
  proposal: { status: "live" | "proposed" | "declined"; note: string | null } | null;
  canEdit: boolean;
  canDelete: boolean;
  canReview: boolean;
  /** The author's own wording is shown; colleagues read a copy with sensitive parts replaced. */
  redacted?: boolean;
}

export interface LibraryList {
  tab: string;
  manage: Manage;
  departmentId: string | null;
  prompts: LibraryPrompt[];
  counts: Record<LibraryTab, number>;
  total: number;
}

export type Department = { id: string; name: string };

/** What the drawer opens on: a prompt (to read, edit, propose or review) or a new one at a level. */
export type DrawerState = { mode: "view" | "edit" | "propose" | "review"; prompt: LibraryPrompt } | { mode: "new"; level: "company" | "personal" };

/** Opens Hỏi đáp with the prompt in the composer (the page's ?q=). */
export const askHref = (body: string) => `/app/ai/ask?q=${encodeURIComponent(body)}`;

const VIS_ICON = { private: LockIcon, department: UsersIcon, everyone: GlobeIcon } as const;

/**
 * Thư viện prompt (AI › Áp dụng AI): one surface with the four tabs (the company's, mine, shared by colleagues, and
 * proposals to review for those who manage it), a search and a topic filter, and one row per prompt. A row opens the
 * drawer. "Dùng với AI" takes the prompt to Hỏi đáp when the company assistant is on, otherwise copies it. Both count a use.
 */
export function PromptLibrary({
  initial,
  initialTab,
  topics,
  departments,
  assistant,
}: {
  initial: LibraryList | null;
  initialTab: LibraryTab;
  topics: TopicRow[];
  departments: Department[];
  assistant: boolean;
}) {
  const t = useT();
  const { ago, locale } = useFormat();
  const dir = useDirectory();
  const labels = topicLabels(topics, locale);
  const [tab, setTab] = useState<LibraryTab>(initialTab);
  const [data, setData] = useState<LibraryList | null>(initial);
  const [failed, setFailed] = useState(!initial);
  const [q, setQ] = useState("");
  const [topic, setTopic] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<DrawerState | null>(null);
  const first = useRef(true);

  const load = useCallback(async () => {
    const qs = new URLSearchParams({ tab });
    if (q.trim()) qs.set("q", q.trim());
    if (topic) qs.set("topic", topic);
    try {
      return await api<LibraryList>(`ai/insights/library?${qs}`);
    } catch {
      return null;
    }
  }, [tab, q, topic]);
  const reload = useCallback(async () => {
    const r = await load();
    setFailed(!r);
    if (r) setData(r);
  }, [load]);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    // Only the latest filter's answer lands: a slow earlier search must not overwrite it.
    let live = true;
    const id = setTimeout(() => {
      void load().then((r) => {
        if (!live) return;
        setFailed(!r);
        if (r) setData(r);
      });
    }, 200);
    return () => {
      live = false;
      clearTimeout(id);
    };
  }, [load]);

  // Colleagues share while this page sits in a tab: coming back to it refreshes the list and the tab counts.
  useEffect(() => {
    const onShow = () => {
      if (document.visibilityState === "visible") void reload();
    };
    document.addEventListener("visibilitychange", onShow);
    return () => document.removeEventListener("visibilitychange", onShow);
  }, [reload]);

  const pickTab = (v: LibraryTab) => {
    setTab(v);
    // The tab is in the address so a reload or a shared link lands on it, without a server round trip now.
    const url = new URL(window.location.href);
    url.searchParams.set("tab", v);
    window.history.replaceState(null, "", url);
  };

  const counted = async (p: LibraryPrompt) => {
    const r = await api<{ uses: number }>(`ai/insights/library/${p.id}/use`, { method: "POST" }).catch(() => null);
    if (r) setData((d) => (d ? { ...d, prompts: d.prompts.map((x) => (x.id === p.id ? { ...x, uses: r.uses } : x)) } : d));
  };
  const copy = async (p: LibraryPrompt) => {
    await navigator.clipboard.writeText(p.body).catch(() => undefined);
    setCopied(p.id);
    setTimeout(() => setCopied((c) => (c === p.id ? null : c)), 1500);
    void counted(p);
  };
  const remove = async (p: LibraryPrompt) => {
    if (!window.confirm(t("aiInsights.library.deleteConfirm"))) return;
    await api(`ai/insights/library/${p.id}`, { method: "DELETE" }).catch(() => undefined);
    void reload();
  };

  const manage = data?.manage ?? null;
  const counts = data?.counts;
  const tabs: LibraryTab[] = manage || counts?.review ? ["company", "mine", "team", "review"] : ["company", "mine", "team"];
  const canNew = tab !== "review" && (tab !== "company" || !!manage);
  const newLevel = tab === "company" ? "company" : "personal";
  const filtered = !!(q.trim() || topic);
  const prompts = data?.prompts ?? [];
  const deptName = (id: string) => departments.find((d) => d.id === id)?.name ?? id;
  const emptyTitle = filtered
    ? t("aiInsights.library.emptySearch")
    : tab === "company"
      ? t(manage ? "aiInsights.library.emptyCompanyManage" : "aiInsights.library.emptyCompany")
      : tab === "mine"
        ? t("aiInsights.library.emptyMine")
        : tab === "team"
          ? t("aiInsights.library.emptyTeam")
          : t("aiInsights.library.emptyReview");

  return (
    <div className="grid gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <div className="no-scrollbar min-w-0 max-w-full overflow-x-auto max-sm:w-full">
          <Segmented
            label={t("aiInsights.library.title")}
            value={tab}
            onChange={pickTab}
            phoneGrid={2}
            options={tabs.map((k) => ({ value: k, label: t(`aiInsights.library.tabs.${k}`), count: counts?.[k] || undefined }))}
          />
        </div>
        <span className="flex-1" />
        {canNew ? (
          <button type="button" className={cx(btnPrimary, btnSm)} onClick={() => setDrawer({ mode: "new", level: newLevel })} data-testid="prompt-new">
            <PlusIcon />
            {t(newLevel === "company" ? "aiInsights.library.newCompany" : "aiInsights.library.newPrompt")}
          </button>
        ) : null}
      </div>

      <section className="border-hairline bg-surface overflow-hidden rounded-lg border">
        <div className="border-hairline flex min-h-11 flex-wrap items-center gap-2 border-b px-3 py-1.5">
          <label className="text-ink-2 flex min-w-0 flex-1 items-center gap-2">
            <SearchIcon className="size-4 shrink-0" />
            <input
              type="search"
              className="text-ink placeholder:text-ink-2 h-8 min-w-0 flex-1 bg-transparent text-sm outline-none"
              placeholder={t("aiInsights.library.search")}
              aria-label={t("aiInsights.library.search")}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </label>
          <Picker
            variant="button"
            label={t("aiInsights.share.topic")}
            value={topic}
            onChange={setTopic}
            align="right"
            options={[
              { value: "", label: t("aiInsights.library.allTopics") },
              ...topics.filter((x) => !x.archived).map((x) => ({ value: x.key, label: topicLabel(t, x.key, labels), icon: <TopicIcon topic={x.key} className="size-3.5" /> })),
            ]}
          />
          {tab !== "company" || !manage ? null : <span className="text-ink-2 text-xs max-md:hidden">{t(`aiInsights.library.manage.${manage}`)}</span>}
        </div>

        {failed ? (
          <div className="px-4 py-6">
            <LoadFailed what={t("aiInsights.library.loadFailed")} onRetry={() => void reload()} />
          </div>
        ) : prompts.length === 0 ? (
          <EmptyState
            compact
            title={emptyTitle}
            action={
              canNew && !filtered ? (
                <button type="button" className={cx(btn, btnSm)} onClick={() => setDrawer({ mode: "new", level: newLevel })}>
                  <PlusIcon />
                  {t(newLevel === "company" ? "aiInsights.library.newCompany" : "aiInsights.library.newPrompt")}
                </button>
              ) : undefined
            }
          />
        ) : (
          <ul className="divide-hairline m-0 list-none divide-y p-0" data-testid="prompt-library">
            {prompts.map((p) => {
              const Vis = VIS_ICON[p.visibility];
              const items: MenuItem[] = [
                ...(p.canEdit ? [{ label: t("aiInsights.library.edit"), onSelect: () => setDrawer({ mode: "edit", prompt: p }) }] : []),
                ...(p.level === "personal" && p.canEdit && p.proposal?.status !== "proposed"
                  ? [{ label: t("aiInsights.library.propose"), onSelect: () => setDrawer({ mode: "propose", prompt: p }) }]
                  : []),
                { label: t("aiInsights.library.copy"), onSelect: () => void copy(p) },
                ...(p.canDelete ? [{ label: t("aiInsights.library.delete"), danger: true, onSelect: () => void remove(p) }] : []),
              ];
              return (
                <li key={p.id} className="hover:bg-hover/60 group relative flex min-h-14 items-center gap-3 px-3 py-2.5 transition-colors">
                  <span aria-hidden="true" className="bg-ground text-ink-2 grid size-8 shrink-0 place-items-center rounded-md [&_svg]:size-4">
                    <TopicIcon topic={p.topic} />
                  </span>
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left after:absolute after:inset-0"
                    onClick={() => setDrawer({ mode: tab === "review" && p.canReview ? "review" : "view", prompt: p })}
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="text-ink line-clamp-2 text-sm font-medium">{p.title}</span>
                      {p.pinned ? <PinIcon className="text-ink-2 size-3.5 shrink-0" aria-label={t("aiInsights.library.pinnedBadge")} /> : null}
                      {p.level === "personal" ? <Vis className="text-ink-2 size-3.5 shrink-0" aria-label={t(`aiInsights.library.vis.${p.visibility}`)} /> : null}
                    </span>
                    <span className="text-ink-2 mt-0.5 block truncate text-xs">{p.description || p.body.replace(/\s+/g, " ")}</span>
                  </button>
                  <span className="relative z-[1] flex shrink-0 items-center gap-2">
                    {p.level === "company" && p.audience.length ? <span className={cx(chip, "max-w-40 truncate max-lg:hidden")}>{p.audience.map(deptName).join(", ")}</span> : null}
                    {p.status !== "live" ? (
                      <span className={cx(p.status === "proposed" ? chipWarn : chip, tab === "review" && "max-sm:hidden")}>{t(`aiInsights.library.status.${p.status}`)}</span>
                    ) : null}
                    {p.proposal ? (
                      <span className={cx(p.proposal.status === "live" ? chip : chipWarn, "max-md:hidden")}>{t(`aiInsights.library.proposal.${p.proposal.status}`)}</span>
                    ) : null}
                    {tab !== "mine" ? (
                      <span className="text-ink-2 flex items-center gap-1.5 text-xs max-md:hidden" title={dir.name(p.authorId)}>
                        <Avatar id={p.authorId} size="xs" />
                        <span className="max-w-28 truncate max-lg:hidden">{dir.name(p.authorId)}</span>
                      </span>
                    ) : null}
                    <span className="text-ink-2 w-16 text-right text-xs tabular-nums max-md:hidden" suppressHydrationWarning>
                      {p.uses ? t("aiInsights.library.uses", { count: p.uses }) : ago(p.updatedAt)}
                    </span>
                    {tab === "review" && p.canReview ? (
                      <button type="button" className={cx(btn, btnSm)} onClick={() => setDrawer({ mode: "review", prompt: p })}>
                        {t("aiInsights.library.approve")}
                      </button>
                    ) : p.status === "live" ? (
                      assistant ? (
                        <a
                          href={askHref(p.body)}
                          onClick={() => void counted(p)}
                          className={cx(btn, btnSm, "no-underline max-sm:hidden md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100")}
                          title={t("aiInsights.library.useHint")}
                        >
                          <SparkleIcon />
                          {t("aiInsights.library.use")}
                        </a>
                      ) : (
                        <button type="button" className={cx(iconBtn, "max-sm:hidden")} onClick={() => void copy(p)} aria-label={t("aiInsights.library.copy")}>
                          {copied === p.id ? <CheckIcon /> : <CopyIcon />}
                        </button>
                      )
                    ) : null}
                    <Menu
                      label={t("aiInsights.library.actions")}
                      items={items}
                      trigger={
                        <span className={iconBtn}>
                          <MoreIcon />
                        </span>
                      }
                    />
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {drawer ? (
        <PromptDrawer
          state={drawer}
          topics={topics}
          departments={departments}
          manage={manage}
          departmentId={data?.departmentId ?? null}
          assistant={assistant}
          onUse={(p) => void counted(p)}
          onMode={setDrawer}
          onClose={() => setDrawer(null)}
          onSaved={() => {
            setDrawer(null);
            void reload();
          }}
        />
      ) : null}
    </div>
  );
}
