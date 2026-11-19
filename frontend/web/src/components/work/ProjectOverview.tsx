"use client";

import { PersonChip } from "@/components/chat/PersonTrigger";
import { useState } from "react";
import { useFormat, useT } from "@/lib/i18n/client";
import { card, cx } from "@/lib/ui";
import { ProjectStatus } from "./ProjectStatus";
import { Velocity, type VelocityData } from "./Velocity";

/**
 * A project's Overview (the boss's view of it, Board stays the working view): who leads it and who works on it, its
 * dates, the pace and what needs attention, and the weekly status the lead writes.
 */
export function ProjectOverview({ project }: { project: { id: string; name: string; ownerId: string; dueAt: string | null; createdAt?: string | null; people: string[] } }) {
  const t = useT();
  const { dayInline } = useFormat();
  const [flow, setFlow] = useState<VelocityData | null>(null);
  const others = project.people.filter((x) => x !== project.ownerId);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-4">
        <ProjectStatus projectId={project.id} projectName={project.name} flow={flow} />
        <Velocity scope={`project:${project.id}`} showAttention onData={setFlow} />
      </div>
      <aside className={cx(card, "grid min-w-0 content-start gap-4 p-5 max-sm:p-4")}>
        <Fact label={t("projectOverview.lead")}>
          <PersonChip userId={project.ownerId} className="text-ink" />
        </Fact>
        <Fact label={t("projectOverview.people")}>
          {others.length ? (
            <ul className="m-0 grid list-none gap-1.5 p-0">
              {others.slice(0, 12).map((id) => (
                <li key={id} className="flex min-w-0">
                  <PersonChip userId={id} className="text-ink" />
                </li>
              ))}
              {others.length > 12 ? <li className="text-ink-2 text-xs">+{others.length - 12}</li> : null}
            </ul>
          ) : (
            <span className="text-ink-2">–</span>
          )}
        </Fact>
        <Fact label={t("projectOverview.dates")}>
          <span className="grid gap-0.5">
            {project.createdAt ? <span>{t("projectOverview.started", { date: dayInline(project.createdAt) })}</span> : null}
            <span>{project.dueAt ? t("projectOverview.due", { date: dayInline(project.dueAt) }) : t("projectOverview.noDue")}</span>
          </span>
        </Fact>
      </aside>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid min-w-0 gap-1.5 text-sm">
      <span className="text-ink-2 text-xs font-medium uppercase tracking-[0.08em]">{label}</span>
      {children}
    </div>
  );
}
