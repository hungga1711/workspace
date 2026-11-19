import { INTL_TAG } from "@/lib/i18n/config";
import { featureLabel } from "@/lib/ai-labels";
import { getLocale } from "@/lib/i18n/server";
import Link from "next/link";
import { btn, btnSm, cardLink, cx, progressFill, progressTrack } from "@/lib/ui";
import type { T } from "@/lib/i18n/core";
import { getT } from "@/lib/i18n/server";
import { gw } from "@/lib/gateway";
import { AdminHeader, AdminSectionTiles } from "@/components/admin/AdminNav";
import { adminCard } from "@/components/admin/AdminBits";
import { Figure, IconTile, Tile, card, type Tone } from "@/components/ui/Bento";
import { SpotArea } from "@/components/ui/SpotArea";
import { ArrowRightIcon, BotIcon, ChatIcon, CheckCircleIcon, InfoIcon, ListIcon, SettingsIcon, ShieldIcon, UsersIcon } from "@/components/app/icons";
import { adminLoad, viewerPermissions } from "@/components/admin/guard";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { AuditRows } from "@/components/admin/AuditRows";
import type { SetupItem } from "@/components/admin/SetupChecklist";
import { AttentionQueue, SetupChecklist } from "@/components/admin/AdminLazy";
import type { AttentionItem, AttentionSource } from "@/components/admin/AttentionQueue";
import { attentionSources } from "@/components/admin/attention-sources";
import { aiStatus } from "@/lib/ai";
import type { TrailPage } from "@/components/admin/audit";

interface ChatStats {
  days: { day: string; messages: number; senders: number }[];
  totals: { messages: number; senders: number };
}
interface WorkStats {
  days: { day: string; created: number; done: number }[];
  totals: { tasksCreated: number; tasksDone: number; docsEdited: number; meetings: number };
}
interface Ws {
  workspace: { name: string; created_at: string };
  features: Record<string, boolean>;
}

/**
 * The modules a company can switch, as Settings and Admin › AI show them (Chat and Work are always on, so counting them
 * made "3 of 3" disagree with Settings). Meetings depend on the server (LiveKit), not on a switch.
 */
const FEATURE = (tx: T): [string, string, string | null][] => [
  ["attendance", tx("admin.page.featAttendance"), "/admin/workspace/settings"],
  ["aiAssistant", tx("admin.page.featAssistant"), "/admin/workspace/ai"],
  ["aiMonitoring", tx("admin.page.featInsights"), "/admin/workspace/ai"],
  ["meet", tx("admin.page.featMeet"), null],
];

/** Workspace Admin → Overview: usage, activity, configuration status. */
/** A 7-day line only says something once there are at least three active days; one busy day drew a fake peak. */
const trend = (days?: number[]) => (days && days.filter((n) => n > 0).length >= 3 ? days : undefined);

