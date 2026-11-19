"use client";

import { CalmEmpty } from "./AdminBits";
import { IconTile } from "@/components/ui/Bento";
import { useToast } from "@/components/ui/Toast";
import { INTL_TAG } from "@/lib/i18n/config";
import { Checkbox } from "@/components/ui/Checkbox";
import { useLocale } from "@/lib/i18n/client";
import type { T } from "@/lib/i18n/core";
import { useT, useFormat } from "@/lib/i18n/client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { useDirectory } from "@/lib/people";
import { btn, btnPrimary, btnSm, cx, input, table, tableScroll } from "@/lib/ui";
import { Modal } from "@/components/ui/Modal";
import { Field } from "@/components/ui/bits";
import { AdminHeader } from "./AdminNav";
import { Picker } from "@/components/ui/Picker";
import { Drawer } from "@/components/ui/Drawer";
import { BotIcon, PlusIcon, ShieldIcon } from "@/components/app/icons";
import { SCOPE_LABEL } from "./scope-labels";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { useConfirm } from "@/components/ui/Confirm";

interface Agent {
  id: string;
  name: string;
  status: string;
  budget: number;
  grants: { permission: string; scope: string }[];
  allowedTools?: string[];
  description?: string;
}
const TOOLS = (tx: T): Record<string, string> => ({
  search_messages: tx("admin.agentsadmin.tim_trong_tin_nhan"),
  get_thread: tx("admin.agentsadmin.doc_thread"),
  list_my_tasks: tx("admin.agentsadmin.xem_viec_cua_nguoi"),
  create_task: tx("admin.agentsadmin.tao_viec"),
  search_documents: tx("admin.agentsadmin.tim_tai_lieu_viec"),
  get_document: tx("admin.agentsadmin.doc_tai_lieu"),
  project_status: tx("admin.agentsadmin.tinh_hinh_du_an"),
  who_is_out: tx("admin.agentsadmin.xem_ai_nghi_phep"),
});

/** AI agents are security principals: explicit grants, budget, status, and a log of refused tool calls. */
/** The built-in agents' descriptions are stored in Vietnamese; show them in the UI language unless an admin changed them. */
const BUILT_IN: Record<string, ["project" | "research" | "meeting" | "documentation", string]> = {
  "Project Agent": ["project", "Tình hình dự án, việc trễ hạn, tạo việc khi được yêu cầu."],
  "Research Agent": ["research", "Tìm và tổng hợp thông tin từ tài liệu và trao đổi."],
  "Meeting Agent": ["meeting", "Tóm tắt thảo luận, trích việc và quyết định sau họp."],
  "Documentation Agent": ["documentation", "Trả lời câu hỏi dựa trên tài liệu nội bộ, so sánh tài liệu."],
};
const agentDescription = (tx: T, name: string, description: string | undefined) => {
  const b = BUILT_IN[name];
  return b && b[1] === description ? tx(`labels.agentDesc.${b[0]}`) : description;
};

