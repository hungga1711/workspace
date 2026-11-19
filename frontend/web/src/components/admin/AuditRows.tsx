"use client";

import Link from "next/link";
import { Fragment, useState } from "react";
import { CalmEmpty } from "./AdminBits";
import { roleLabel } from "./roleLabel";
import { ChevronDownIcon } from "@/components/app/icons";
import { INTL_TAG } from "@/lib/i18n/config";
import type { MessageKey, T } from "@/lib/i18n/core";
import { useFormat, useLocale, useT } from "@/lib/i18n/client";
import { dateTimeMedium, ipLabel } from "@/lib/format";
import { Avatar, useDirectory } from "@/lib/people";
import { chipBlock, chipWarn, cx, iconBtn, mono } from "@/lib/ui";
import {
  PERSON_FIELDS,
  TIME_FIELDS,
  actionLabel,
  changeList,
  filterHref,
  headlineChange,
  moduleLabel,
  targetTypeLabel,
  type Change,
  type TrailEntry,
  type TrailFilter,
} from "./audit";

/** Names of actors the member directory does not know: agents (`agent:<id>`) and API keys (`apikey:<id>`). */
export type ActorNames = Record<string, string>;

function useActor(names: ActorNames) {
  const tx = useT();
  const dir = useDirectory();
  return (e: TrailEntry): { avatarId: string; name: string } => {
    switch (e.actorType) {
      case "user":
        return { avatarId: e.actorId, name: dir.name(e.actorId) };
      case "agent":
        return { avatarId: `agent:${e.actorId}`, name: names[`agent:${e.actorId}`] ?? tx("admin.trail.actor_agent") };
      case "apikey":
        return { avatarId: "system", name: names[`apikey:${e.actorId}`] ? `${tx("admin.trail.actor_apikey")} ${names[`apikey:${e.actorId}`]}` : tx("admin.trail.actor_apikey") };
      case "anonymous":
        return { avatarId: "system", name: tx("admin.trail.actor_anonymous") };
      default:
        return { avatarId: "system", name: tx("admin.trail.actor_system") };
    }
  };
}

const fieldLabel = (tx: T, f: string) => {
  const key = `labels.auditField.${f}`;
  const s = tx(key as MessageKey);
  return s === key ? f : s;
};

/** A changed value as people read it: a status by its name, a person by name, a moment as a date. */
function useValue() {
  const tx = useT();
  const fmt = useFormat();
  const dir = useDirectory();
  const intlTag = INTL_TAG[useLocale()];
  return (field: string, v: unknown): string => {
    if (v === null || v === undefined || v === "") return "—";
    if (Array.isArray(v)) return v.length ? v.map((x) => (field === "roles" ? roleLabel(String(x), tx) : String(x))).join(", ") : "—";
    if (typeof v === "boolean") return v ? tx("admin.trail.on") : tx("admin.trail.off");
    if (field === "status") return fmt.status(String(v));
    if (field === "priority") return fmt.priority(String(v));
    if (PERSON_FIELDS.has(field)) return dir.name(String(v));
    if (TIME_FIELDS.has(field) && !Number.isNaN(Date.parse(String(v)))) return new Date(String(v)).toLocaleString(intlTag, dateTimeMedium);
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
  };
}

/** The target as a trace link (its history), named by its label, else by its type (a private channel stays nameless). */
function targetText(tx: T, e: TrailEntry): string {
  if (e.targetLabel) return e.targetLabel;
  if (e.targetType === "channel") return tx("admin.trail.privateChannel");
  return targetTypeLabel(tx, e.targetType);
}

const OUTCOME_CHIP: Record<string, string> = { failure: chipWarn, denied: chipBlock };

/**
 * The trail as a dense timeline: actor, one readable sentence, time; a row opens to its details (changes, IP,
 * browser, request id) with trace links. `filter` is the screen's filter, so a trace link keeps the period;
 * `compact` (the admin overview) drops the details and the day headings.
 */