export default async function AdminOverview() {
  const intlTag = INTL_TAG[await getLocale()];
  const tx = await getT();
  const r = await adminLoad(() =>
    Promise.all([
      gw<Ws>("/api/platform/workspace"),
      // Only the workspace itself is essential here; every other read is one tile or card, which shows "—" or a retry
      // note when its read fails instead of taking the overview down.
      gw<{ members: { status: string }[]; counts: { active: number } }>("/api/identity/members").catch(() => null),
      gw<{
        byFeature: { feature: string; tokens: number; calls: number }[];
        model?: { degraded: boolean; reason?: "rate_limited" | "failing" };
      }>("/api/ai/usage").catch(() => null),
      gw<TrailPage>("/api/platform/audit?limit=5").catch(() => null),
      gw<{ employees: { userId: string; managerId: string | null }[] }>("/api/employee/employees?all=1").catch(() => ({ employees: [] })),
      gw<ChatStats>("/api/chat/stats/activity?days=7").catch(() => null),
      gw<WorkStats>("/api/work/stats/activity?days=7").catch(() => null),
      gw<{ summary: { activeUsers7d: number } }>("/api/identity/security/sign-ins").catch(() => null),
    ]),
  );
  // The setup checklist's reads; each one failing leaves its row "unknown" instead of failing the overview.
  const year = new Date().getUTCFullYear();
  const [mail, mfa, holidays, people2, ai] = await Promise.all([
    gw<{ configured: boolean }>("/api/identity/mail/status").catch(() => null),
    gw<{ required: boolean }>("/api/identity/security/mfa-policy").catch(() => null),
    gw<{ holidays: unknown[] }>(`/api/employee/holidays?year=${year}`).catch(() => null),
    gw<{ shift: unknown }>("/api/employee/settings").catch(() => null),
    aiStatus(),
  ]);
  if ("denied" in r) return r.denied;
  const [ws, members, usage, audit, people, chatStats, workStats, signIns] = r.data;
  // What needs an admin, asked of each module that the viewer may fix things in (each module checks again and gives
  // only the kinds this person can act on). A read that fails is kept as "could not check", never as "nothing".
  const attention = async (key: AttentionSource["key"]): Promise<AttentionSource> => ({
    key,
    items: await gw<{ items: AttentionItem[] }>(`/api/${key}/attention`)
      .then((x) => x.items)
      .catch(() => null),
  });
  const needs = await Promise.all(attentionSources(await viewerPermissions(), ws.features).map(attention));
  // Show only what the viewer can act on: a Manager opening Quản trị sees no member counts, AI spend or audit trail
  // (null permissions = unknown: show everything, as before; every link still checks on its own page).
  const perms = await viewerPermissions();
  const can = (...p: string[]) => !perms || p.some((x) => perms.has(x));
  const canMembers = can("member.manage", "member.invite");
  const canAudit = can("audit.read");
  const canAi = ws.features.ai !== false && can("ai.policy.manage", "ai.agent.manage");
  // The org chart drives Tiến độ (who sees whose work) and who approves leave: count who still has no manager.
  const tops = people.employees.filter((e) => !e.managerId).length;
  const invited = (members?.members ?? []).filter((m) => m.status === "invited").length;
  const aiTokens = (usage?.byFeature ?? []).reduce((n, f) => n + Number(f.tokens), 0);
  const byFeature = [...(usage?.byFeature ?? [])].sort((a, b) => Number(b.tokens) - Number(a.tokens)).slice(0, 5);
  const maxTokens = Math.max(1, ...byFeature.map((f) => Number(f.tokens)));
  const n = (v: number) => v.toLocaleString(intlTag);
  const missing = tops > 1 ? tops - 1 : 0;
  // Switches of a feature the deployment left out (DISABLED_FEATURES) are not listed: nothing here can turn them on.
  const features = FEATURE(tx).filter(([k]) => !(k === "attendance" && ws.features.time === false) && !(k.startsWith("ai") && ws.features.ai === false));
  const setup: SetupItem[] = [
    { key: "email", done: mail ? mail.configured : null, href: "/admin/workspace/settings#m-h" },
    { key: "twoStep", done: mfa ? mfa.required : null, href: "/admin/workspace/security" },
    { key: "holidays", done: holidays ? holidays.holidays.length > 0 : null, href: "/admin/workspace/holidays" },
    ...(ws.features.attendance ? [{ key: "workWeek" as const, done: people2 ? people2.shift !== null : null, href: "/admin/workspace/attendance" }] : []),
    { key: "backups", done: null },
    { key: "invite", done: members ? members.counts.active > 1 : null, href: "/admin/workspace/members" },
    ...(ws.features.ai === false ? [] : [{ key: "ai" as const, done: ai.configured, href: "/admin/workspace/ai", optional: true }]),
  ];
  return (
    <SpotArea className="flex flex-col gap-5 max-md:gap-4 [&>header]:mb-1">
      <AdminHeader title={tx("admin.page.tong_quan")} sub={ws.workspace.name || undefined} />
      <AttentionQueue sources={needs} />
      {can("workspace.configure") ? <SetupChecklist items={setup} /> : null}
      {canAi && usage?.model?.degraded ? (
        // The main model is failing (quota or outage): answers still come, from a simpler fallback.
        <p role="status" className={cx(adminCard, "m-0 flex min-w-0 items-center gap-3.5 px-5 py-3.5 text-sm max-sm:px-4")}>
          <IconTile tone="tangerine">
            <InfoIcon />
          </IconTile>
          <span className="min-w-0 flex-1">
            <b className="font-semibold">{tx("admin.page.aiDegraded")}</b> {tx(usage.model.reason === "rate_limited" ? "admin.page.aiDegradedQuota" : "admin.page.aiDegradedDown")}
          </span>
        </p>
      ) : null}
      {/* The week in four figures, one per tile (members and sign-ins only for who can act on them). */}
      <section aria-label={tx("admin.page.muc_do_su_dung")} className="grid grid-cols-2 gap-4 max-md:gap-3 lg:grid-cols-4">
        {canMembers ? (
          <Stat
            label={tx("admin.page.thanh_vien")}
            icon={<UsersIcon />}
            tone="violet"
            value={members?.counts.active ?? null}
            unit={invited ? tx("admin.page.loi_moi_chua_nhan", { p0: invited }) : undefined}
            href="/admin/workspace/members"
            n={n}
          />
        ) : null}
        {canAudit ? (
          <Stat
            label={tx("admin.page.nguoi_dang_nhap")}
            icon={<ShieldIcon />}
            tone="green"
            value={signIns?.summary.activeUsers7d ?? null}
            unit={members ? tx("admin.page.khach", { p0: n(members.counts.active) }) : undefined}
            href="/admin/workspace/security"
            n={n}
          />
        ) : null}
        {/* Workspace-wide activity: a manager whose role cannot read it gets no tile rather than a "—". */}
        {chatStats || can("workspace.configure") ? (
          <Stat
            label={tx("admin.page.tin_nhan")}
            icon={<ChatIcon />}
            tone="sky"
            value={chatStats?.totals.messages ?? null}
            unit={tx("admin.page.last7")}
            bars={trend(chatStats?.days.map((d) => d.messages))}
            n={n}
          />
        ) : null}
        {workStats || can("workspace.configure") ? (
          <Stat
            label={tx("admin.page.viec_xong")}
            icon={<CheckCircleIcon />}
            tone="tangerine"
            value={workStats?.totals.tasksDone ?? null}
            unit={tx("admin.page.last7")}
            bars={trend(workStats?.days.map((d) => d.done))}
            n={n}
          />
        ) : null}
      </section>
      <div className="@container">
        <div className="@[44rem]:grid-cols-2 @[64rem]:grid-cols-3 grid gap-4 max-md:gap-3">
          {canAi && byFeature.length ? (
            <Tile
              id="ai-h"
              title={tx("admin.page.ai_dung_vao_viec")}
              icon={<BotIcon />}
              tone="violet"
              link={{ href: "/admin/workspace/ai/cost", label: tx("admin.page.aiMonth", { p0: n(aiTokens) }) }}
              className="@[64rem]:col-span-2"
            >
              <Figure n={n(aiTokens)} label={tx("admin.page.aiTokens")} />
              <ul className="m-0 mt-4 grid list-none gap-3 p-0">
                {byFeature.map((f, i) => (
                  <li key={f.feature} className="grid gap-1.5 text-sm">
                    <span className="flex items-baseline justify-between gap-3">
                      <span className="truncate">{featureLabel(tx, f.feature)}</span>
                      <span className="text-ink-2 shrink-0 text-xs tabular-nums">{n(Number(f.tokens))}</span>
                    </span>
                    <span className={progressTrack}>
                      <span className={cx(progressFill, i > 0 && "opacity-60")} style={{ width: `${(Number(f.tokens) / maxTokens) * 100}%` }} />
                    </span>
                  </li>
                ))}
              </ul>
            </Tile>
          ) : null}
          <Tile
            id="feat-h"
            title={tx("admin.page.tinh_nang_dang_bat")}
            icon={<SettingsIcon />}
            tone="sky"
            link={can("workspace.configure") ? { href: "/admin/workspace/settings", label: tx("admin.page.doi") } : undefined}
          >
            <Figure n={features.filter(([k]) => ws.features[k]).length} label={tx("admin.page.ofFeatures", { p0: features.length })} />
            <ul className="m-0 mt-3 grid list-none gap-0.5 p-0 text-sm">
              {features.map(([k, l, href]) => (
                <li key={k} className="flex min-h-9 items-center gap-2.5">
                  <span className={cx("size-1.5 shrink-0 rounded-full", ws.features[k] ? "bg-ok-fill" : "bg-edge")} aria-hidden="true" />
                  {href && can("workspace.configure", "ai.policy.manage") ? (
                    <Link href={href} className={cx("min-w-0 flex-1 truncate no-underline hover:underline", ws.features[k] ? "text-ink" : "text-ink-2")}>
                      {l}
                    </Link>
                  ) : (
                    <span className={cx("min-w-0 flex-1 truncate", ws.features[k] ? "text-ink" : "text-ink-2")} title={k === "meet" ? tx("admin.page.featMeetHint") : undefined}>
                      {l}
                    </span>
                  )}
                  <span className={cx("text-xs", ws.features[k] ? "text-ok" : "text-ink-2")}>{ws.features[k] ? tx("admin.page.dang_bat") : tx("admin.page.dang_tat")}</span>
                </li>
              ))}
            </ul>
            <p className="text-ink-2 m-0 mt-2 text-xs">{tx("admin.page.alwaysOn")}</p>
          </Tile>
          {canMembers && missing ? (
            // The org chart drives Tiến độ (who sees whose work) and who approves leave.
            <Tile id="org-h" title={tx("admin.page.orgChart")} icon={<UsersIcon />} tone="rose" link={{ href: "/admin/workspace/teams", label: tx("admin.page.orgMissingCta") }}>
              <Figure n={n(missing)} tone="alert" label={tx("admin.page.noManager")} />
              <p role="status" className="text-ink-2 m-0 mt-2 text-[13px]">
                {tx("admin.page.orgMissingShort", { count: missing })}
              </p>
              <Link href="/admin/workspace/teams" className={cx(btn, btnSm, "mt-4 self-start")}>
                {tx("admin.page.orgMissingCta")}
              </Link>
            </Tile>
          ) : null}
        </div>
      </div>
      <AdminSectionTiles features={ws.features} />
      {canAudit ? (
        <section aria-labelledby="act-h" className="mt-1">
          <header className="mb-3 flex min-h-8 items-center gap-3">
            <IconTile tone="green">
              <ListIcon />
            </IconTile>
            <h2 id="act-h" className="m-0 min-w-0 flex-1 truncate text-sm font-semibold tracking-[-0.01em]">
              {tx("admin.page.hoat_dong_gan_day")}
            </h2>
            <Link href="/admin/workspace/audit" className={cardLink}>
              {tx("admin.page.xem_tat_ca")}
            </Link>
          </header>
          {audit ? <AuditRows entries={audit.entries} filter={{ range: "30" }} compact /> : <LoadFailed />}
        </section>
      ) : null}
    </SpotArea>
  );
}