export function AgentsAdmin({
  agents,
  catalog,
  denied,
  usage,
}: {
  agents: Agent[];
  catalog: { permissions: string[]; scopes: string[] };
  /** Null when the AI usage read failed: the section offers a retry instead of claiming nothing was denied. */
  denied: { tool: string; actorId: string; agentId: string | null; reason: string; at: string }[] | null;
  usage: { agentId: string; tokens: number; calls: number }[];
}) {
  const intlTag = INTL_TAG[useLocale()];
  const { ago } = useFormat();
  const tx = useT();
  const { confirm, dialog } = useConfirm();
  const dir = useDirectory();
  const router = useRouter();
  const [editing, setEditing] = useState<Agent | null>(null);
  const [creating, setCreating] = useState(false);
  const [budgetFor, setBudgetFor] = useState<Agent | null>(null);
  const [activity, setActivity] = useState<Agent | null>(null);
  const [toolsFor, setToolsFor] = useState<Agent | null>(null);
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "err" } | null>(null);
  const used = (id: string) => Number(usage.find((u) => u.agentId === id)?.tokens ?? 0);
  const toggle = async (a: Agent) => {
    try {
      await api(`identity/agents/${a.id}`, { method: "PATCH", body: { status: a.status === "active" ? "disabled" : "active" } });
      setMsg({ tone: "ok", text: a.status === "active" ? tx("admin.agentsadmin.da_tat_khong_ai", { p0: a.name }) : tx("admin.agentsadmin.da_bat", { p0: a.name }) });
      router.refresh();
    } catch {
      setMsg({ tone: "err", text: tx("admin.agentsadmin.chua_luu_duoc") });
    }
  };
  const remove = async (a: Agent) => {
    if (!(await confirm({ title: tx("admin.agentsadmin.xoa_hoi", { p0: a.name }), danger: true }))) return;
    try {
      await api(`identity/agents/${a.id}`, { method: "DELETE" });
      setMsg({ tone: "ok", text: tx("admin.agentsadmin.da_xoa", { p0: a.name }) });
      router.refresh();
    } catch {
      setMsg({ tone: "err", text: tx("admin.agentsadmin.chua_xoa_duoc") });
    }
  };
  return (
    <>
      {dialog}
      <>
        <AdminHeader
          title="AI & agent"
          sub={tx("admin.agentsadmin.agent_chi_lam_duoc")}
          actions={
            <button type="button" className={btnPrimary} onClick={() => setCreating(true)}>
              <PlusIcon className="size-4" />
              {tx("admin.agentsadmin.tao_agent")}
            </button>
          }
        />
        {msg ? (
          <p className={cx("mb-4 rounded-lg px-3 py-2 text-sm", msg.tone === "ok" ? "bg-ok-wash text-ok" : "bg-block-wash text-block")} role="status">
            {msg.text}
          </p>
        ) : null}
        <ul className="m-0 grid list-none gap-3 p-0 md:grid-cols-2">
          {agents.map((a) => (
            <li key={a.id} className="bg-surface shadow-card rounded-xl p-4">
              <div className="flex items-center gap-3">
                <span className="bg-hover text-ink-2 grid size-9 place-items-center rounded-lg">
                  <BotIcon />
                </span>
                <span className="flex-1">
                  <span className="block font-semibold">{a.name}</span>
                  <span className="text-ink-2 text-xs">
                    {agentDescription(tx, a.name, a.description) || tx("admin.agentsadmin.goi_bang_trong_chat", { p0: a.name })} ·{" "}
                    {a.status === "active" ? tx("admin.agentsadmin.dang_bat") : tx("admin.agentsadmin.tat")}
                  </span>
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={a.status === "active"}
                  aria-label={tx("admin.agentsadmin.bat", { p0: a.name })}
                  onClick={() => void toggle(a)}
                  className={cx("relative h-6 w-10 rounded-full transition-colors", a.status === "active" ? "bg-ok" : "bg-hairline")}
                >
                  <span className={cx("bg-surface shadow-raised absolute top-0.5 size-5 rounded-full transition-all", a.status === "active" ? "left-[18px]" : "left-0.5")} />
                </button>
              </div>
              {(() => {
                const b = Number(a.budget);
                const u = used(a.id);
                const pct = b ? Math.min(100, Math.round((u / b) * 100)) : 0;
                return (
                  <div className="mt-3 text-sm">
                    <p className="text-ink-2 flex justify-between">
                      <span>{tx("admin.agentsadmin.thang_nay_token", { p0: u.toLocaleString(intlTag) })}</span>
                      <span>{b ? tx("admin.agentsadmin.ngan_sach", { p0: b.toLocaleString(intlTag) }) : tx("admin.agentsadmin.khong_gioi_han_rieng")}</span>
                    </p>
                    {b ? (
                      <div className="bg-progress-track mt-1 h-1.5 overflow-hidden rounded-full">
                        <div className={cx("h-full", pct >= 100 ? "bg-block" : pct >= 80 ? "bg-warn" : "bg-progress")} style={{ width: `${pct}%` }} />
                      </div>
                    ) : null}
                    {b && pct >= 100 ? <p className="text-block mt-1 text-xs">{tx("admin.agentsadmin.da_het_ngan_sach")}</p> : null}
                  </div>
                );
              })()}
              <div className="mt-3 flex flex-wrap gap-1.5">
                <button type="button" className={cx(btn, btnSm)} onClick={() => setEditing(a)}>
                  {tx("admin.agentsadmin.quyen")}
                </button>
                <button type="button" className={cx(btn, btnSm)} onClick={() => setToolsFor(a)}>
                  {tx("admin.agentsadmin.cong_cu")}
                </button>
                <button type="button" className={cx(btn, btnSm)} onClick={() => setBudgetFor(a)}>
                  {tx("admin.agentsadmin.ngan_sach_2")}
                </button>
                <button type="button" className={cx(btn, btnSm)} onClick={() => setActivity(a)}>
                  {tx("admin.agentsadmin.hoat_dong")}
                </button>
                <button type="button" className={cx(btn, btnSm, "text-block hover:bg-block-wash")} onClick={() => void remove(a)}>
                  {tx("admin.agentsadmin.xoa")}
                </button>
              </div>
              <p className="text-ink-2 mt-2 text-xs">
                {tx("admin.agentsadmin.cong_cu_2", { p0: (a.allowedTools?.length ? a.allowedTools : Object.keys(TOOLS(tx))).map((t) => TOOLS(tx)[t] ?? t).join(" · ") })}
              </p>
              <p className="mt-1 flex flex-wrap gap-1">
                {a.grants.map((g) => (
                  <span key={g.permission} className="bg-hover rounded-sm px-1.5 py-0.5 text-xs">
                    <span className="font-mono">{g.permission}</span> · {SCOPE_LABEL(tx)[g.scope] ?? g.scope}
                  </span>
                ))}
              </p>
            </li>
          ))}
        </ul>
        <section className="mt-8" aria-labelledby="den-h">
          <h2 id="den-h" className="mb-3 flex min-w-0 items-center gap-3 text-sm/6 font-semibold tracking-[-0.01em]">
            <IconTile tone="red">
              <ShieldIcon />
            </IconTile>
            {tx("admin.agentsadmin.ai_bi_tu_choi")}
          </h2>
          {denied === null ? (
            <LoadFailed />
          ) : denied.length === 0 ? (
            <CalmEmpty clear title={tx("admin.agentsadmin.chua_co_lan_nao")} />
          ) : (
            <div className="bg-surface shadow-card overflow-x-auto rounded-xl">
              <table className={cx(table, tableScroll)}>
                <thead>
                  <tr>
                    <th>{tx("admin.agentsadmin.cong_cu")}</th>
                    <th className="max-sm:hidden">{tx("admin.agentsadmin.nguoi_hoi")}</th>
                    <th className="max-md:hidden">Agent</th>
                    <th>{tx("admin.agentsadmin.ly_do")}</th>
                    <th className="max-sm:hidden">{tx("admin.agentsadmin.khi_nao")}</th>
                  </tr>
                </thead>
                <tbody>
                  {denied.map((d, i) => (
                    <tr key={i}>
                      {/* Phones: tool and reason; who, which agent and when go under the tool. */}
                      <td>
                        <span className="font-mono text-xs">{d.tool}</span>
                        <span className="text-ink-2 block text-xs sm:hidden">
                          {dir.name(d.actorId.replace(/^\w+:/, ""))} · {ago(d.at)}
                        </span>
                        <span className="text-ink-2 block text-xs md:hidden">{agents.find((a) => a.id === d.agentId)?.name ?? "—"}</span>
                      </td>
                      <td className="max-sm:hidden">{dir.name(d.actorId.replace(/^\w+:/, ""))}</td>
                      <td className="max-md:hidden">{agents.find((a) => a.id === d.agentId)?.name ?? "—"}</td>
                      <td className="text-ink-2 max-lg:!whitespace-normal">{d.reason}</td>
                      <td className="text-ink-2 max-sm:hidden">{ago(d.at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        {editing ? <GrantsModal agent={editing} catalog={catalog} onClose={() => setEditing(null)} /> : null}
        {creating ? (
          <CreateAgentModal
            onClose={() => setCreating(false)}
            onCreated={(name) => {
              setCreating(false);
              setMsg({ tone: "ok", text: tx("admin.agentsadmin.da_tao_agent_chua", { p0: name }) });
              router.refresh();
            }}
          />
        ) : null}
        {budgetFor ? (
          <BudgetModal
            agent={budgetFor}
            onClose={() => setBudgetFor(null)}
            onSaved={() => {
              setBudgetFor(null);
              router.refresh();
            }}
          />
        ) : null}
        {toolsFor ? (
          <ToolsModal
            agent={toolsFor}
            onClose={() => setToolsFor(null)}
            onSaved={() => {
              setToolsFor(null);
              router.refresh();
            }}
          />
        ) : null}
        {activity ? <ActivityDrawer agent={activity} onClose={() => setActivity(null)} /> : null}
      </>
    </>
  );
}

function GrantsModal({ agent, catalog, onClose }: { agent: Agent; catalog: { permissions: string[]; scopes: string[] }; onClose: () => void }) {
  const tx = useT();
  const router = useRouter();
  const [g, setG] = useState<Record<string, string>>(Object.fromEntries(agent.grants.map((x) => [x.permission, x.scope])));
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    try {
      await api(`identity/agents/${agent.id}/grants`, {
        method: "PUT",
        body: {
          grants: Object.entries(g)
            .filter(([, s]) => s)
            .map(([permission, scope]) => ({ permission, scope })),
        },
      });
      onClose();
      router.refresh();
    } catch (e) {
      setError((e as { body?: { message?: string } }).body?.message ?? tx("admin.agentsadmin.chua_luu_duoc"));
    }
  };
  return (
    <Modal
      title={tx("admin.agentsadmin.quyen_cua", { p0: agent.name })}
      wide
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btn} onClick={onClose}>
            {tx("admin.agentsadmin.huy")}
          </button>
          <button type="button" className={btnPrimary} onClick={() => void save()}>
            {tx("admin.agentsadmin.luu")}
          </button>
        </>
      }
    >
      {error ? (
        <p className="text-block mb-3 text-sm" role="alert">
          {error}
        </p>
      ) : null}
      <div className="grid grid-cols-1 gap-1.5">
        {catalog.permissions.map((p) => (
          <div key={p} className="grid grid-cols-[1fr_150px] items-center gap-3 text-sm">
            <span className="font-mono text-xs">{p}</span>
            <Picker
              variant="field"
              className="h-8 min-h-0"
              label={tx("admin.agentsadmin.pham_vi", { p0: p })}
              value={g[p] ?? ""}
              onChange={(v) => setG((x) => ({ ...x, [p]: v }))}
              options={[{ value: "", label: "—" }, ...catalog.scopes.filter((x) => x !== "PLATFORM").map((x) => ({ value: x, label: SCOPE_LABEL(tx)[x] ?? x }))]}
            />
          </div>
        ))}
      </div>
    </Modal>
  );
}

function CreateAgentModal({ onClose, onCreated }: { onClose: () => void; onCreated: (name: string) => void }) {
  const tx = useT();
  const [name, setName] = useState("");
  const [budget, setBudget] = useState("200000");
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    try {
      await api("identity/agents", { method: "POST", body: { name, budget: Number(budget) || 0 } });
      onCreated(name);
    } catch (e) {
      const st = (e as { status?: number }).status;
      setError(st === 402 ? tx("admin.agentsadmin.can_goi_business") : st === 409 ? tx("admin.agentsadmin.ten_nay_da_co") : tx("admin.agentsadmin.ten_chi_gom_chu"));
    }
  };
  return (
    <Modal
      title={tx("admin.agentsadmin.tao_agent")}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btn} onClick={onClose}>
            {tx("admin.agentsadmin.huy")}
          </button>
          <button type="button" className={btnPrimary} disabled={name.trim().length < 2} onClick={() => void submit()}>
            {tx("admin.agentsadmin.tao")}
          </button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4">
        {error ? (
          <p className="text-block text-sm" role="alert">
            {error}
          </p>
        ) : null}
        <Field label={tx("admin.agentsadmin.ten_agent")} hint={tx("admin.agentsadmin.moi_nguoi_goi_bang")}>
          <input className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder={tx("admin.agentsadmin.tro_ly_kinh_doanh")} maxLength={40} />
        </Field>
        <Field label={tx("admin.agentsadmin.ngan_sach_token_moi")} hint={tx("admin.agentsadmin.n0_chi_dung_han")}>
          <input className={input} inputMode="numeric" value={budget} onChange={(e) => setBudget(e.target.value.replace(/\D/g, ""))} />
        </Field>
      </div>
    </Modal>
  );
}

function BudgetModal({ agent, onClose, onSaved }: { agent: Agent; onClose: () => void; onSaved: () => void }) {
  const tx = useT();
  const toast = useToast();
  const failed = () => toast({ message: tx("common.actionFailed") });
  const [budget, setBudget] = useState(String(agent.budget));
  return (
    <Modal
      title={tx("admin.agentsadmin.ngan_sach_cua", { p0: agent.name })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btn} onClick={onClose}>
            {tx("admin.agentsadmin.huy")}
          </button>
          <button
            type="button"
            className={btnPrimary}
            onClick={() =>
              void api(`identity/agents/${agent.id}`, { method: "PATCH", body: { budget: Number(budget) || 0 } })
                .then(onSaved)
                .catch(failed)
            }
          >
            {tx("admin.agentsadmin.luu")}
          </button>
        </>
      }
    >
      <Field label={tx("admin.agentsadmin.token_moi_thang")} hint={tx("admin.agentsadmin.khi_het_ngan_sach")}>
        <input className={input} inputMode="numeric" value={budget} onChange={(e) => setBudget(e.target.value.replace(/\D/g, ""))} />
      </Field>
    </Modal>
  );
}