export function AuditRows({ entries, names = {}, filter, compact = false }: { entries: TrailEntry[]; names?: ActorNames; filter: TrailFilter; compact?: boolean }) {
  const tx = useT();
  const fmt = useFormat();
  const intlTag = INTL_TAG[useLocale()];
  const actorOf = useActor(names);
  const value = useValue();
  const [open, setOpen] = useState<string | null>(null);
  if (!entries.length) return <CalmEmpty title={tx("admin.trail.empty")} />;
  let lastDay = "";
  return (
    <ul className="divide-divider-soft bg-surface shadow-card m-0 list-none divide-y overflow-hidden rounded-xl p-0">
      {entries.map((e) => {
        const a = actorOf(e);
        const day = fmt.dayLabel(e.at);
        const showDay = !compact && day !== lastDay;
        lastDay = day;
        const head = headlineChange(e);
        const expanded = open === e.id;
        const actorHref = e.actorType === "user" || e.actorType === "agent" || e.actorType === "apikey" ? filterHref(filter, { actor: e.actorId, actorType: e.actorType }) : null;
        const targetHref = filterHref(filter, { targetType: e.targetType, targetId: e.targetId, q: undefined });
        return (
          <Fragment key={e.id}>
            {showDay ? (
              <li aria-hidden="true" className="bg-ground text-ink-2 px-4 py-1.5 text-xs font-medium uppercase tracking-[0.06em] max-sm:px-3">
                {day}
              </li>
            ) : null}
            <li className="min-w-0">
              <div className="flex min-w-0 items-start gap-3 px-4 py-2.5 max-sm:px-3">
                <Avatar id={a.avatarId} name={a.name} size="xs" className="mt-0.5" />
                <div className="min-w-0 flex-1">
                  <p className="m-0 text-sm/5 [overflow-wrap:anywhere]">
                    {actorHref && !compact ? (
                      <Link href={actorHref} className="text-ink font-medium no-underline hover:underline" title={tx("admin.trail.traceActor", { name: a.name })}>
                        {a.name}
                      </Link>
                    ) : (
                      <span className="font-medium">{a.name}</span>
                    )}{" "}
                    <span className="text-ink-soft">{actionLabel(tx, e.action)}</span>{" "}
                    {compact ? (
                      <span className="text-ink">{targetText(tx, e)}</span>
                    ) : (
                      <Link href={targetHref} className="text-ink no-underline hover:underline" title={tx("admin.trail.traceTarget")}>
                        {targetText(tx, e)}
                      </Link>
                    )}
                    {head && head.kind === "set" ? <span className="text-ink-soft"> → {value(head.field, head.to)}</span> : null}
                  </p>
                  <p className="text-ink-2 m-0 mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                    <time dateTime={e.at} title={new Date(e.at).toLocaleString(intlTag, dateTimeMedium)}>
                      {compact ? fmt.ago(e.at) : fmt.time(e.at)}
                    </time>
                    <span aria-hidden="true">·</span>
                    <span>{moduleLabel(tx, e.module)}</span>
                    {e.via && e.via !== "session" ? (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>{tx(`admin.trail.via_${e.via}` as MessageKey)}</span>
                      </>
                    ) : null}
                    {e.outcome !== "success" ? <span className={OUTCOME_CHIP[e.outcome] ?? chipWarn}>{tx(`admin.trail.outcome_${e.outcome}` as MessageKey)}</span> : null}
                  </p>
                </div>
                {compact ? null : (
                  <button
                    type="button"
                    className={cx(iconBtn, "text-ink-2 -mr-1.5 shrink-0")}
                    aria-expanded={expanded}
                    aria-label={expanded ? tx("admin.trail.collapse") : tx("admin.trail.expand")}
                    onClick={() => setOpen(expanded ? null : e.id)}
                  >
                    <ChevronDownIcon className={cx("transition-transform", expanded && "rotate-180")} />
                  </button>
                )}
              </div>
              {expanded ? <Details e={e} filter={filter} value={value} tx={tx} /> : null}
            </li>
          </Fragment>
        );
      })}
    </ul>
  );
}

