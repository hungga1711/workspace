"use client";

import { useT, useFormat } from "@/lib/i18n/client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { diffLines } from "@/lib/diff";
import { Markdown } from "@/lib/markdown";
import { Avatar, useDirectory } from "@/lib/people";
import { btn, btnPrimary, btnSm, cx } from "@/lib/ui";
import { Drawer } from "@/components/ui/Drawer";

interface Version {
  version: number;
  authorId: string;
  createdAt: string;
  length: number;
}

/** Version history: who saved what, compare with the current text, restore as a new version. */
export function DocHistory({
  docId,
  current,
  currentText,
  dirty,
  onRestored,
  onClose,
}: {
  docId: string;
  current: number;
  currentText: string;
  dirty: boolean;
  onRestored: (d: { version: number; content: string }) => void;
  onClose: () => void;
}) {
  const { ago } = useFormat();
  const tx = useT();
  const dir = useDirectory();
  const [versions, setVersions] = useState<Version[] | null>(null);
  // `text`: the version as plain text (rich-text pages), which is what is compared and shown.
  const [open, setOpen] = useState<{ version: number; content: string; text: string } | null>(null);
  const [view, setView] = useState<"diff" | "text">("diff");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void api<{ versions: Version[] }>(`work/docs/${docId}/versions`)
      .then((r) => setVersions(r.versions))
      .catch(() => setVersions([]));
  }, [docId, current]);
  const show = async (v: number) => {
    setError(null);
    const r = await api<{ content: string; text?: string }>(`work/docs/${docId}?version=${v}`);
    setOpen({ version: v, content: r.content, text: r.text ?? r.content });
  };
  const restore = async () => {
    if (!open) return;
    try {
      const d = await api<{ current_version: number }>(`work/docs/${docId}/restore`, { method: "POST", body: { version: open.version, baseVersion: current } });
      onRestored({ version: d.current_version, content: open.content });
    } catch (e) {
      setError(
        (e as { status?: number }).status === 409
          ? tx("work.dochistory.co_nguoi_vua_luu")
          : (e as { status?: number }).status === 403
            ? tx("work.dochistory.ban_chi_co_quyen")
            : tx("work.dochistory.chua_khoi_phuc_duoc"),
      );
    }
  };
  const plain = (s: string) =>
    s.trimStart().startsWith("<")
      ? s
          .replace(/<\/(p|h[1-6]|li|tr|div|blockquote|pre)>/gi, "\n")
          .replace(/<[^>]+>/g, "")
          .replace(/&nbsp;/g, " ")
          .replace(/\n{2,}/g, "\n")
          .trim()
      : s;
  const diff = open && view === "diff" ? diffLines(open.text, plain(currentText)) : null;
  return (
    <Drawer title={tx("work.dochistory.lich_su_phien_ban")} onClose={onClose} padded>
      {versions === null ? (
        <p className="text-ink-2 text-sm">{tx("work.dochistory.dang_tai")}</p>
      ) : (
        <ol className="m-0 grid list-none gap-1 p-0" aria-label={tx("work.dochistory.cac_phien_ban")}>
          {versions.map((v) => (
            <li key={v.version}>
              <button
                type="button"
                onClick={() => void show(v.version)}
                aria-current={open?.version === v.version}
                className={cx("hover:bg-hover flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left text-sm", open?.version === v.version && "bg-brand-wash")}
              >
                <Avatar id={v.authorId} size="xs" />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{tx("work.dochistory.phien_ban_2", { p0: v.version, p1: v.version === current ? tx("work.dochistory.hien_tai") : "" })}</span>
                  <span className="text-ink-2 text-xs">
                    {dir.name(v.authorId)} · {ago(v.createdAt)}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
      {/* One version is the page as first published: say where the others will come from. */}
      {versions?.length === 1 ? <p className="text-ink-2 m-0 mt-3 px-2 text-sm">{tx("work.dochistory.onlyOne")}</p> : null}
      {open ? (
        <section className="border-hairline mt-4 border-t pt-4" aria-label={tx("work.dochistory.phien_ban", { p0: open.version })}>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="border-hairline flex rounded-md border p-0.5 text-xs" role="tablist" aria-label={tx("work.dochistory.cach_xem")}>
              {(
                [
                  ["diff", tx("work.dochistory.so_voi_hien_tai")],
                  ["text", tx("work.dochistory.noi_dung")],
                ] as const
              ).map(([k, l]) => (
                <button
                  key={k}
                  type="button"
                  role="tab"
                  aria-selected={view === k}
                  onClick={() => setView(k)}
                  className={cx("rounded-sm px-2.5 py-1", view === k ? "bg-brand-wash text-ink font-semibold" : "text-ink-2")}
                >
                  {l}
                </button>
              ))}
            </div>
            <span className="flex-1" />
            {open.version !== current ? (
              <button
                type="button"
                className={cx(btnPrimary, btnSm)}
                disabled={dirty}
                title={dirty ? tx("work.dochistory.luu_hoac_bo_thay") : undefined}
                onClick={() => void restore()}
              >
                {tx("work.dochistory.khoi_phuc_phien_ban")}
              </button>
            ) : null}
          </div>
          {dirty && open.version !== current ? <p className="text-ink-2 mb-2 text-xs">{tx("work.dochistory.unsaved_note")}</p> : null}
          {error ? (
            <p className="text-block mb-2 text-sm" role="alert">
              {error}
            </p>
          ) : null}
          {diff ? (
            <pre
              className="bg-surface shadow-card m-0 max-h-[50vh] overflow-auto whitespace-pre-wrap rounded-lg p-2.5 font-mono text-xs/[1.6]"
              aria-label={tx("work.dochistory.so_sanh")}
            >
              {diff.every((l) => l.type === "same") ? (
                <span className="text-ink-2">{tx("work.dochistory.giong_het_noi_dung")}</span>
              ) : (
                diff.map((l, i) => (
                  <span key={i} className={cx("block px-1", l.type === "add" ? "bg-ok-wash text-ok" : l.type === "del" ? "bg-block-wash text-block line-through" : "text-ink-2")}>
                    {l.type === "add" ? "+ " : l.type === "del" ? "− " : "  "}
                    {l.text || " "}
                  </span>
                ))
              )}
            </pre>
          ) : (
            <div className="bg-surface shadow-card max-h-[50vh] overflow-auto rounded-lg p-3">
              <Markdown source={open.text} />
            </div>
          )}
          <p className="text-ink-2 mt-2 text-xs">{tx("work.dochistory.dong_xanh_co_o", { p0: open.version, p1: open.version })}</p>
          <button type="button" className={cx(btn, btnSm, "mt-2")} onClick={() => setOpen(null)}>
            {tx("work.dochistory.dong_phien_ban")}
          </button>
        </section>
      ) : null}
    </Drawer>
  );
}
