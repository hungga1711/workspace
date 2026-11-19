"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { SectionHead } from "./AdminBits";
import { AuditRows, type ActorNames } from "./AuditRows";
import { Picker } from "@/components/ui/Picker";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { Figure, Tile } from "@/components/ui/Bento";
import { CloseIcon, DownloadIcon, ListIcon, SearchIcon, ShieldIcon, UsersIcon } from "@/components/app/icons";
import { api } from "@/lib/client";
import type { MessageKey } from "@/lib/i18n/core";
import { useLocale, useT } from "@/lib/i18n/client";
import { INTL_TAG } from "@/lib/i18n/config";
import { useDirectory } from "@/lib/people";
import { btn, btnPrimary, btnSm, cx, input, progressFill, progressTrack } from "@/lib/ui";
import {
  TRAIL_GROUPS,
  TRAIL_MODULES,
  TRAIL_OUTCOMES,
  TRAIL_PAGE,
  TRAIL_RANGES,
  actionLabel,
  filterHref,
  filterParams,
  groupLabel,
  moduleLabel,
  targetTypeLabel,
  trailQuery,
  type TrailEntry,
  type TrailFilter,
  type TrailPage,
  type TrailStats,
} from "./audit";

/**
 * Admin › Nhật ký as a trace tool: totals for the period, filters held in the URL (so a trace link can be shared),
 * the timeline, page after page, and the CSV of exactly what the filter shows. Stats and list fail on their own.
 */