function ActivityDrawer({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const intlTag = INTL_TAG[useLocale()];
  const { ago } = useFormat();
  const tx = useT();
  const dir = useDirectory();
  const [d, setD] = useState<{
    month: { tokens: number; calls: number; users: number };
    toolCalls: { tool: string; actorId: string; allowed: boolean; reason: string | null; at: string }[];
  } | null>(null);
  useEffect(() => {
    void api<NonNullable<typeof d>>(`ai/agents/${agent.id}/activity`).then(setD);
  }, [agent.id]);
  return (
    <Drawer title={tx("admin.agentsadmin.hoat_dong_cua", { p0: agent.name })} onClose={onClose} padded>
      {!d ? (
        <p className="text-ink-2">{tx("admin.agentsadmin.dang_tai")}</p>
      ) : (
        <>
          <p className="mb-3 text-sm">
            {tx("admin.agentsadmin.thang_nay")} <b>{d.month.calls}</b> {tx("admin.agentsadmin.lan_goi_boi")} <b>{d.month.users}</b>{" "}
            {tx("admin.agentsadmin.nguoi_token", { p0: Number(d.month.tokens).toLocaleString(intlTag) })}
          </p>
          {d.toolCalls.length === 0 ? (
            <p className="text-ink-2">{tx("admin.agentsadmin.chua_co_lan_goi")}</p>
          ) : (
            <ul className="m-0 grid list-none gap-1.5 p-0 text-sm">
              {d.toolCalls.map((t, i) => (
                <li key={i} className="border-hairline rounded-md border px-3 py-2">
                  <p className="flex items-center gap-2">
                    <span className="font-mono text-xs">{t.tool}</span>
                    <span className={t.allowed ? "text-ok" : "text-block"}>{t.allowed ? tx("admin.agentsadmin.duoc_phep") : tx("admin.agentsadmin.bi_tu_choi")}</span>
                    <span className="text-ink-2 ml-auto text-xs">{ago(t.at)}</span>
                  </p>
                  <p className="text-ink-2 text-xs">{tx("admin.agentsadmin.nguoi_goi", { p0: dir.name(t.actorId.replace(/^\w+:/, "")), p1: t.reason ? ` · ${t.reason}` : "" })}</p>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Drawer>
  );
}

function ToolsModal({ agent, onClose, onSaved }: { agent: Agent; onClose: () => void; onSaved: () => void }) {
  const tx = useT();
  const toast = useToast();
  const failed = () => toast({ message: tx("common.actionFailed") });
  const [tools, setTools] = useState<string[]>(agent.allowedTools?.length ? agent.allowedTools : Object.keys(TOOLS(tx)));
  return (
    <Modal
      title={tx("admin.agentsadmin.cong_cu_cua", { p0: agent.name })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btn} onClick={onClose}>
            {tx("admin.agentsadmin.huy")}
          </button>
          <button
            type="button"
            className={btnPrimary}
            disabled={!tools.length}
            onClick={() =>
              void api(`identity/agents/${agent.id}`, { method: "PATCH", body: { allowedTools: tools } })
                .then(onSaved)
                .catch(failed)
            }
          >
            {tx("admin.agentsadmin.luu")}
          </button>
        </>
      }
    >
      <p className="text-ink-2 mb-3 text-sm">{tx("admin.agentsadmin.agent_chi_dung_duoc")}</p>
      <div className="grid grid-cols-1 gap-1.5">
        {Object.entries(TOOLS(tx)).map(([k, v]) => (
          <label key={k} className="flex items-center gap-2 text-sm">
            <Checkbox checked={tools.includes(k)} onChange={(e) => setTools((x) => (e.target.checked ? [...x, k] : x.filter((y) => y !== k)))} />
            {v}
            <span className="text-ink-2 font-mono text-xs">{k}</span>
          </label>
        ))}
      </div>
    </Modal>
  );
}
