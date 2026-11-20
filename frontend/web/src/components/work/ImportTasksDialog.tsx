"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { api } from "@/lib/client";
import { useFormat } from "@/lib/i18n/client";
import type { MessageKey } from "@/lib/i18n/core";
import { useDirectory } from "@/lib/people";
import { btn, btnPrimary, cx, table } from "@/lib/ui";
import { Checkbox } from "@/components/ui/Checkbox";
import { Modal } from "@/components/ui/Modal";
import { Picker } from "@/components/ui/Picker";
import { MAPPABLE, planClickUpJson, planImport, planTrelloJson, type Field, type ImportPlan, type ImportSystem, type ImportTask } from "./importTasks";
import type { NotionPlan } from "./notionExport";

const MAX = 1000;

type Done = { created: number; unassigned: number; projects: number; docs: number; space: string | null };

/**
 * Work › project › "Nhập việc": a Jira, Trello, Asana or ClickUp export (or any spreadsheet saved as CSV), Trello or
 * ClickUp JSON, or a Notion export (.zip) becomes this project's tasks — and, for Notion, its pages become documents
 * in a new space. Everything is read in the browser and shown before anything is created; CSV columns can be
 * re-mapped by hand.
 */
export function ImportTasksDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const { t, dayInline } = useFormat();
  const router = useRouter();
  const dir = useDirectory();
  const fileId = useId();
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  // The CSV behind the plan, kept to re-plan when a column is re-mapped or another Notion database is picked.
  const [csv, setCsv] = useState<{ text: string; system?: ImportSystem; columns: Partial<Record<Field, number>> } | null>(null);
  const [notion, setNotion] = useState<NotionPlan | null>(null);
  const [db, setDb] = useState(0);
  const [withPages, setWithPages] = useState(true);
  const [perList, setPerList] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  // Assignees are matched by email or name. The app's directory carries no emails (it is kept light), so the dialog
  // asks for the member list once; until it answers, names still match.
  const [members, setMembers] = useState<{ userId: string; displayName: string; email: string }[] | null>(null);
  const membersRef = useRef(members);
  useEffect(() => {
    void api<{ members: { userId: string; displayName: string; email: string | null }[] }>("identity/members")
      .then((r) => {
        membersRef.current = r.members.map((m) => ({ userId: m.userId, displayName: m.displayName, email: m.email ?? "" }));
        setMembers(membersRef.current);
      })
      .catch(() => setMembers([]));
  }, []);
  // Read through a ref: a file read that awaited while the list arrived still matches against it, not the render it began in.
  const people = () => {
    const list = membersRef.current;
    return list?.length ? list : [...dir.byId.values()].map((x) => ({ userId: x.userId, displayName: x.displayName, email: x.email ?? "" }));
  };

  const replan = (text: string, system: ImportSystem | undefined, columns: Partial<Record<Field, number>>) => {
    setCsv({ text, system, columns });
    const p = planImport(text, people(), { system, columns });
    if (p.columns.title === undefined) {
      setPlan(p.headers.length ? { ...p, tasks: [] } : null);
      return setError(t("work.import.noTitle"));
    }
    setError(p.tasks.length ? null : t("work.import.empty"));
    setPlan(p);
  };

  // A CSV read before the member list arrived is matched again with emails.
  useEffect(() => {
    if (members && csv) replan(csv.text, csv.system, csv.columns);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the member list arrives
  }, [members]);

  const read = async (f: File | undefined) => {
    setError(null);
    setPlan(null);
    setCsv(null);
    setNotion(null);
    if (!f) return;
    if (/\.zip$/i.test(f.name)) {
      // Notion exports hold every page and attachment, so they may be large; only the text files are read.
      if (f.size > 100 * 1024 * 1024) return setError(t("work.import.tooBig"));
      try {
        const { planNotion } = await import("./notionExport");
        const n = planNotion(await f.arrayBuffer());
        if (!n.databases.length && !n.pages.length) return setError(t("work.import.badZip"));
        setNotion(n);
        const best = n.databases.reduce((bi, d, i, all) => (d.rows > all[bi]!.rows ? i : bi), 0);
        setDb(best);
        if (n.databases.length) replan(n.databases[best]!.csv, "notion", {});
      } catch {
        setError(t("work.import.badZip"));
      }
      return;
    }
    if (f.size > 5 * 1024 * 1024) return setError(t("work.import.tooBig"));
    const text = await f.text();
    if (/\.json$/i.test(f.name) || /^\s*\{/.test(text)) {
      // Trello's export has cards and lists; ClickUp's has tasks.
      const p = planTrelloJson(text, people()) ?? planClickUpJson(text, people());
      if (!p) return setError(t("work.import.badJson"));
      if (!p.tasks.length) return setError(t("work.import.empty"));
      return setPlan(p);
    }
    replan(text, undefined, {});
  };

  const groups = plan?.system === "clickup" ? [...new Set(plan.tasks.map((x) => x.group).filter((g): g is string => !!g))] : [];
  const tasks = (plan?.tasks ?? []).slice(0, MAX);
  const pages = notion && withPages ? notion.pages : [];

  const importInto = async (pid: string, rows: ImportTask[]) =>
    api<{ created: number; unassigned: number }>(`work/projects/${pid}/import`, {
      method: "POST",
      body: { system: plan!.system, tasks: rows.map(({ assigneeLabel: _l, group: _g, ...task }) => task) },
    });

  const importPages = async (): Promise<{ docs: number; space: string }> => {
    const name = "Notion";
    let space: { id: string; name: string } | null = null;
    // Space keys are unique; the first free NOTION, NOTION2… wins.
    for (let i = 1; i <= 9 && !space; i++) {
      space = await api<{ id: string; name: string }>("work/spaces", { method: "POST", body: { key: i === 1 ? "NOTION" : `NOTION${i}`, name } }).catch(() => null);
    }
    const ids = new Map<string, string>();
    let docs = 0;
    for (const pg of pages) {
      const parentId = pg.parentPath ? (ids.get(pg.parentPath) ?? null) : null;
      const body = space
        ? { title: pg.title, content: pg.markdown, format: "markdown", spaceId: space.id, parentId }
        : // No space (no right to create one): flat pages in this project instead.
          { title: pg.title, content: pg.markdown, format: "markdown", projectId, visibility: "project" };
      const d = await api<{ id: string }>("work/docs", { method: "POST", body });
      ids.set(pg.path, d.id);
      docs++;
    }
    return { docs, space: space?.name ?? "" };
  };

  const run = async () => {
    setBusy(true);
    setError(null);
    const out: Done = { created: 0, unassigned: 0, projects: 0, docs: 0, space: null };
    try {
      if (plan && tasks.length) {
        if (perList && groups.length > 1) {
          for (const g of groups) {
            const pr = await api<{ id: string }>("work/projects", { method: "POST", body: { name: g.slice(0, 120) } });
            out.projects++;
            const r = await importInto(
              pr.id,
              tasks.filter((x) => x.group === g),
            );
            out.created += r.created;
            out.unassigned += r.unassigned;
          }
          const rest = tasks.filter((x) => !x.group);
          if (rest.length) {
            const r = await importInto(projectId, rest);
            out.created += r.created;
            out.unassigned += r.unassigned;
          }
        } else {
          const r = await importInto(projectId, tasks);
          out.created += r.created;
          out.unassigned += r.unassigned;
        }
      }
    } catch {
      setBusy(false);
      return setError(t("work.import.failed"));
    }
    if (pages.length) {
      try {
        const r = await importPages();
        out.docs = r.docs;
        out.space = r.space;
      } catch {
        setError(t("work.import.docsFailed"));
      }
    }
    setDone(out);
    setBusy(false);
    router.refresh();
  };

  const counts = plan ? (["todo", "in_progress", "review", "done"] as const).map((s) => [s, plan.tasks.filter((x) => x.status === s).length] as const) : [];
  const subtasks = plan?.tasks.filter((x) => x.parentKey).length ?? 0;
  const mapOptions = [{ value: "-1", label: t("work.import.mapNone") }, ...(plan?.headers ?? []).map((h, i) => ({ value: String(i), label: h || `#${i + 1}` }))];
  const canRun = tasks.length > 0 || pages.length > 0;

  return (
    <Modal
      title={t("work.import.title")}
      onClose={onClose}
      wide
      footer={
        done ? (
          <button type="button" className={btnPrimary} onClick={onClose}>
            {t("common.close")}
          </button>
        ) : (
          <>
            <button type="button" className={btn} onClick={onClose}>
              {t("common.cancel")}
            </button>
            <button type="button" className={btnPrimary} disabled={!canRun || busy} onClick={() => void run()}>
              {busy
                ? t("work.import.importing")
                : tasks.length
                  ? t("work.import.run", { count: tasks.length })
                  : pages.length
                    ? t("work.import.runPages", { count: pages.length })
                    : // Nothing picked yet: name the action, not "Import 0 pages".
                      t("work.import.runEmpty")}
            </button>
          </>
        )
      }
    >
      {done ? (
        <div role="status" className="bg-ok-wash text-ok grid gap-1 rounded-md px-3 py-2 text-sm font-medium">
          {done.created || !done.docs ? (
            <p className="m-0">
              {t("work.import.done", { count: done.created })}
              {done.unassigned ? ` ${t("work.import.doneUnassigned", { count: done.unassigned })}` : ""}
            </p>
          ) : null}
          {done.projects ? <p className="m-0">{t("work.import.doneProjects", { count: done.projects })}</p> : null}
          {done.docs ? <p className="m-0">{t("work.import.doneDocs", { count: done.docs, space: done.space || "—" })}</p> : null}
          {error ? <p className="text-block m-0">{error}</p> : null}
        </div>
      ) : (
        <div className="grid gap-4">
          <p className="text-ink-2 m-0 text-sm">{t("work.import.intro")}</p>
          <p className="text-ink-2 m-0 text-xs">{t("work.import.scope", { count: MAX })}</p>
          <div>
            <label htmlFor={fileId} className="mb-1 block text-sm font-semibold">
              {t("work.import.file")}
            </label>
            <input
              id={fileId}
              type="file"
              accept=".csv,text/csv,.json,application/json,.zip,application/zip"
              onChange={(e) => void read(e.target.files?.[0])}
              className="text-sm"
            />
          </div>
          {error ? (
            <p role="alert" className="bg-block-wash text-block m-0 rounded-md px-3 py-2 text-sm">
              {error}
            </p>
          ) : null}
          {notion ? (
            <section className="grid gap-2 text-sm">
              {notion.databases.length > 1 ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{t("work.import.notionDb")}</span>
                  <Picker
                    variant="button"
                    label={t("work.import.notionDb")}
                    value={String(db)}
                    onChange={(v) => {
                      setDb(Number(v));
                      replan(notion.databases[Number(v)]!.csv, "notion", {});
                    }}
                    options={notion.databases.map((d, i) => ({ value: String(i), label: `${d.name} (${d.rows})` }))}
                  />
                </div>
              ) : !notion.databases.length ? (
                <p className="text-ink-2 m-0">{t("work.import.notionNoDb")}</p>
              ) : null}
              {notion.pages.length ? (
                <Checkbox checked={withPages} onChange={(e) => setWithPages(e.target.checked)} label={t("work.import.notionPages", { count: notion.pages.length })} />
              ) : null}
              {notion.images ? <p className="text-ink-2 m-0 text-xs">{t("work.import.notionImages", { count: notion.images })}</p> : null}
            </section>
          ) : null}
          {plan?.headers.length ? (
            <details className="text-sm">
              <summary className="cursor-pointer font-medium">{t("work.import.mapping")}</summary>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {MAPPABLE.map((f) => (
                  <div key={f} className="flex items-center gap-2">
                    <span className="text-ink-2 w-24 shrink-0">{t(`work.import.field_${f}` as MessageKey)}</span>
                    <Picker
                      variant="button"
                      label={t(`work.import.field_${f}` as MessageKey)}
                      value={String(plan.columns[f] ?? -1)}
                      onChange={(v) => csv && replan(csv.text, csv.system, { ...csv.columns, [f]: Number(v) })}
                      options={mapOptions}
                    />
                  </div>
                ))}
              </div>
            </details>
          ) : null}
          {plan && plan.tasks.length ? (
            <section aria-label={t("work.import.preview")} className="grid gap-3">
              <p className="m-0 text-sm">
                <b>{t(`work.import.from_${plan.system}` as MessageKey)}</b> · {t("work.import.found", { count: plan.tasks.length })}
                {subtasks ? ` · ${t("work.import.subtasks", { count: subtasks })}` : ""}
                {plan.skipped ? ` · ${t("work.import.skipped", { count: plan.skipped })}` : ""}
                {plan.tasks.length > MAX ? ` · ${t("work.import.limit", { count: MAX })}` : ""}
              </p>
              <p className="text-ink-2 m-0 flex flex-wrap gap-x-4 text-sm">
                {counts.map(([s, n]) => (
                  <span key={s}>
                    {t(`work.import.status_${s}` as MessageKey)}: <b className="text-ink tabular-nums">{n}</b>
                  </span>
                ))}
              </p>
              {groups.length > 1 ? <Checkbox checked={perList} onChange={(e) => setPerList(e.target.checked)} label={t("work.import.perList", { count: groups.length })} /> : null}
              {plan.unknownPeople.length ? (
                <p className="bg-warn-wash text-warn m-0 rounded-md px-3 py-2 text-sm">
                  {t("work.import.unknownPeople", { names: plan.unknownPeople.slice(0, 5).join(", "), count: plan.unknownPeople.length })}
                </p>
              ) : null}
              <div className="max-h-64 overflow-auto rounded-lg">
                <table className={cx(table, "text-xs")}>
                  <thead>
                    <tr>
                      <th>{t("work.import.colTitle")}</th>
                      <th>{t("work.import.colStatus")}</th>
                      <th>{t("work.import.colAssignee")}</th>
                      <th>{t("work.import.colDue")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.tasks.slice(0, 8).map((x, i) => (
                      <tr key={i}>
                        <td className="max-w-[260px] truncate">
                          {x.parentKey ? (
                            <span className="text-ink-2 mr-1" aria-hidden="true">
                              ↳
                            </span>
                          ) : null}
                          {x.key ? <span className="text-ink-2 mr-1.5 font-mono">{x.key}</span> : null}
                          {x.title}
                        </td>
                        <td>{t(`work.import.status_${x.status}` as MessageKey)}</td>
                        <td>{x.assigneeId ? dir.name(x.assigneeId) : <span className="text-ink-2">{x.assigneeLabel ?? "—"}</span>}</td>
                        <td className="tabular-nums">{x.dueAt ? dayInline(x.dueAt) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}
        </div>
      )}
    </Modal>
  );
}
