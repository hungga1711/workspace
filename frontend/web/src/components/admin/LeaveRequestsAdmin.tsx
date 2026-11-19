"use client";

import { CalmEmpty } from "./AdminBits";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useT } from "@/lib/i18n/client";
import { api } from "@/lib/client";
import { useDirectory } from "@/lib/people";
import { btn, btnGhost, btnPrimary, btnSm, chipBlock, chipWarn, control, cx, table, tableScroll, textarea } from "@/lib/ui";
import { Checkbox } from "@/components/ui/Checkbox";
import { Modal } from "@/components/ui/Modal";
import { Field } from "@/components/ui/bits";
import { Picker } from "@/components/ui/Picker";
import { AdminHeader } from "./AdminNav";

export interface LeaveRequestRow {
  id: string;
  userId: string;
  displayName: string | null;
  department: string | null;
  type: string;
  startDate: string;
  endDate: string;
  days: number;
  status: "pending" | "approved" | "rejected" | "cancelled";
  reason: string;
  createdAt: string;
  approverId: string | null;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionNote: string | null;
}
export interface RequestFilter {
  status: string;
  userId: string;
  departmentId: string;
  from: string;
  to: string;
}

const dmy = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

/** Every leave request in the company, filtered by status, person, department and dates; decide with a note. */
export function LeaveRequestsAdmin({
  rows,
  types,
  departments,
  filter,
}: {
  rows: LeaveRequestRow[];
  types: Record<string, string>;
  departments: { id: string; name: string }[];
  filter: RequestFilter;
}) {
  const tx = useT();
  const router = useRouter();
  const dir = useDirectory();
  const [deciding, setDeciding] = useState<{ row: LeaveRequestRow; decision: "approved" | "rejected" } | null>(null);
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "err" } | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [reminded, setReminded] = useState<Set<string>>(new Set());
  const today = new Date().toISOString().slice(0, 10);
  const pending = rows.filter((r) => r.status === "pending");
  const waited = (r: LeaveRequestRow) => Math.floor((Date.now() - Date.parse(r.createdAt)) / 86400_000);
  // Approves the picked requests one by one (each goes through the same checks as a single decision) and says how many went through.
  const approvePicked = async () => {
    setBusy(true);
    let ok = 0;
    for (const id of picked)
      await api(`employee/leave/${id}/decision`, { method: "POST", body: { decision: "approved" } })
        .then(() => ok++)
        .catch(() => undefined);
    setBusy(false);
    setPicked(new Set());
    setMsg({ tone: ok === picked.size ? "ok" : "err", text: tx("admin.leaverequests.bulkDone", { ok, total: picked.size }) });
    router.refresh();
  };
  const remind = async (r: LeaveRequestRow) => {
    try {
      await api(`employee/leave/${r.id}/remind`, { method: "POST" });
      setReminded((x) => new Set(x).add(r.id));
      setMsg({ tone: "ok", text: tx("admin.leaverequests.reminded", { p0: dir.name(r.approverId ?? "") }) });
    } catch (e) {
      const err = (e as { body?: { error?: string } }).body?.error;
      setMsg({ tone: "err", text: err === "reminded_recently" ? tx("admin.leaverequests.remindedRecently") : tx("admin.leaverequests.chua_quyet_dinh_duoc") });
    }
  };
  const go = (patch: Partial<RequestFilter>) => {
    const q = new URLSearchParams(Object.entries({ ...filter, ...patch }).filter(([, v]) => v) as [string, string][]);
    router.push(`/admin/workspace/leave/requests${q.size ? `?${q}` : ""}`);
  };
  const STATUS: Record<string, string> = {
    pending: tx("admin.leaverequests.cho_duyet"),
    approved: tx("admin.leaverequests.da_duyet"),
    rejected: tx("admin.leaverequests.tu_choi"),
    cancelled: tx("admin.leaverequests.da_huy"),
    all: tx("admin.leaverequests.tat_ca"),
  };
  const tone: Record<string, string> = { pending: "text-warn", approved: "text-ok", rejected: "text-block", cancelled: "text-ink-2" };
  const pickBox = (r: LeaveRequestRow, name: string) => (
    <>
      {r.status === "pending" ? (
        <Checkbox
          aria-label={tx("admin.leaverequests.pick", { p0: name })}
          checked={picked.has(r.id)}
          onChange={(e) =>
            setPicked((x) => {
              const n = new Set(x);
              if (e.target.checked) n.add(r.id);
              else n.delete(r.id);
              return n;
            })
          }
        />
      ) : null}
    </>
  );
  const statusBlock = (r: LeaveRequestRow) => (
    <>
      <span className={tone[r.status]}>{STATUS[r.status] ?? r.status}</span>
      {r.status !== "pending" && r.decidedBy ? (
        <span className="text-ink-2 block text-xs">
          {tx("admin.leaverequests.boi", { p0: dir.name(r.decidedBy) })}
          {r.decisionNote ? ` · ${r.decisionNote}` : ""}
        </span>
      ) : null}
      {r.status === "pending" && r.approverId ? <span className="text-ink-2 block text-xs">{tx("admin.leaverequests.nguoi_duyet", { p0: dir.name(r.approverId) })}</span> : null}
      {/* Overdue: the leave already started while still waiting, or nobody decided for 3+ days. */}
      {r.status === "pending" && r.startDate <= today ? (
        <span className={cx(chipBlock, "mt-1")}>{tx("admin.leaverequests.startedWaiting")}</span>
      ) : r.status === "pending" && waited(r) >= 3 ? (
        <span className={cx(chipWarn, "mt-1")}>{tx("admin.leaverequests.waitingDays", { count: waited(r) })}</span>
      ) : null}
    </>
  );
  const actions = (r: LeaveRequestRow) => (
    <>
      {r.approverId && (r.startDate <= today || waited(r) >= 1) ? (
        <button type="button" className={cx(btnGhost, btnSm)} disabled={reminded.has(r.id)} onClick={() => void remind(r)}>
          {reminded.has(r.id) ? tx("admin.leaverequests.remindedShort") : tx("admin.leaverequests.remind")}
        </button>
      ) : null}
      <button type="button" className={cx(btn, btnSm)} onClick={() => setDeciding({ row: r, decision: "rejected" })}>
        {tx("admin.leaverequests.tu_choi_nut")}
      </button>
      <button type="button" className={cx(btnPrimary, btnSm)} onClick={() => setDeciding({ row: r, decision: "approved" })}>
        {tx("admin.leaverequests.duyet")}
      </button>
    </>
  );
  return (
    <>
      <AdminHeader
        title={tx("admin.leaverequests.don_nghi")}
        sub={tx("admin.leaverequests.mo_ta")}
        actions={
          picked.size ? (
            <button type="button" className={btnPrimary} disabled={busy} onClick={() => void approvePicked()}>
              {tx("admin.leaverequests.approvePicked", { count: picked.size })}
            </button>
          ) : undefined
        }
      />
      {msg ? (
        <p className={cx("mb-4 rounded-lg px-3 py-2 text-sm", msg.tone === "ok" ? "bg-ok-wash text-ok" : "bg-block-wash text-block")} role="status">
          {msg.text}
        </p>
      ) : null}
      <div className="mb-4 flex flex-wrap items-end gap-2">
        <Picker
          variant="button"
          label={tx("admin.leaverequests.trang_thai")}
          value={filter.status}
          onChange={(v) => go({ status: v })}
          options={Object.entries(STATUS).map(([value, label]) => ({ value, label }))}
        />
        <Picker
          variant="button"
          label={tx("admin.leaverequests.nguoi")}
          value={filter.userId}
          onChange={(v) => go({ userId: v })}
          options={[
            { value: "", label: tx("admin.leaverequests.moi_nguoi") },
            ...dir.people.filter((p) => p.status !== "disabled").map((p) => ({ value: p.userId, label: p.displayName })),
          ]}
        />
        <Picker
          variant="button"
          label={tx("admin.leaverequests.phong_ban")}
          value={filter.departmentId}
          onChange={(v) => go({ departmentId: v })}
          options={[{ value: "", label: tx("admin.leaverequests.moi_phong_ban") }, ...departments.map((d) => ({ value: d.id, label: d.name }))]}
        />
        <label className="grid gap-1 text-xs">
          <span className="text-ink-2">{tx("admin.leaverequests.tu_ngay")}</span>
          <input type="date" className={cx(control, "h-9 min-h-0 w-40")} value={filter.from} onChange={(e) => go({ from: e.target.value })} />
        </label>
        <label className="grid gap-1 text-xs">
          <span className="text-ink-2">{tx("admin.leaverequests.den_ngay")}</span>
          <input type="date" className={cx(control, "h-9 min-h-0 w-40")} value={filter.to} onChange={(e) => go({ to: e.target.value })} />
        </label>
      </div>
      {rows.length === 0 ? (
        <CalmEmpty title={tx("admin.leaverequests.khong_co_don")} />
      ) : (
        <>
          {/* Phones and tablets: one card per request, with dates and the decision buttons in reach (at 768 the table pushed
              Reject off the edge). */}
          <ul className="bg-surface shadow-card divide-divider-soft m-0 list-none divide-y overflow-hidden rounded-xl p-0 lg:hidden">
            {rows.map((r) => {
              const name = r.displayName ?? dir.name(r.userId);
              return (
                <li key={r.id} className="grid gap-2 px-4 py-3 text-sm">
                  <div className="flex items-start gap-3">
                    {pickBox(r, name)}
                    <div className="min-w-0 flex-1">
                      <span className="block font-medium">{name}</span>
                      <span className="text-ink-2 block text-xs">
                        {types[r.type] ?? r.type} · {r.department ?? "—"}
                      </span>
                    </div>
                    <span className="text-ink-2 shrink-0 text-xs tabular-nums">{tx("admin.leaverequests.daysShort", { count: r.days })}</span>
                  </div>
                  <span className="tabular-nums">{r.startDate === r.endDate ? dmy(r.startDate) : `${dmy(r.startDate)} – ${dmy(r.endDate)}`}</span>
                  {r.reason ? <span className="text-ink-2 text-xs">{r.reason}</span> : null}
                  <div className="text-sm">{statusBlock(r)}</div>
                  {r.status === "pending" ? <div className="flex flex-wrap justify-end gap-1.5">{actions(r)}</div> : null}
                </li>
              );
            })}
          </ul>
          <div className="bg-surface shadow-card overflow-x-auto rounded-xl max-lg:hidden">
            {/* Below 1280px the type and reason go under the name, so the dates, status and actions fit without scrolling. */}
            <table className={cx(table, tableScroll, "max-lg:[&_th]:!whitespace-normal")}>
              <thead>
                <tr>
                  <th className="w-8">
                    {pending.length ? (
                      <Checkbox
                        aria-label={tx("admin.leaverequests.pickAll")}
                        checked={pending.length > 0 && pending.every((r) => picked.has(r.id))}
                        onChange={(e) => setPicked(e.target.checked ? new Set(pending.map((r) => r.id)) : new Set())}
                      />
                    ) : null}
                  </th>
                  <th>{tx("admin.leaverequests.nguoi")}</th>
                  <th className="max-xl:hidden">{tx("admin.leaverequests.loai")}</th>
                  <th>{tx("admin.leaverequests.thoi_gian")}</th>
                  <th className="text-right!">{tx("admin.leaverequests.so_ngay")}</th>
                  <th>{tx("admin.leaverequests.trang_thai")}</th>
                  <th>
                    <span className="sr-only">{tx("admin.leaverequests.thao_tac")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const name = r.displayName ?? dir.name(r.userId);
                  return (
                    <tr key={r.id}>
                      <td>{pickBox(r, name)}</td>
                      <td className="max-xl:!whitespace-normal">
                        <span className="block font-medium">{name}</span>
                        <span className="text-ink-2 text-xs">{r.department ?? "—"}</span>
                        <span className="text-ink-2 block text-xs xl:hidden">
                          {types[r.type] ?? r.type}
                          {r.reason ? ` · ${r.reason}` : ""}
                        </span>
                      </td>
                      <td className="max-xl:hidden">
                        {types[r.type] ?? r.type}
                        {r.reason ? <span className="text-ink-2 block text-xs">{r.reason}</span> : null}
                      </td>
                      <td className="tabular-nums max-lg:!whitespace-normal">{r.startDate === r.endDate ? dmy(r.startDate) : `${dmy(r.startDate)} – ${dmy(r.endDate)}`}</td>
                      <td className="text-right tabular-nums">{r.days}</td>
                      <td className="text-sm">{statusBlock(r)}</td>
                      <td className="whitespace-nowrap text-right">{r.status === "pending" ? <span className="inline-flex gap-1.5">{actions(r)}</span> : null}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
      {deciding ? (
        <DecideModal
          {...deciding}
          name={deciding.row.displayName ?? dir.name(deciding.row.userId)}
          onClose={() => setDeciding(null)}
          onDone={(text, ok) => {
            setDeciding(null);
            setMsg({ text, tone: ok ? "ok" : "err" });
            if (ok) router.refresh();
          }}
        />
      ) : null}
    </>
  );
}

function DecideModal({
  row,
  decision,
  name,
  onClose,
  onDone,
}: {
  row: LeaveRequestRow;
  decision: "approved" | "rejected";
  name: string;
  onClose: () => void;
  onDone: (text: string, ok: boolean) => void;
}) {
  const tx = useT();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await api(`employee/leave/${row.id}/decision`, { method: "POST", body: { decision, note: note.trim() || undefined } });
      onDone(decision === "approved" ? tx("admin.leaverequests.da_duyet_don", { p0: name }) : tx("admin.leaverequests.da_tu_choi_don", { p0: name }), true);
    } catch (e) {
      const err = (e as { body?: { error?: string } }).body?.error;
      onDone(
        err === "insufficient_balance"
          ? tx("admin.leaverequests.khong_du_phep", { p0: name })
          : err === "already_decided"
            ? tx("admin.leaverequests.da_quyet_dinh")
            : tx("admin.leaverequests.chua_quyet_dinh_duoc"),
        false,
      );
    }
  };
  return (
    <Modal
      title={decision === "approved" ? tx("admin.leaverequests.duyet_don_cua", { p0: name }) : tx("admin.leaverequests.tu_choi_don_cua", { p0: name })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btn} onClick={onClose}>
            {tx("admin.leaverequests.huy")}
          </button>
          <button type="button" className={btnPrimary} disabled={busy || (decision === "rejected" && !note.trim())} onClick={() => void submit()}>
            {decision === "approved" ? tx("admin.leaverequests.duyet") : tx("admin.leaverequests.tu_choi_nut")}
          </button>
        </>
      }
    >
      {/* A refusal needs a reason (the person reads it); for an approval the note stays optional. */}
      <Field label={decision === "rejected" ? tx("ui.reason.label") : tx("admin.leaverequests.ghi_chu")} hint={tx("admin.leaverequests.ghi_chu_goi_y")}>
        <textarea className={textarea} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} autoFocus />
      </Field>
    </Modal>
  );
}
