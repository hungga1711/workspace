"use client";

import { IconTile } from "@/components/ui/Bento";
import { DownloadIcon } from "@/components/app/icons";
import { useState } from "react";
import { api } from "@/lib/client";
import { useFormat, useT } from "@/lib/i18n/client";
import { IMPORT_CHUNK, IMPORT_FIELDS, guessMapping, readTable, toImportRows, type ImportField, type Mapping, type Table } from "@/lib/ai-import";
import { assignRows, readExport, type ExportResult } from "@/lib/ai-export";
import { btn, btnGhost, btnPrimary, btnSm, cx, input } from "@/lib/ui";

export interface AiImportLog {
  id: string;
  filename: string;
  total: number;
  imported: number;
  duplicate: number;
  unmatched: number;
  invalid: number;
  at: string;
}
interface Result {
  importId: string;
  imported: number;
  duplicate: number;
  unmatched: number;
  invalid: number;
}

/**
 * Admin › AI › Nhập từ bảng điều khiển nhà cung cấp: pick a usage or compliance export, map its columns (guessed
 * from common header names), check the first 20 rows, import in chunks. A ChatGPT or Claude history export (ZIP or
 * conversations.json) needs no mapping: it becomes one row per conversation and day. The file is read here; only
 * the mapped fields of each row are sent. Loaded on demand from the admin page.
 */
