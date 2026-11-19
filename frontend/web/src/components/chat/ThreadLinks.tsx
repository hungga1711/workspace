"use client";

import { ProjectBadge } from "@/components/ui/ProjectBadge";
import { useFormat, useT } from "@/lib/i18n/client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { detectSignals } from "@/lib/signals";
import { btn, btnGhost, btnSm, cx } from "@/lib/ui";
import { Picker } from "@/components/ui/Picker";
import { FileIcon, PlusIcon, CloseIcon, ClockIcon } from "@/components/app/icons";

export interface ThreadLink {
  kind: "project" | "document";
  refId: string;
  title: string;
}
interface Option {
  kind: "project" | "document";
  id: string;
  title: string;
}

/**
 * Related project/document of a thread, plus the "update project" action: when the thread
 * mentions a new deadline and is linked to a project, one click moves the project's due date
 * (version-checked, with the thread as the recorded reason).
 */
export function ThreadLinks({ rootId, links, texts, onChange }: { rootId: string; links: ThreadLink[]; texts: string[]; onChange: (l: ThreadLink[]) => void }) {
  const t = useT();
  const { shortDate } = useFormat();
  const [adding, setAdding] = useState(false);
  const [options, setOptions] = useState<Option[]>([]);
  const [pick, setPick] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!adding || options.length) return;
    void Promise.all([
      api<{ projects: { id: string; name: string }[] }>("work/projects").catch(() => ({ projects: [] })),
      api<{ documents: { id: string; title: string }[] }>("work/docs").catch(() => ({ documents: [] })),
    ]).then(([p, d]) =>
      setOptions([
        ...p.projects.map((x) => ({ kind: "project" as const, id: x.id, title: x.name })),
        ...d.documents.map((x) => ({ kind: "document" as const, id: x.id, title: x.title })),
      ]),
    );
  }, [adding, options.length]);
  const add = async () => {
    const o = options.find((x) => `${x.kind}:${x.id}` === pick);
    if (!o) return;
    await api(`chat/messages/${rootId}/links`, { method: "POST", body: { kind: o.kind, refId: o.id, title: o.title } });
    onChange([...links.filter((l) => !(l.kind === o.kind && l.refId === o.id)), { kind: o.kind, refId: o.id, title: o.title }]);
    setAdding(false);
    setPick("");
  };
  const remove = async (l: ThreadLink) => {
    await api(`chat/messages/${rootId}/links/${l.kind}/${l.refId}`, { method: "DELETE" });
    onChange(links.filter((x) => x !== l));
  };
  const deadline =
    [...texts]
      .reverse()
      .map((x) => detectSignals(x, new Date(), { today: t("chat.links.today"), tomorrow: t("chat.links.tomorrow") }).deadline)
      .find(Boolean) ?? null;
  const project = links.find((l) => l.kind === "project");
  const moveDeadline = async () => {
    if (!project || !deadline) return;
    try {
      const p = await api<{ version: number }>(`work/projects/${project.refId}`);
      await api(`work/projects/${project.refId}`, { method: "PATCH", body: { expectedVersion: p.version, dueAt: deadline.iso, reason: t("chat.links.reason") } });
      setMsg(t("chat.links.moved", { project: project.title, date: deadline.rel !== undefined ? deadline.label : shortDate(deadline.iso) }));
    } catch (e) {
      setMsg(t((e as { status?: number }).status === 403 ? "chat.links.noPermission" : "chat.links.moveFailed"));
    }
  };
  return (
    <section className="mx-4 my-2 grid gap-1.5 text-sm" aria-label={t("chat.links.related")}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-ink-2 text-xs font-semibold">{t("chat.links.related")}</span>
        {links.map((l) => (
          <span key={`${l.kind}:${l.refId}`} className="border-hairline bg-ground inline-flex items-center gap-1 rounded-sm border py-0.5 pl-2 pr-1">
            {l.kind === "project" ? <ProjectBadge id={l.refId} name={l.title} size="xs" /> : <FileIcon className="text-ink-2 size-3.5" />}
            <Link href={l.kind === "project" ? `/app/work/projects/${l.refId}` : `/app/work/docs/${l.refId}`} className="max-w-44 truncate">
              {l.title}
            </Link>
            <button type="button" aria-label={t("chat.links.unlink", { title: l.title })} onClick={() => void remove(l)} className="text-ink-2 hover:text-ink">
              <CloseIcon className="size-3" />
            </button>
          </span>
        ))}
        {!adding ? (
          <button type="button" className={cx(btnGhost, btnSm, "h-6 min-h-0 px-1.5")} onClick={() => setAdding(true)}>
            <PlusIcon className="size-3" />
            {t("chat.links.attach")}
          </button>
        ) : (
          <span className="flex items-center gap-1">
            <Picker
              variant="button"
              label={t("chat.links.pick")}
              placeholder={t("chat.links.choose")}
              value={pick}
              onChange={setPick}
              className="max-w-52"
              options={[
                ...options
                  .filter((o) => o.kind === "project")
                  .map((o) => ({ value: `project:${o.id}`, label: o.title, icon: <ProjectBadge id={o.id} name={o.title} size="sm" /> })),
                ...options.filter((o) => o.kind === "document").map((o) => ({ value: `document:${o.id}`, label: o.title, icon: <FileIcon className="size-4" /> })),
              ]}
            />
            <button type="button" className={cx(btn, btnSm, "h-7 min-h-0")} disabled={!pick} onClick={() => void add()}>
              {t("chat.links.link")}
            </button>
            <button type="button" className={cx(btn, btnSm, "h-7 min-h-0")} onClick={() => setAdding(false)}>
              {t("common.cancel")}
            </button>
          </span>
        )}
      </div>
      {project && deadline && !msg ? (
        <button
          type="button"
          onClick={() => void moveDeadline()}
          className="border-ink/15 bg-brand-wash text-ink inline-flex w-fit items-center gap-1 rounded-sm border px-2 py-0.5 text-xs"
        >
          <ClockIcon className="size-3" />
          {t("chat.links.moveDeadline", { project: project.title, date: deadline.rel !== undefined ? deadline.label : shortDate(deadline.iso) })}
        </button>
      ) : null}
      {msg ? (
        <p className="text-ok text-xs" role="status">
          {msg}
        </p>
      ) : null}
    </section>
  );
}
