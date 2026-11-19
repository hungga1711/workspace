"use client";

import { PersonChip } from "@/components/chat/PersonTrigger";
import { useEffect, useState } from "react";
import { CalmEmpty, SectionHead, adminCard, adminList } from "./AdminBits";
import { CheckIcon, ChevronDownIcon, CopyIcon, ListIcon, SearchIcon } from "@/components/app/icons";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { api } from "@/lib/client";
import { INTL_TAG } from "@/lib/i18n/config";
import { useFormat, useLocale, useT } from "@/lib/i18n/client";
import { Avatar, useDirectory } from "@/lib/people";
import { btn, btnPrimary, btnSm, chip, chipBlock, countPill, cx, input, mono, skeleton } from "@/lib/ui";
import { dateTimeMedium, dayMonthOptions } from "@/lib/format";

export interface ErrorFrame {
  file: string;
  line: number | null;
  col: number | null;
  name: string | null;
  raw?: string;
}
export interface ErrorOccurrence {
  id: string;
  code: string;
  kind: "boundary" | "uncaught";
  message: string;
  groupKey: string;
  stack: string | null;
  frames: ErrorFrame[];
  route: string | null;
  path: string | null;
  userId: string | null;
  browser: string | null;
  at: string;
}
export interface ErrorGroup {
  groupKey: string;
  message: string;
  kind: "boundary" | "uncaught";
  lastCode: string;
  count: number;
  users: number;
  firstAt: string;
  lastAt: string;
  routes: string[];
  /** Browser noise (resize loops, cancelled requests): folded away so real errors stay on top. */
  benign?: boolean;
  /** open | resolved (an admin marked it handled and nothing came since) | reopened (it came back after that). */
  status?: "open" | "resolved" | "reopened";
}

type View = "open" | "resolved" | "benign";
const viewOf = (g: ErrorGroup): View => (g.benign ? "benign" : g.status === "resolved" ? "resolved" : "open");

/**
 * Admin › Lỗi trình duyệt: the code on someone's error screen pasted in the search opens that occurrence with the
 * stack resolved to source files; below, the same errors grouped by message, newest first, each opening into its
 * occurrences (who, when, which page, which browser). Every read fails on its own.
 */
