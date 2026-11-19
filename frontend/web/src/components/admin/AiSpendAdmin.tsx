"use client";

import { IconTile } from "@/components/ui/Bento";
import { CashIcon } from "@/components/app/icons";
import { useRouter } from "next/navigation";
import { Picker } from "@/components/ui/Picker";
import { useState } from "react";
import { api } from "@/lib/client";
import { usd } from "@/lib/ai-spend";
import { INTL_TAG } from "@/lib/i18n/config";
import { useFormat, useT } from "@/lib/i18n/client";
import { btn, btnPrimary, btnSm, cx, input, mono, nums } from "@/lib/ui";
import { InfoTip } from "@/components/ui/InfoTip";
import { useConfirm } from "@/components/ui/Confirm";

type Scope = "workspace" | "department" | "person";
export interface AiSpend {
  models: { provider: string; label: string; model: string; selfhost: boolean; tokens90d: number }[];
  prices: { provider: string; model: string; inputPerMTok: number; outputPerMTok: number }[];
  budgets: { scope: Scope; scopeId: string; monthlyTokens: number | null; monthlyUsd: number | null; spend: { tokens: number; usd: number }; percent: number }[];
}
export interface SpendTargets {
  departments: { id: string; name: string }[];
  people: { userId: string; displayName: string }[];
}

const card = "rounded-xl shadow-card bg-surface";
const SCOPES: Scope[] = ["workspace", "department", "person"];

/**
 * Admin › Kết nối AI › Chi phí & hạn mức: the price of each model (USD per 1M tokens, per connection, so the same
 * model can be free on Ollama and paid elsewhere) and monthly budgets for the company, a department or a person.
 * Work › AI turns the prices into cost per person, department and feature; budgets stop AI for whoever runs out.
 */
export function AiSpendAdmin({ spend, targets }: { spend: AiSpend; targets: SpendTargets }) {
  const t = useT();
  return (
    <section id="spend" aria-labelledby="spend-h" className="grid gap-4">
      <div className="grid gap-1">
        <h2 id="spend-h" className="m-0 flex min-w-0 items-center gap-3 text-sm/6 font-semibold tracking-[-0.01em]">
          <IconTile tone="green">
            <CashIcon />
          </IconTile>
          {t("aic.spend.title")}
          <InfoTip text={t("aic.spend.lead")} label={t("aic.spend.title")} />
        </h2>
      </div>
      <Prices spend={spend} />
      <Budgets budgets={spend.budgets} targets={targets} />
    </section>
  );
}

