"use client";

import Link from "next/link";
import { useT } from "@/lib/i18n/client";
import { Avatar } from "@/lib/people";
import { cx } from "@/lib/ui";
import { BoardIcon, CheckIcon, ClockIcon, FlagIcon, UsersIcon } from "@/components/app/icons";
import { Velocity } from "./Velocity";
import { card } from "@/components/ui/Bento";
import { SpotArea } from "@/components/ui/SpotArea";
import { PageHeader } from "@/components/ui/PageHeader";
import { PanelHead, StatStrip } from "./progressUi";
import type { DepartmentStatus, TeamPerson } from "./team-types";

const panel = cx(card, "min-w-0 rounded-xl p-5 max-sm:p-4");

export interface DepartmentRead {
  access: "everyone" | "manager" | "colleague";
  department: { id: string; name: string; headId: string | null; members: number };
  totals: { open: number; overdue: number; atRisk?: number; stale: number; blocked: number; done7: number };
  rollup: DepartmentStatus | null;
  people: (TeamPerson & { full: boolean })[];
}
/**
 * A department at a glance: the figures, the pace (done against added per week, the honest picture on a board where
 * work comes in all the time), then its people worst first. Rows the caller may not open in full are numbers only.
 */
export function DepartmentView({ data }: { data: DepartmentRead }) {
  const t = useT();
  const { department: d, totals, people, access } = data;
  const ranked = [...people].sort((a, b) => b.overdue * 3 + b.blocked * 2 + b.stale - (a.overdue * 3 + a.blocked * 2 + a.stale) || a.displayName.localeCompare(b.displayName));
  return (
    <SpotArea className="grid grid-cols-[minmax(0,1fr)] gap-6 max-md:gap-4">
      <PageHeader
        size="entity"
        className="mb-0"
        title={d.name}
        meta={[t("dept.members", { count: d.members }), d.headId ? t("dept.head", { name: people.find((p) => p.userId === d.headId)?.displayName ?? "" }) : null]
          .filter(Boolean)
          .join(" · ")}
      />
      <StatStrip
        label={t("person.numbers")}
        items={[
          { label: t("dept.open"), value: totals.open, icon: <BoardIcon />, tone: "sky", quiet: !totals.open },
          { label: t("follow.colLate"), value: totals.overdue, icon: <ClockIcon />, tone: "red", alert: totals.overdue > 0, quiet: !totals.overdue },
          { label: t("dept.blocked"), value: totals.blocked, icon: <FlagIcon />, tone: "tangerine", quiet: !totals.blocked },
          { label: t("follow.colDone"), value: totals.done7, icon: <CheckIcon />, tone: "green", quiet: !totals.done7 },
        ]}
      />
      {/* The pace (done against added per week, what is stuck): Work's shared velocity view, as on a project. */}
      <Velocity scope={`department:${d.id}`} showAttention={access !== "colleague"} />
      <section aria-labelledby="dept-people-h" className={panel}>
        <PanelHead id="dept-people-h" title={t("dept.people")} count={people.length} icon={<UsersIcon />} tone="sky" />
        {access === "colleague" ? <p className="text-ink-2 m-0 mb-2 text-sm">{t("person.colleagueNote")}</p> : null}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] border-collapse text-sm">
            <thead>
              <tr className="text-ink-2 text-left text-xs">
                <th className="py-2 pr-3 font-medium">{t("dept.colPerson")}</th>
                <th className="px-3 py-2 text-right font-medium">{t("dept.open")}</th>
                <th className="px-3 py-2 text-right font-medium">{t("follow.colLate")}</th>
                <th className="px-3 py-2 text-right font-medium">{t("dept.blocked")}</th>
                <th className="py-2 pl-3 text-right font-medium">{t("follow.colDone")}</th>
              </tr>
            </thead>
            <tbody className="divide-divider-soft divide-y">
              {ranked.map((p) => (
                <tr key={p.userId}>
                  <td className="py-2.5 pr-3">
                    <span className="flex min-w-0 items-center gap-2.5">
                      <Avatar id={p.userId} name={p.displayName} size="sm" />
                      {p.full ? (
                        <Link href={`/app/work/people/${p.userId}`} className="text-ink -my-1.5 block min-w-0 truncate py-1.5 font-medium no-underline hover:underline">
                          {p.displayName}
                        </Link>
                      ) : (
                        <span className="min-w-0 truncate font-medium">{p.displayName}</span>
                      )}
                      {p.title ? <span className="text-ink-2 min-w-0 truncate text-xs max-sm:hidden">{p.title}</span> : null}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{p.open}</td>
                  <td className={cx("px-3 py-2.5 text-right tabular-nums", p.overdue ? "text-block font-semibold" : "text-ink-2")}>{p.overdue}</td>
                  <td className={cx("px-3 py-2.5 text-right tabular-nums", p.blocked ? "text-warn font-semibold" : "text-ink-2")}>{p.blocked}</td>
                  <td className="py-2.5 pl-3 text-right tabular-nums">{p.done7}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </SpotArea>
  );
}