/**
 * One headline figure: a tinted icon tile and its label, the figure big and tabular, a short unit line; the week as
 * seven quiet bars when it has at least three active days. A tile that leads somewhere is one link (arrow nudges).
 */
function Stat({
  label,
  icon,
  tone,
  value,
  unit,
  href,
  bars,
  n,
}: {
  label: string;
  icon: React.ReactNode;
  tone: Tone;
  value: number | null;
  unit?: string;
  href?: string;
  bars?: number[];
  n: (v: number) => string;
}) {
  const max = Math.max(1, ...(bars ?? []));
  const body = (
    <>
      <span className="flex min-w-0 items-center gap-2.5">
        <IconTile tone={tone}>{icon}</IconTile>
        <span className="text-ink-2 line-clamp-2 min-w-0 flex-1 text-[13px]/4 font-medium">{label}</span>
        {href ? <ArrowRightIcon className="text-ink-2 size-4 shrink-0 transition-transform group-hover/tile:translate-x-0.5 max-sm:hidden" /> : null}
      </span>
      <span className="mt-4 flex min-w-0 flex-wrap items-end justify-between gap-x-3 gap-y-2">
        <span className="min-w-0">
          {value === null ? (
            <span className="text-ink-2 block text-sm">—</span>
          ) : (
            <span className={cx("font-display block text-[38px]/none font-semibold tabular-nums tracking-[-0.045em] max-sm:text-[30px]", value === 0 ? "text-ink-2" : "text-ink")}>
              {n(value)}
            </span>
          )}
          {unit ? <span className="text-ink-2 mt-1.5 block text-xs">{unit}</span> : null}
        </span>
        {bars ? (
          <span aria-hidden="true" className="flex h-9 shrink-0 items-end gap-[3px] max-sm:hidden">
            {bars.map((b, i) => (
              <span key={i} className={cx("w-1.5 rounded-full", i === bars.length - 1 ? "bg-progress" : "bg-progress/35")} style={{ height: `${Math.max(8, (b / max) * 100)}%` }} />
            ))}
          </span>
        ) : null}
      </span>
    </>
  );
  const cls = cx(card, "group/tile flex min-w-0 flex-col rounded-xl p-5 max-sm:p-4");
  return href ? (
    <Link href={href} className={cx(cls, "text-ink no-underline")}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}