function ChangeRow({ c, value, tx }: { c: Change; value: (f: string, v: unknown) => string; tx: T }) {
  const label = fieldLabel(tx, c.field);
  if (c.kind === "private")
    return (
      <tr>
        <th scope="row">{label}</th>
        <td colSpan={2} className="text-ink-2 italic">
          {tx("admin.trail.privateChanged")}
        </td>
      </tr>
    );
  if (c.kind === "members")
    return (
      <tr>
        <th scope="row">{label}</th>
        <td className="text-ink-2">{c.removed.length ? `− ${c.removed.map((u) => value("userId", u)).join(", ")}` : "—"}</td>
        <td>{c.added.length ? `+ ${c.added.map((u) => value("userId", u)).join(", ")}` : "—"}</td>
      </tr>
    );
  if (c.kind === "other")
    return (
      <tr>
        <th scope="row">{label}</th>
        <td colSpan={2}>{value(c.field, c.value)}</td>
      </tr>
    );
  return (
    <tr>
      <th scope="row">{label}</th>
      <td className="text-ink-2">{value(c.field, c.from)}</td>
      <td>{value(c.field, c.to)}</td>
    </tr>
  );
}

const cell = "[&_td]:py-1 [&_td]:pr-3 [&_td]:align-top [&_th]:py-1 [&_th]:pr-3 [&_th]:text-left [&_th]:align-top [&_th]:font-medium [&_th]:text-ink-2";

function Details({ e, filter, value, tx }: { e: TrailEntry; filter: TrailFilter; value: (f: string, v: unknown) => string; tx: T }) {
  const changes = changeList(e.changes);
  const meta = Object.entries(e.meta ?? {}).filter(([, v]) => v !== null && v !== undefined && v !== "");
  return (
    <div className="bg-ground/60 border-divider-soft min-w-0 border-t px-4 py-3 text-[13px] max-sm:px-3">
      {changes.length ? (
        <div className="mb-3 min-w-0 overflow-x-auto">
          <table className={cx("w-full border-collapse", cell)}>
            <caption className="text-ink-2 pb-1 text-left text-xs font-semibold">{tx("admin.trail.changes")}</caption>
            <thead className="sr-only">
              <tr>
                <th scope="col">{tx("admin.trail.field")}</th>
                <th scope="col">{tx("admin.trail.before")}</th>
                <th scope="col">{tx("admin.trail.after")}</th>
              </tr>
            </thead>
            <tbody>
              {changes.map((c) => (
                <ChangeRow key={c.field} c={c} value={value} tx={tx} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <dl className="m-0 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
        {meta.map(([k, v]) => (
          <Fragment key={k}>
            <dt className="text-ink-2">{fieldLabel(tx, k)}</dt>
            <dd className="m-0 [overflow-wrap:anywhere]">{value(k, v)}</dd>
          </Fragment>
        ))}
        <dt className="text-ink-2">{tx("admin.trail.target")}</dt>
        <dd className={cx("m-0 [overflow-wrap:anywhere]", mono)}>
          {targetTypeLabel(tx, e.targetType)} · {e.targetId}
        </dd>
        {e.ip ? (
          <>
            <dt className="text-ink-2">{tx("admin.trail.ip")}</dt>
            <dd className={cx("m-0", mono)}>{ipLabel(e.ip, tx("admin.trail.local"))}</dd>
          </>
        ) : null}
        {e.userAgent ? (
          <>
            <dt className="text-ink-2">{tx("admin.trail.device")}</dt>
            <dd className="text-ink-2 m-0 [overflow-wrap:anywhere]">{e.userAgent}</dd>
          </>
        ) : null}
        {e.via ? (
          <>
            <dt className="text-ink-2">{tx("admin.trail.via")}</dt>
            <dd className="m-0">{tx(`admin.trail.via_${e.via}` as MessageKey)}</dd>
          </>
        ) : null}
        {e.requestId ? (
          <>
            <dt className="text-ink-2">{tx("admin.trail.request")}</dt>
            <dd className="m-0 min-w-0">
              <Link
                href={filterHref({ range: "all" }, { requestId: e.requestId })}
                className={cx("text-accent-text no-underline [overflow-wrap:anywhere] hover:underline", mono)}
                title={tx("admin.trail.traceRequest")}
              >
                {e.requestId}
              </Link>
            </dd>
          </>
        ) : null}
      </dl>
      <p className="m-0 mt-2 flex flex-wrap gap-x-4 gap-y-1">
        <Link
          href={filterHref(filter, { targetType: e.targetType, targetId: e.targetId, q: undefined })}
          className="text-accent-text text-xs font-medium no-underline hover:underline"
        >
          {tx("admin.trail.traceTarget")}
        </Link>
      </p>
    </div>
  );
}