export function AiImportAdmin({ history: initial }: { history: AiImportLog[] }) {
  const t = useT();
  const { ago } = useFormat();
  const [name, setName] = useState("");
  const [table, setTable] = useState<Table | null>(null);
  const [map, setMap] = useState<Mapping>({});
  const [exp, setExp] = useState<ExportResult | null>(null);
  const [assignee, setAssignee] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [history, setHistory] = useState(initial);
  const pick = async (file: File | undefined) => {
    setMsg(null);
    if (!file) return;
    setExp(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const found = await readExport(file.name, bytes).catch(() => null);
      if (found) {
        setName(file.name);
        setTable(null);
        setExp(found);
        return;
      }
      const tb = readTable(file.name, new TextDecoder().decode(bytes));
      if (!tb.headers.length) throw new Error("empty");
      setName(file.name);
      setTable(tb);
      setMap(guessMapping(tb.headers));
    } catch {
      setTable(null);
      setMsg({ text: t("aiInsights.import.readFailed"), ok: false });
    }
  };
  const rows = exp ? assignRows(exp.rows, assignee) : table ? toImportRows(table.records, map) : [];
  const ready = exp ? rows.length > 0 : !!map.at && (!!map.email || !!map.userId) && rows.length > 0;
  const total = exp ? exp.rows.length : (table?.records.length ?? 0);
  const run = async () => {
    if (!table && !exp) return;
    const sum = { imported: 0, duplicate: 0, unmatched: 0, invalid: total - rows.length };
    let importId: string | undefined;
    setProgress({ done: 0, total: rows.length });
    try {
      for (let i = 0; i < rows.length; i += IMPORT_CHUNK) {
        const r = await api<Result>("ai/insights/imports", {
          method: "POST",
          body: { importId, filename: name, format: table?.format ?? "json", mapping: exp ? {} : map, rows: rows.slice(i, i + IMPORT_CHUNK), total },
        });
        importId = r.importId;
        sum.imported += r.imported;
        sum.duplicate += r.duplicate;
        sum.unmatched += r.unmatched;
        sum.invalid += r.invalid;
        setProgress({ done: Math.min(i + IMPORT_CHUNK, rows.length), total: rows.length });
      }
      setMsg({ text: t("aiInsights.import.result", sum), ok: true });
      setTable(null);
      setExp(null);
      const h = await api<{ imports: AiImportLog[] }>("ai/insights/imports").catch(() => null);
      if (h) setHistory(h.imports);
    } catch {
      setMsg({ text: t("aiInsights.import.failed"), ok: false });
    } finally {
      setProgress(null);
    }
  };
  const undo = async (id: string) => {
    const r = await api<{ removed: number }>(`ai/insights/imports/${id}`, { method: "DELETE" }).catch(() => null);
    if (!r) return setMsg({ text: t("aiInsights.import.failed"), ok: false });
    setMsg({ text: t("aiInsights.import.undone", { count: r.removed }), ok: true });
    setHistory((h) => h.map((x) => (x.id === id ? { ...x, imported: 0 } : x)));
  };
  const shown: ImportField[] = exp ? ["email", "at", "title", "count"] : IMPORT_FIELDS.filter((f) => map[f]);
  return (
    <section className="grid gap-4" aria-labelledby="ai-import-h" data-testid="ai-import-admin">
      <div className="grid gap-1">
        <h2 id="ai-import-h" className="m-0 flex min-w-0 items-center gap-3 text-sm/6 font-semibold tracking-[-0.01em]">
          <IconTile tone="rose">
            <DownloadIcon />
          </IconTile>
          {t("aiInsights.import.title")}
        </h2>
        <p className="text-ink-2 m-0 text-sm">{t("aiInsights.import.sub")}</p>
      </div>
      <div className="bg-surface shadow-card grid gap-4 rounded-xl p-4">
        {/* The browser's own file control reads "Choose File / No file chosen" in its language, not the app's. */}
        <div className="grid gap-1.5 text-sm">
          <span className="font-medium">{t("aiInsights.import.choose")}</span>
          <span className="flex min-w-0 items-center gap-3">
            <label className={cx(btn, btnSm, "cursor-pointer has-[:focus-visible]:ring-2")}>
              {t("common.chooseFile")}
              <input
                type="file"
                accept=".csv,.json,.zip,text/csv,application/json,application/zip"
                aria-label={t("aiInsights.import.choose")}
                className="sr-only"
                onChange={(e) => void pick(e.target.files?.[0])}
                data-testid="ai-import-file"
              />
            </label>
            <span className="text-ink-2 min-w-0 truncate">{name || t("common.noFile")}</span>
          </span>
        </div>
        {exp ? (
          <div className="grid gap-2 text-sm" data-testid="ai-import-export">
            <p className="m-0 font-medium">
              {t("aiInsights.import.exportFound", {
                tool: exp.kind === "chatgpt" ? "ChatGPT" : "Claude",
                conversations: exp.conversations,
                count: new Set(exp.rows.map((r) => r.at.slice(0, 10))).size,
              })}
            </p>
            {exp.unassigned ? (
              <label className="grid gap-1 text-xs sm:max-w-sm">
                <span className="text-ink-2">{t("aiInsights.import.exportAssign", { count: exp.unassigned })}</span>
                <input
                  type="email"
                  className={cx(input, "h-8 text-sm")}
                  value={assignee}
                  placeholder={t("aiInsights.import.exportAssignPh")}
                  onChange={(e) => setAssignee(e.target.value)}
                  data-testid="ai-import-assignee"
                />
              </label>
            ) : null}
            <p className="text-ink-2 m-0 text-xs">{t("aiInsights.import.exportPrivacy")}</p>
          </div>
        ) : null}
        {table || exp ? (
          <>
            {table ? (
              <fieldset className="m-0 grid gap-2 border-0 p-0 sm:grid-cols-2">
                <legend className="mb-1 text-sm font-medium">{t("aiInsights.import.mapping")}</legend>
                {IMPORT_FIELDS.map((f) => (
                  <label key={f} className="grid grid-cols-[9rem_minmax(0,1fr)] items-center gap-2 text-xs">
                    <span className="text-ink-2">{t(`aiInsights.import.field.${f}`)}</span>
                    <select className={cx(input, "h-8 py-0 text-sm")} value={map[f] ?? ""} onChange={(e) => setMap({ ...map, [f]: e.target.value || undefined })}>
                      <option value="">{t("aiInsights.import.none")}</option>
                      {table.headers.map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </fieldset>
            ) : null}
            <div className="grid gap-1">
              <p className="text-ink-2 m-0 text-xs">
                {t("aiInsights.import.preview")} · {t("aiInsights.import.rows", { count: rows.length })}
              </p>
              <div className="border-hairline overflow-x-auto rounded-lg border">
                <table className="w-full text-left text-xs">
                  <thead className="text-ink-2">
                    <tr>
                      {shown.map((f) => (
                        <th key={f} className="whitespace-nowrap px-2 py-1.5 font-medium">
                          {t(`aiInsights.import.field.${f}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 20).map((r, i) => (
                      <tr key={i} className="border-hairline border-t">
                        {shown.map((f) => (
                          <td key={f} className="max-w-56 truncate px-2 py-1.5">
                            {String(r[f] ?? "")}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            {!ready && table ? <p className="text-warn m-0 text-xs">{t("aiInsights.import.needFields")}</p> : null}
            <button type="button" className={cx(btnPrimary, btnSm, "justify-self-start")} disabled={!ready || !!progress} onClick={() => void run()} data-testid="ai-import-start">
              {progress ? t("aiInsights.import.importing", progress) : `${t("aiInsights.import.start")} · ${t("aiInsights.import.rows", { count: rows.length })}`}
            </button>
          </>
        ) : null}
        {msg ? (
          <p className={cx("m-0 text-sm", msg.ok ? "text-ok" : "text-block")} role="status">
            {msg.text}
          </p>
        ) : null}
      </div>
      {history.length ? (
        <div className="grid gap-1">
          <p className="text-ink-2 m-0 text-xs font-medium">{t("aiInsights.import.history")}</p>
          <ul className="divide-hairline shadow-card bg-surface m-0 grid list-none divide-y rounded-xl p-0 px-4">
            {history.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{h.filename || "—"}</span>
                <span className="text-ink-2 text-xs tabular-nums">
                  {t("aiInsights.import.result", { imported: h.imported, duplicate: h.duplicate, unmatched: h.unmatched, invalid: h.invalid })}
                </span>
                <span className="text-ink-2 text-xs">{ago(h.at)}</span>
                {h.imported ? (
                  <button type="button" className={cx(btnGhost, btnSm)} onClick={() => void undo(h.id)}>
                    {t("aiInsights.import.undo")}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