function Prices({ spend }: { spend: AiSpend }) {
  const t = useT();
  const { locale } = useFormat();
  const priceOf = (m: AiSpend["models"][number]) => spend.prices.find((p) => p.provider === m.provider && p.model === m.model);
  return (
    <div className={cx(card, "grid gap-2 p-4")}>
      <h3 className="m-0 text-sm font-semibold">{t("aic.spend.pricesTitle")}</h3>
      {spend.models.length === 0 ? (
        <p className="text-ink-2 m-0 text-sm">{t("aic.spend.noModels")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr className="text-ink-2 border-hairline border-b text-xs">
                <th className="py-2 pr-2 font-medium">{t("aic.spend.colModel")}</th>
                <th className="hidden px-2 py-2 text-right font-medium sm:table-cell">{t("aic.spend.colUsage")}</th>
                <th className="px-2 py-2 font-medium">{t("aic.spend.colIn")}</th>
                <th className="px-2 py-2 font-medium">{t("aic.spend.colOut")}</th>
                <th className="py-2 pl-2">
                  <span className="sr-only">{t("aic.spend.savePrice")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {spend.models.map((m) => (
                <PriceRow key={`${m.provider}:${m.model}`} model={m} price={priceOf(m)} tokens={m.tokens90d.toLocaleString(INTL_TAG[locale])} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function PriceRow({ model, price, tokens }: { model: AiSpend["models"][number]; price: AiSpend["prices"][number] | undefined; tokens: string }) {
  const t = useT();
  const router = useRouter();
  const [inP, setIn] = useState(price ? String(price.inputPerMTok) : "");
  const [outP, setOut] = useState(price ? String(price.outputPerMTok) : "");
  const [state, setState] = useState<"idle" | "busy" | "saved" | "error">("idle");
  // A deleted connection keeps its usage; the server then only knows its id (c_…).
  const name = /^c_[0-9A-Z]{26}$/.test(model.label) ? t("aic.spend.removed") : model.label;
  const label = `${name} · ${model.model}`;
  const save = async () => {
    setState("busy");
    try {
      await api("ai/spend/prices", { method: "PUT", body: { provider: model.provider, model: model.model, inputPerMTok: Number(inP || 0), outputPerMTok: Number(outP || 0) } });
      setState("saved");
      router.refresh();
    } catch {
      setState("error");
    }
  };
  const field = (value: string, set: (v: string) => void, name: string) => (
    <input
      className={cx(input, nums, "h-8 w-24")}
      inputMode="decimal"
      value={value}
      placeholder={model.selfhost ? "0" : "–"}
      aria-label={`${name} · ${label}`}
      onChange={(e) => {
        set(e.target.value.replace(",", "."));
        setState("idle");
      }}
    />
  );
  return (
    <tr className="border-hairline border-b last:border-0">
      <td className="py-2 pr-2">
        <span className="block font-medium">{name}</span>
        <span className={cx(mono, "text-ink-2 block text-xs")}>{model.model}</span>
        {!price ? <span className="text-ink-2 text-xs">{model.selfhost ? t("aic.spend.free") : t("aic.spend.unpriced")}</span> : null}
      </td>
      <td className={cx(nums, "text-ink-2 hidden px-2 py-2 text-right sm:table-cell")}>{tokens}</td>
      <td className="px-2 py-2">{field(inP, setIn, t("aic.spend.colIn"))}</td>
      <td className="px-2 py-2">{field(outP, setOut, t("aic.spend.colOut"))}</td>
      <td className="py-2 pl-2 text-right">
        <button
          type="button"
          className={cx(btn, btnSm)}
          disabled={state === "busy" || (!inP && !outP)}
          onClick={() => void save()}
          aria-label={`${t("aic.spend.savePrice")} · ${label}`}
        >
          {state === "saved" ? t("aic.spend.saved") : t("aic.spend.savePrice")}
        </button>
        {state === "error" ? (
          <span role="alert" className="text-block block text-xs">
            {t("aic.failed")}
          </span>
        ) : null}
      </td>
    </tr>
  );
}

function Budgets({ budgets, targets }: { budgets: AiSpend["budgets"]; targets: SpendTargets }) {
  const t = useT();
  const { confirm, dialog } = useConfirm();
  const { locale } = useFormat();
  const router = useRouter();
  const [scope, setScope] = useState<Scope>("workspace");
  const [target, setTarget] = useState("");
  const [tokens, setTokens] = useState("");
  const [money, setMoney] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameOf = (b: { scope: Scope; scopeId: string }) =>
    b.scope === "workspace"
      ? t("aic.spend.scope.workspace")
      : b.scope === "department"
        ? (targets.departments.find((d) => d.id === b.scopeId)?.name ?? b.scopeId)
        : (targets.people.find((p) => p.userId === b.scopeId)?.displayName ?? b.scopeId);
  const number = (n: number) => n.toLocaleString(INTL_TAG[locale]);
  const send = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      router.refresh();
    } catch {
      setErr(t("aic.failed"));
    } finally {
      setBusy(false);
    }
  };
  const add = () => {
    if (!tokens && !money) return setErr(t("aic.spend.needLimit"));
    if (scope !== "workspace" && !target) return setErr(t("aic.spend.needTarget"));
    void send(async () => {
      await api("ai/spend/budgets", {
        method: "PUT",
        body: { scope, scopeId: scope === "workspace" ? "" : target, monthlyTokens: tokens ? Math.round(Number(tokens)) : null, monthlyUsd: money ? Number(money) : null },
      });
      setTokens("");
      setMoney("");
    });
  };
  return (
    <>
      {dialog}
      <div className={cx(card, "grid gap-3 p-4")}>
        <div className="grid gap-1">
          <h3 className="m-0 flex items-center gap-1 text-sm font-semibold">
            {t("aic.spend.budgetsTitle")}
            <InfoTip text={t("aic.spend.budgetsLead")} label={t("aic.spend.budgetsTitle")} />
          </h3>
        </div>
        {budgets.length === 0 ? (
          <p className="text-ink-2 m-0 text-sm">{t("aic.spend.noBudgets")}</p>
        ) : (
          <ul className="m-0 grid list-none gap-2 p-0" aria-label={t("aic.spend.budgetsTitle")}>
            {budgets.map((b) => (
              <li key={`${b.scope}:${b.scopeId}`} className="border-hairline grid gap-1.5 rounded-lg border p-3">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="min-w-0 flex-1 font-medium">
                    {nameOf(b)} {nameOf(b) === t(`aic.spend.scope.${b.scope}`) ? null : <span className="text-ink-2 text-xs font-normal">{t(`aic.spend.scope.${b.scope}`)}</span>}
                  </span>
                  <span className={cx(nums, "text-ink-2 text-xs")}>
                    {t("aic.spend.limit", {
                      value: [b.monthlyTokens ? t("aic.spend.limitTokens", { value: number(b.monthlyTokens) }) : null, b.monthlyUsd ? usd(b.monthlyUsd, locale) : null]
                        .filter(Boolean)
                        .join(" · "),
                    })}
                  </span>
                  <button
                    type="button"
                    className={cx(btn, btnSm, "text-block hover:bg-block-wash")}
                    disabled={busy}
                    onClick={async () => {
                      if (await confirm({ title: t("aic.spend.removeConfirm"), danger: true }))
                        void send(() => api(`ai/spend/budgets?scope=${b.scope}&scopeId=${encodeURIComponent(b.scopeId)}`, { method: "DELETE" }));
                    }}
                  >
                    {t("aic.spend.remove")}
                  </button>
                </div>
                <span className="bg-progress-track block h-1.5 overflow-hidden rounded-full">
                  <span
                    className={cx("block h-full rounded-full", b.percent >= 100 ? "bg-block" : b.percent >= 80 ? "bg-warn" : "bg-progress")}
                    style={{ width: `${Math.min(100, b.percent)}%` }}
                  />
                </span>
                <span className="text-ink-2 text-xs">{t("aic.spend.used", { tokens: number(b.spend.tokens), cost: usd(b.spend.usd, locale), percent: b.percent })}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="border-hairline grid gap-2 border-t pt-3 sm:grid-cols-[auto_minmax(0,1fr)_auto_auto_auto] sm:items-end">
          <div className="grid gap-1 text-xs">
            <span className="text-ink-2" aria-hidden="true">
              {t("aic.spend.target")}
            </span>
            <Picker
              variant="field"
              className="h-9 sm:w-40"
              label={t("aic.spend.target")}
              value={scope}
              onChange={(v) => {
                setScope(v as Scope);
                setTarget("");
              }}
              options={SCOPES.map((x) => ({ value: x, label: t(`aic.spend.scope.${x}`) }))}
            />
          </div>
          <div className="grid gap-1 text-xs">
            <span aria-hidden="true" className="hidden sm:block">
              &nbsp;
            </span>
            <Picker
              variant="field"
              className="h-9"
              label={t(`aic.spend.scope.${scope}`)}
              value={target}
              disabled={scope === "workspace"}
              onChange={setTarget}
              options={[
                { value: "", label: scope === "workspace" ? t("aic.spend.scope.workspace") : t("aic.spend.pick") },
                ...(scope === "department" ? targets.departments.map((d) => ({ value: d.id, label: d.name })) : []),
                ...(scope === "person" ? targets.people.map((p) => ({ value: p.userId, label: p.displayName })) : []),
              ]}
            />
          </div>
          <label className="grid gap-1 text-xs">
            <span className="text-ink-2">{t("aic.spend.tokens")}</span>
            <input className={cx(input, nums, "h-9 w-36")} inputMode="numeric" value={tokens} onChange={(e) => setTokens(e.target.value.replace(/\D/g, ""))} />
          </label>
          <label className="grid gap-1 text-xs">
            <span className="text-ink-2">{t("aic.spend.usdLimit")}</span>
            <input className={cx(input, nums, "h-9 w-28")} inputMode="decimal" value={money} onChange={(e) => setMoney(e.target.value.replace(",", "."))} />
          </label>
          <button type="button" className={btnPrimary} disabled={busy} onClick={add}>
            {t("aic.spend.add")}
          </button>
        </div>
        {err ? (
          <p role="alert" className="text-block m-0 text-sm">
            {err}
          </p>
        ) : null}
      </div>
    </>
  );
}