export function AuditView({ filter, page, stats, names }: { filter: TrailFilter; page: TrailPage | null; stats: TrailStats | null; names: ActorNames }) {
  const tx = useT();
  const intlTag = INTL_TAG[useLocale()];
  const router = useRouter();
  const [entries, setEntries] = useState<TrailEntry[]>(page?.entries ?? []);
  const [next, setNext] = useState(page?.next ?? null);
  const [busy, setBusy] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  const go = (patch: Partial<TrailFilter>) => router.push(filterHref(filter, patch));
  const n = (v: number) => v.toLocaleString(intlTag);

  const more = async () => {
    if (!next) return;
    setBusy(true);
    setMoreFailed(false);
    try {
      const q = trailQuery(filter);
      q.set("limit", String(TRAIL_PAGE));
      q.set("cursor", next);
      const r = await api<TrailPage>(`platform/audit?${q}`);
      setEntries((cur) => [...cur, ...r.entries.filter((e) => !cur.some((x) => x.id === e.id))]);
      setNext(r.next);
    } catch {
      setMoreFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const maxModule = Math.max(1, ...(stats?.modules ?? []).map((m) => m.n));
  const exportQ = filterParams(filter);
  const exportHref = `/admin/workspace/audit/export${exportQ.size ? `?${exportQ}` : ""}`;

  return (
    <>
      {stats ? (
        // Three figures in a row from 640px and "By area" under them until 1280px: four across left each title cut short.
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
          <Tile id="trail-total" title={tx("admin.trail.entries")} icon={<ListIcon />} tone="sky">
            <Figure n={n(stats.total)} />
          </Tile>
          <Tile id="trail-people" title={tx("admin.trail.people")} icon={<UsersIcon />} tone="violet">
            <Figure n={n(stats.actors)} />
          </Tile>
          <Tile id="trail-fail" title={tx("admin.trail.failures")} icon={<ShieldIcon />} tone={stats.failures ? "red" : "green"} className="max-sm:col-span-2">
            <Figure n={n(stats.failures)} tone={stats.failures ? "alert" : "muted"}>
              {stats.failures && !filter.outcome ? (
                <Link href={filterHref(filter, { outcome: "failure" })} className="text-accent-text text-xs font-medium no-underline hover:underline">
                  {tx("admin.trail.show")}
                </Link>
              ) : null}
            </Figure>
          </Tile>
          <Tile id="trail-modules" title={tx("admin.trail.byModule")} icon={<ListIcon />} tone="tangerine" className="max-xl:col-span-full">
            <ul className="m-0 mt-3 flex list-none flex-col gap-1.5 p-0">
              {stats.modules.slice(0, 4).map((m) => (
                <li key={m.module}>
                  <Link
                    href={filterHref(filter, { module: m.module })}
                    className="hover:bg-hover -mx-1.5 flex min-w-0 items-center gap-2 rounded-md px-1.5 py-0.5 text-xs no-underline"
                  >
                    <span className="text-ink w-32 shrink-0 truncate">{moduleLabel(tx, m.module)}</span>
                    <span className={cx(progressTrack, "flex-1")}>
                      <span className={progressFill} style={{ width: `${(m.n / maxModule) * 100}%` }} />
                    </span>
                    <span className="text-ink-2 w-10 shrink-0 text-right tabular-nums">{n(m.n)}</span>
                  </Link>
                </li>
              ))}
              {stats.modules.length ? null : <li className="text-ink-2 text-xs">—</li>}
            </ul>
          </Tile>
        </div>
      ) : (
        <LoadFailed what={tx("admin.trail.summary")} className="bg-surface shadow-card mb-6 min-h-14 rounded-xl px-5 py-3.5" />
      )}

      <Filters filter={filter} go={go} />

      <SectionHead
        icon={<ListIcon />}
        tone="green"
        title={tx("admin.trail.timeline")}
        sub={tx("admin.trail.privacy")}
        actions={
          <a className={cx(btn, btnSm)} href={exportHref} download>
            <DownloadIcon />
            {tx("admin.trail.export")}
          </a>
        }
      />
      {page ? (
        <>
          <AuditRows entries={entries} names={names} filter={filter} />
          {next || moreFailed ? (
            <div className="mt-4 flex flex-col items-center gap-2">
              {moreFailed ? <LoadFailed onRetry={() => void more()} /> : null}
              {next ? (
                <button type="button" className={btn} disabled={busy} onClick={() => void more()}>
                  {busy ? tx("admin.trail.loading") : tx("admin.trail.loadMore")}
                </button>
              ) : null}
            </div>
          ) : null}
        </>
      ) : (
        <LoadFailed what={tx("admin.trail.timeline")} className="bg-surface shadow-card min-h-14 rounded-xl px-5 py-3.5" />
      )}
    </>
  );
}

/** The filter bar: pickers for period, person, module, kind of action and outcome, a target search, and chips. */
function Filters({ filter, go }: { filter: TrailFilter; go: (patch: Partial<TrailFilter>) => void }) {
  const tx = useT();
  const dir = useDirectory();
  const [q, setQ] = useState(filter.q ?? "");
  const [from, setFrom] = useState(filter.from ?? "");
  const [to, setTo] = useState(filter.to ?? "");
  const people = [...dir.people].sort((a, b) => a.displayName.localeCompare(b.displayName));
  const actorValue = filter.actorType === "user" || !filter.actorType ? (filter.actor ?? "") : "";

  const chips: { key: string; label: string; clear: Partial<TrailFilter> }[] = [];
  if (filter.actor) {
    const name =
      filter.actorType === "user" || !filter.actorType ? dir.name(filter.actor) : `${tx(`admin.trail.actor_${filter.actorType}` as MessageKey)} ${filter.actor.slice(0, 8)}`;
    chips.push({ key: "actor", label: tx("admin.trail.chipActor", { name }), clear: { actor: undefined, actorType: undefined } });
  } else if (filter.actorType) chips.push({ key: "actorType", label: tx(`admin.trail.actor_${filter.actorType}` as MessageKey), clear: { actorType: undefined } });
  if (filter.targetId)
    chips.push({
      key: "target",
      label: tx("admin.trail.chipTarget", { name: `${targetTypeLabel(tx, filter.targetType ?? "")} ${filter.targetId}` }),
      clear: { targetType: undefined, targetId: undefined },
    });
  else if (filter.targetType) chips.push({ key: "targetType", label: targetTypeLabel(tx, filter.targetType), clear: { targetType: undefined } });
  if (filter.requestId) chips.push({ key: "request", label: tx("admin.trail.chipRequest", { id: filter.requestId.slice(0, 12) }), clear: { requestId: undefined } });
  if (filter.q) chips.push({ key: "q", label: tx("admin.trail.chipQ", { q: filter.q }), clear: { q: undefined } });
  if (filter.action && !filter.action.endsWith("."))
    chips.push({ key: "action", label: tx("admin.trail.chipAction", { name: actionLabel(tx, filter.action) }), clear: { action: undefined } });

  return (
    <div className="mb-5 flex flex-col gap-2.5">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Picker
          variant="button"
          label={tx("admin.trail.range")}
          value={filter.range}
          onChange={(v) => go({ range: v as TrailFilter["range"] })}
          options={TRAIL_RANGES.map((r) => ({ value: r, label: tx(`admin.trail.range_${r}` as MessageKey) }))}
        />
        <Picker
          variant="button"
          label={tx("admin.trail.actor")}
          value={actorValue}
          onChange={(v) => go(v ? { actor: v, actorType: "user" } : { actor: undefined, actorType: undefined })}
          options={[{ value: "", label: tx("admin.trail.anyone") }, ...people.map((p) => ({ value: p.userId, label: p.displayName, ...(p.email ? { keywords: p.email } : {}) }))]}
        />
        <Picker
          variant="button"
          label={tx("admin.trail.module")}
          value={filter.module ?? ""}
          onChange={(v) => go({ module: v || undefined, action: undefined })}
          options={[{ value: "", label: tx("admin.trail.allModules") }, ...TRAIL_MODULES.map((m) => ({ value: m, label: moduleLabel(tx, m) }))]}
        />
        <Picker
          variant="button"
          label={tx("admin.trail.action")}
          value={filter.action ?? ""}
          onChange={(v) => go({ action: v || undefined })}
          options={[
            { value: "", label: tx("admin.trail.allActions") },
            ...TRAIL_GROUPS.filter((g) => !filter.module || g.startsWith(`${filter.module}.`)).map((g) => ({
              value: g,
              label: groupLabel(tx, g),
              group: moduleLabel(tx, g.split(".")[0]!),
            })),
          ]}
        />
        <Picker
          variant="button"
          label={tx("admin.trail.outcome")}
          value={filter.outcome ?? ""}
          onChange={(v) => go({ outcome: v || undefined })}
          options={[{ value: "", label: tx("admin.trail.allOutcomes") }, ...TRAIL_OUTCOMES.map((o) => ({ value: o, label: tx(`admin.trail.outcome_${o}` as MessageKey) }))]}
        />
        <form
          role="search"
          className="flex min-w-[min(100%,16rem)] flex-1 items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            go({ q: q.trim() || undefined });
          }}
        >
          <label className="relative min-w-0 flex-1">
            <span className="sr-only">{tx("admin.trail.searchLabel")}</span>
            <SearchIcon className="text-ink-2 pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2" />
            <input className={cx(input, "pl-8")} value={q} maxLength={100} placeholder={tx("admin.trail.search")} onChange={(e) => setQ(e.target.value)} />
          </label>
        </form>
      </div>
      {filter.range === "custom" ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            go({ from: from || undefined, to: to || undefined });
          }}
        >
          <label className="text-ink-2 flex flex-col gap-1 text-xs">
            {tx("admin.trail.from")}
            <input type="date" className={cx(input, "w-auto")} value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="text-ink-2 flex flex-col gap-1 text-xs">
            {tx("admin.trail.to")}
            <input type="date" className={cx(input, "w-auto")} value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <button type="submit" className={btnPrimary}>
            {tx("admin.trail.apply")}
          </button>
        </form>
      ) : null}
      {chips.length ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {chips.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => go(c.clear)}
              aria-label={tx("admin.trail.removeFilter", { name: c.label })}
              className="bg-accent-wash text-accent-text hover:bg-accent-wash/70 inline-flex min-h-7 max-w-full items-center gap-1 rounded-full px-2.5 text-xs"
            >
              <span className="truncate">{c.label}</span>
              <CloseIcon className="size-3 shrink-0" />
            </button>
          ))}
          <Link href="/admin/workspace/audit" className="text-ink-2 hover:text-ink px-1 text-xs no-underline hover:underline">
            {tx("admin.trail.clear")}
          </Link>
        </div>
      ) : null}
    </div>
  );
}