export function BrowserErrors({ groups, days, found, failed }: { groups: ErrorGroup[] | null; days: number; found?: ErrorOccurrence | null; failed?: boolean }) {
  const tx = useT();
  const [q, setQ] = useState(found?.code ?? "");
  const [hit, setHit] = useState<ErrorOccurrence | null | undefined>(found);
  const [missing, setMissing] = useState(false);
  const [lookupFailed, setLookupFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [list, setList] = useState(groups);
  const [view, setView] = useState<View>("open");
  const counts: Record<View, number> = { open: 0, resolved: 0, benign: 0 };
  for (const g of list ?? []) counts[viewOf(g)]++;
  const shownGroups = (list ?? []).filter((g) => viewOf(g) === view);
  const setStatus = async (g: ErrorGroup, resolved: boolean) => {
    const prev = list;
    setList((l) => l?.map((x) => (x.groupKey === g.groupKey ? { ...x, status: resolved ? "resolved" : "open" } : x)) ?? l);
    try {
      await api(`platform/client-errors/groups/${g.groupKey}/resolve`, { method: resolved ? "POST" : "DELETE" });
    } catch {
      setList(prev);
    }
  };

  const find = async (code: string) => {
    const c = code.trim().toUpperCase();
    if (!c) return;
    setBusy(true);
    setMissing(false);
    setLookupFailed(false);
    try {
      const r = await api<{ occurrence: ErrorOccurrence }>(`platform/client-errors?code=${encodeURIComponent(c)}`);
      setHit(r.occurrence);
      // The address keeps the code, so the admin can send the page to whoever fixes it.
      window.history.replaceState(null, "", `?code=${encodeURIComponent(c)}`);
    } catch (e) {
      setHit(null);
      if ((e as { status?: number }).status === 404) setMissing(true);
      else setLookupFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <form
        className={cx(adminCard, "mb-6 flex flex-wrap items-center gap-2 px-4 py-3")}
        onSubmit={(e) => {
          e.preventDefault();
          void find(q);
        }}
      >
        <label className="relative min-w-0 flex-1 basis-56">
          <SearchIcon className="text-ink-2 pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={tx("admin.errors.search")}
            aria-label={tx("admin.errors.search")}
            autoCapitalize="characters"
            spellCheck={false}
            className={cx(input, mono, "pl-8 uppercase placeholder:font-sans placeholder:normal-case")}
          />
        </label>
        <button type="submit" className={btnPrimary} disabled={busy || !q.trim()}>
          {tx("admin.errors.find")}
        </button>
        <span className="text-ink-2 basis-full text-xs">{tx("admin.errors.days", { count: days })}</span>
      </form>

      {hit ? (
        <section className="mb-8">
          <SectionHead icon={<SearchIcon />} tone="sky" title={tx("admin.errors.found")} />
          <OccurrenceCard o={hit} onGroup={() => setOpen(hit.groupKey)} />
        </section>
      ) : null}
      {missing ? (
        <p role="status" className="text-ink-2 mb-6 text-sm">
          {tx("admin.errors.notFound", { count: days })}
        </p>
      ) : null}
      {lookupFailed ? <LoadFailed what={tx("admin.errors.searchFailed")} className="mb-6" onRetry={() => void find(q)} /> : null}

      <SectionHead id="error-groups" icon={<ListIcon />} tone="tangerine" title={tx("admin.errors.groups")} />
      {failed || !groups ? (
        <LoadFailed className={cx(adminCard, "min-h-14 px-5 py-3.5")} />
      ) : groups.length === 0 ? (
        <CalmEmpty clear title={tx("admin.errors.empty", { count: days })} hint={tx("admin.errors.emptyHint")} />
      ) : (
        <>
          <div role="tablist" aria-label={tx("admin.errors.groups")} className="mb-3 flex flex-wrap gap-1.5">
            {(["open", "resolved", "benign"] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={view === v}
                onClick={() => setView(v)}
                className={cx(btn, btnSm, view === v && "bg-selected text-ink shadow-[0_0_0_1px_var(--ink-2)]")}
              >
                {tx(`admin.errors.view_${v}`)}
                <span className={cx(countPill, "ml-1")}>{counts[v]}</span>
              </button>
            ))}
          </div>
          {shownGroups.length === 0 ? (
            <CalmEmpty clear title={tx(`admin.errors.none_${view}`)} />
          ) : (
            <ul className={adminList} aria-labelledby="error-groups">
              {shownGroups.map((g) => (
                <GroupRow
                  key={g.groupKey}
                  g={g}
                  open={open === g.groupKey}
                  onToggle={() => setOpen(open === g.groupKey ? null : g.groupKey)}
                  onResolve={(r) => void setStatus(g, r)}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </>
  );
}

function KindChip({ kind }: { kind: ErrorOccurrence["kind"] }) {
  const tx = useT();
  return <span className={kind === "boundary" ? chipBlock : chip}>{kind === "boundary" ? tx("admin.errors.kind_boundary") : tx("admin.errors.kind_uncaught")}</span>;
}

function GroupRow({ g, open, onToggle, onResolve }: { g: ErrorGroup; open: boolean; onToggle: () => void; onResolve: (resolved: boolean) => void }) {
  const tx = useT();
  const fmt = useFormat();
  const shown = g.routes.slice(0, 3);
  return (
    <li>
      <button type="button" onClick={onToggle} aria-expanded={open} className="hover:bg-hover flex w-full min-w-0 items-start gap-3 px-4 py-3 text-left max-sm:px-3">
        <span className="min-w-0 flex-1">
          <span className="text-ink block text-sm/5 font-medium [overflow-wrap:anywhere]">{g.message}</span>
          <span className="text-ink-2 mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <KindChip kind={g.kind} />
            {g.status === "reopened" ? <span className={chipBlock}>{tx("admin.errors.reopened")}</span> : null}
            <span>{tx("admin.errors.users", { count: g.users })}</span>
            <span aria-hidden="true">·</span>
            <span>{tx("admin.errors.last", { ago: fmt.ago(g.lastAt) })}</span>
            {shown.map((r) => (
              <span key={r} className={cx(mono, "bg-selected text-ink-soft rounded-sm px-1.5 py-0.5 text-xs")}>
                {r}
              </span>
            ))}
            {g.routes.length > shown.length ? <span>{tx("admin.errors.more", { count: g.routes.length - shown.length })}</span> : null}
          </span>
        </span>
        <span className={cx(countPill, "shrink-0", g.count >= 10 && "bg-block-wash text-block")}>{g.count}</span>
        <ChevronDownIcon className={cx("text-ink-2 mt-0.5 size-4 shrink-0 transition-transform", open && "rotate-180")} />
      </button>
      {open ? (
        <>
          {g.benign ? null : (
            <div className="flex justify-end px-4 pt-1 max-sm:px-3">
              <button type="button" className={cx(btn, btnSm)} onClick={() => onResolve(g.status !== "resolved")}>
                {g.status === "resolved" ? tx("admin.errors.reopen") : tx("admin.errors.resolve")}
              </button>
            </div>
          )}
          <Occurrences groupKey={g.groupKey} />
        </>
      ) : null}
    </li>
  );
}

function Occurrences({ groupKey }: { groupKey: string }) {
  const tx = useT();
  const [rows, setRows] = useState<ErrorOccurrence[] | null | undefined>();
  const [picked, setPicked] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setRows(undefined);
    api<{ occurrences: ErrorOccurrence[] }>(`platform/client-errors?group=${groupKey}`).then(
      (r) => {
        if (!live) return;
        setRows(r.occurrences);
        setPicked(r.occurrences[0]?.id ?? null);
      },
      () => live && setRows(null),
    );
    return () => {
      live = false;
    };
  }, [groupKey, tick]);
  if (rows === undefined)
    return (
      <div className="border-divider-soft border-t px-4 py-3" aria-busy="true">
        <span className={skeleton} />
      </div>
    );
  if (rows === null) return <LoadFailed what={tx("admin.errors.occurrencesFailed")} className="border-divider-soft border-t px-4 py-3" onRetry={() => setTick((t) => t + 1)} />;
  const sel = rows.find((r) => r.id === picked) ?? null;
  return (
    <div className="border-divider-soft bg-ground border-t px-4 py-3 max-sm:px-3">
      <OccurrenceTable rows={rows} picked={picked} onPick={setPicked} />
      {sel ? <Frames o={sel} className="mt-3" /> : <p className="text-ink-2 m-0 mt-2 text-xs">{tx("admin.errors.pick")}</p>}
    </div>
  );
}

function OccurrenceTable({ rows, picked, onPick }: { rows: ErrorOccurrence[]; picked: string | null; onPick: (id: string) => void }) {
  const tx = useT();
  const dir = useDirectory();
  const intlTag = INTL_TAG[useLocale()];
  const when = (iso: string) => new Date(iso).toLocaleString(intlTag, { ...dayMonthOptions(intlTag), hour: "2-digit", minute: "2-digit" });
  return (
    <ul className="divide-divider-soft bg-surface shadow-card m-0 list-none divide-y overflow-hidden rounded-lg p-0" aria-label={tx("admin.errors.occurrences")}>
      <li className="text-ink-2 hidden grid-cols-[7.5rem_7rem_minmax(8rem,1fr)_minmax(8rem,1.2fr)_5rem] gap-3 px-3 py-1.5 text-xs font-medium uppercase tracking-wide sm:grid">
        <span>{tx("admin.errors.code")}</span>
        <span>{tx("admin.errors.time")}</span>
        <span>{tx("admin.errors.person")}</span>
        <span>{tx("admin.errors.where")}</span>
        <span>{tx("admin.errors.browser")}</span>
      </li>
      {rows.map((o) => (
        <li key={o.id}>
          <button
            type="button"
            onClick={() => onPick(o.id)}
            aria-pressed={picked === o.id}
            className={cx(
              "hover:bg-hover grid w-full min-w-0 items-center gap-x-3 gap-y-1 px-3 py-2 text-left text-sm max-sm:grid-cols-2 sm:grid-cols-[7.5rem_7rem_minmax(8rem,1fr)_minmax(8rem,1.2fr)_5rem]",
              picked === o.id && "bg-selected",
            )}
          >
            <span className={cx(mono, "text-ink text-[13px] font-medium")}>{o.code}</span>
            <span className="text-ink-2 text-xs tabular-nums max-sm:text-right">{when(o.at)}</span>
            <span className="flex min-w-0 items-center gap-1.5">
              {o.userId ? (
                <>
                  <Avatar id={o.userId} size="xs" />
                  <span className="truncate">{dir.name(o.userId)}</span>
                </>
              ) : (
                <span className="text-ink-2">{tx("admin.errors.anonymous")}</span>
              )}
            </span>
            <span className={cx(mono, "text-ink-2 truncate text-xs")} title={o.path ?? o.route ?? ""}>
              {o.path ?? o.route ?? "—"}
            </span>
            <span className="text-ink-2 text-xs max-sm:col-span-2">{o.browser ?? "—"}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function OccurrenceCard({ o, onGroup }: { o: ErrorOccurrence; onGroup: () => void }) {
  const tx = useT();
  const fmt = useFormat();
  const intlTag = INTL_TAG[useLocale()];
  return (
    <div className={cx(adminCard, "px-4 py-3.5")}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className={cx(mono, "text-ink text-base font-semibold")}>{o.code}</span>
        <CopyButton text={o.code} />
        <KindChip kind={o.kind} />
        <span className="text-ink-2 text-xs" title={new Date(o.at).toLocaleString(intlTag, dateTimeMedium)}>
          {fmt.ago(o.at)}
        </span>
      </div>
      <p className="text-ink m-0 mt-2 text-sm/5 font-medium [overflow-wrap:anywhere]">{o.message}</p>
      <dl className="text-ink-2 m-0 mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="m-0">{tx("admin.errors.person")}</dt>
        <dd className="m-0 flex items-center gap-1.5">{o.userId ? <PersonChip userId={o.userId} dense className="text-ink" /> : tx("admin.errors.anonymous")}</dd>
        <dt className="m-0">{tx("admin.errors.where")}</dt>
        <dd className={cx(mono, "m-0 [overflow-wrap:anywhere]")}>{o.path ?? o.route ?? "—"}</dd>
        <dt className="m-0">{tx("admin.errors.browser")}</dt>
        <dd className="m-0">{o.browser ?? "—"}</dd>
      </dl>
      <Frames o={o} className="mt-3" />
      <a href="#error-groups" onClick={onGroup} className="text-accent-text mt-3 inline-block text-xs font-medium no-underline hover:underline">
        {tx("admin.errors.sameGroup")} →
      </a>
    </div>
  );
}

/** The resolved frames (file:line, the function) with the raw stack behind a toggle; vendor frames stay quiet. */
function Frames({ o, className }: { o: ErrorOccurrence; className?: string }) {
  const tx = useT();
  const [raw, setRaw] = useState(false);
  const resolved = o.frames.filter((f) => !f.raw);
  const hasStack = !!o.stack;
  return (
    <div className={className}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-ink m-0 text-xs font-semibold">{tx("admin.errors.frames")}</h4>
        {hasStack ? (
          <button type="button" onClick={() => setRaw((v) => !v)} className={cx(btn, btnSm)} aria-pressed={raw}>
            {raw ? tx("admin.errors.readable") : tx("admin.errors.raw")}
          </button>
        ) : null}
      </div>
      {!hasStack ? (
        <p className="text-ink-2 m-0 mt-1 text-xs">{tx("admin.errors.none")}</p>
      ) : raw || !resolved.length ? (
        <>
          {!resolved.length && !raw ? <p className="text-ink-2 m-0 mt-1 text-xs">{tx("admin.errors.noFrames")}</p> : null}
          <pre className={cx(mono, "bg-ground text-ink-soft m-0 mt-1.5 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg p-3 text-xs/[1.5] [overflow-wrap:anywhere]")}>
            {o.stack}
          </pre>
        </>
      ) : (
        <>
          <p className="text-ink-2 m-0 mt-0.5 text-xs">{tx("admin.errors.framesHint")}</p>
          <ol className="bg-ground m-0 mt-1.5 list-none rounded-lg p-2">
            {o.frames.map((f, i) => {
              const vendor = f.file.startsWith("node_modules/");
              return (
                <li key={i} className={cx("flex min-w-0 flex-wrap items-baseline gap-x-2 px-1 py-0.5 text-xs", vendor ? "text-ink-2" : "text-ink")}>
                  <span className={cx(mono, "text-ink-2 w-4 shrink-0 text-right")}>{i + 1}</span>
                  {f.raw ? (
                    <span className={cx(mono, "text-ink-2 [overflow-wrap:anywhere]")}>{f.raw}</span>
                  ) : (
                    <>
                      <span className={cx(mono, "[overflow-wrap:anywhere]", !vendor && "font-medium")}>
                        {f.file}
                        {f.line !== null ? `:${f.line}` : ""}
                        {f.col !== null ? `:${f.col}` : ""}
                      </span>
                      {f.name ? <span className="text-ink-2">in {f.name}</span> : null}
                    </>
                  )}
                </li>
              );
            })}
          </ol>
        </>
      )}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const tx = useT();
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={cx(btn, btnSm, done && "text-ok")}
      onClick={() =>
        navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        })
      }
    >
      {done ? <CheckIcon /> : <CopyIcon />}
      {done ? tx("admin.errors.copied") : tx("admin.errors.copy")}
    </button>
  );
}
