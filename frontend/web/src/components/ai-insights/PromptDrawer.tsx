"use client";

import { PersonChip } from "@/components/chat/PersonTrigger";
import { useState } from "react";
import { api } from "@/lib/client";
import { topicLabel, topicLabels } from "@/lib/ai-labels";
import { useFormat, useT } from "@/lib/i18n/client";
import { btn, btnGhost, btnPrimary, btnSm, chip, chipWarn, cx, input, textarea } from "@/lib/ui";
import { CheckIcon, CopyIcon, GlobeIcon, LockIcon, SparkleIcon, UsersIcon } from "@/components/app/icons";
import { Checkbox } from "@/components/ui/Checkbox";
import { Drawer } from "@/components/ui/Drawer";
import { Picker } from "@/components/ui/Picker";
import { PropertyList, PropertyRow } from "@/components/ui/PropertyRow";
import { Segmented } from "@/components/ui/Segmented";
import { TopicIcon } from "@/components/ai/TopicIcon";
import { askHref, type Department, type DrawerState, type LibraryPrompt, type Manage } from "./PromptLibrary";
import type { TopicRow } from "./SharePromptDialog";

type Vis = LibraryPrompt["visibility"];
const VIS_ICON = { private: <LockIcon />, department: <UsersIcon />, everyone: <GlobeIcon /> } as const;

const label = "text-ink grid gap-1.5 text-[13px] font-medium";

/**
 * Who a company prompt is for. A company-wide manager picks everyone or departments; a department manager can only
 * publish for their own department, so the choice is shown, not offered.
 */
function AudienceField({
  value,
  onChange,
  manage,
  departmentId,
  departments,
  legend,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  manage: Manage;
  departmentId: string | null;
  departments: Department[];
  legend: string;
}) {
  const t = useT();
  const [pick, setPick] = useState(value.length > 0);
  if (manage !== "workspace")
    return (
      <div className={label}>
        {legend}
        <p className="text-ink-2 m-0 text-[13px] font-normal">
          {departments.find((d) => d.id === departmentId)?.name ?? t("aiInsights.library.audienceMine")} · {t("aiInsights.library.audienceDeptOnly")}
        </p>
      </div>
    );
  return (
    <fieldset className="m-0 grid gap-2 border-0 p-0">
      <legend className="text-ink mb-1.5 p-0 text-[13px] font-medium">{legend}</legend>
      <Segmented
        label={legend}
        size="sm"
        value={pick ? "depts" : "all"}
        onChange={(v) => {
          setPick(v === "depts");
          if (v === "all") onChange([]);
        }}
        options={[
          { value: "all", label: t("aiInsights.library.audienceAll"), icon: <GlobeIcon /> },
          { value: "depts", label: t("aiInsights.library.audienceDepts"), icon: <UsersIcon /> },
        ]}
      />
      {pick ? (
        <div className="border-hairline grid max-h-48 gap-0.5 overflow-y-auto rounded-md border p-1.5">
          {departments.map((d) => (
            <Checkbox
              key={d.id}
              label={d.name}
              checked={value.includes(d.id)}
              onChange={(e) => onChange(e.target.checked ? [...value, d.id] : value.filter((x) => x !== d.id))}
              className="hover:bg-hover rounded px-1.5 py-1 text-[13px]"
            />
          ))}
        </div>
      ) : null}
    </fieldset>
  );
}

/** The editor for a new prompt or an existing one: title, short description, text, topic, and who sees it. */
function PromptForm({
  prompt,
  level,
  topics,
  departments,
  manage,
  departmentId,
  onCancel,
  onSaved,
}: {
  prompt: LibraryPrompt | null;
  level: "company" | "personal";
  topics: TopicRow[];
  departments: Department[];
  manage: Manage;
  departmentId: string | null;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const { locale } = useFormat();
  const labels = topicLabels(topics, locale);
  const [title, setTitle] = useState(prompt?.title ?? "");
  const [description, setDescription] = useState(prompt?.description ?? "");
  const [body, setBody] = useState(prompt?.body ?? "");
  const [topic, setTopic] = useState(prompt?.topic ?? "other");
  const [vis, setVis] = useState<Vis>(prompt?.visibility ?? "private");
  // A department manager's new company prompt is for their department; a company-wide one starts for everyone.
  const [audience, setAudience] = useState<string[]>(prompt?.audience ?? (manage === "department" && departmentId ? [departmentId] : []));
  const [pinned, setPinned] = useState(prompt?.pinned ?? false);
  const [state, setState] = useState<"idle" | "saving" | "error">("idle");
  const company = level === "company";
  const save = async () => {
    setState("saving");
    const fields = { title, description, body, topic, ...(company ? { audience, pinned } : { visibility: vis }) };
    try {
      if (prompt) await api(`ai/insights/library/${prompt.id}`, { method: "PATCH", body: fields });
      else await api("ai/insights/library", { method: "POST", body: { ...fields, level } });
      onSaved();
    } catch {
      setState("error");
    }
  };
  return (
    <form
      id="prompt-form"
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label className={label}>
        {t("aiInsights.library.form.title")}
        <input className={input} value={title} maxLength={120} required onChange={(e) => setTitle(e.target.value)} data-testid="prompt-title" />
      </label>
      <label className={label}>
        {t("aiInsights.library.form.description")}
        <input className={input} value={description} maxLength={300} placeholder={t("aiInsights.library.form.descriptionPh")} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label className={label}>
        {t("aiInsights.library.form.body")}
        <textarea className={cx(textarea, "min-h-48 font-normal")} value={body} maxLength={8000} required onChange={(e) => setBody(e.target.value)} data-testid="prompt-body" />
        <span className="text-ink-2 text-xs font-normal">{t("aiInsights.library.form.bodyHint")}</span>
      </label>
      <div className={label}>
        {t("aiInsights.library.form.topic")}
        <Picker
          variant="field"
          label={t("aiInsights.library.form.topic")}
          value={topic}
          onChange={setTopic}
          options={(topics.length ? topics.filter((x) => !x.archived || x.key === topic) : [{ key: topic }]).map((x) => ({
            value: x.key,
            label: topicLabel(t, x.key, labels),
            icon: <TopicIcon topic={x.key} className="size-3.5" />,
          }))}
        />
      </div>
      {company ? (
        <>
          <AudienceField value={audience} onChange={setAudience} manage={manage} departmentId={departmentId} departments={departments} legend={t("aiInsights.library.visLabel")} />
          <Checkbox label={t("aiInsights.library.pinned")} checked={pinned} onChange={(e) => setPinned(e.target.checked)} className="text-[13px]" />
        </>
      ) : (
        <fieldset className="m-0 grid gap-2 border-0 p-0">
          <legend className="text-ink mb-1.5 p-0 text-[13px] font-medium">{t("aiInsights.library.visLabel")}</legend>
          <div className="grid gap-1.5 sm:grid-cols-3">
            {(["private", "department", "everyone"] as const).map((v) => {
              const off = v === "department" && !departmentId;
              return (
                <label
                  key={v}
                  className={cx(
                    "ring-hairline has-[:checked]:ring-accent has-[:checked]:bg-accent-wash/50 grid cursor-pointer gap-1 rounded-md px-3 py-2 ring-1 transition-colors",
                    off && "cursor-not-allowed opacity-50",
                  )}
                  title={off ? t("aiInsights.library.noDept") : undefined}
                >
                  <input type="radio" name="vis" className="sr-only" value={v} checked={vis === v} disabled={off} onChange={() => setVis(v)} />
                  <span className="text-ink flex items-center gap-1.5 text-[13px] font-medium [&_svg]:size-3.5">
                    {VIS_ICON[v]}
                    {t(`aiInsights.library.vis.${v}`)}
                  </span>
                  <span className="text-ink-2 text-xs">{t(`aiInsights.library.visHint.${v}`)}</span>
                </label>
              );
            })}
          </div>
        </fieldset>
      )}
      <p className="text-ink-2 m-0 text-xs">{t("aiInsights.library.form.redactNote")}</p>
      {state === "error" ? (
        <p role="alert" className="text-block m-0 text-[13px]">
          {t("aiInsights.library.form.failed")}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <button type="button" className={cx(btnGhost, btnSm)} onClick={onCancel}>
          {t("aiInsights.library.form.cancel")}
        </button>
        <button type="submit" className={cx(btnPrimary, btnSm)} disabled={state === "saving" || !title.trim() || !body.trim()} data-testid="prompt-save">
          {state === "saving" ? t("aiInsights.library.form.saving") : t(prompt ? "aiInsights.library.form.save" : "aiInsights.library.form.create")}
        </button>
      </div>
    </form>
  );
}

/**
 * The prompt drawer (lazy): read a prompt and use it, or edit, propose to the company, review a proposal, or write a
 * new one. Everything it may do is decided on the server; the flags on the prompt only hide what would be refused.
 */
export function PromptDrawer({
  state,
  topics,
  departments,
  manage,
  departmentId,
  assistant,
  onUse,
  onMode,
  onClose,
  onSaved,
}: {
  state: DrawerState;
  topics: TopicRow[];
  departments: Department[];
  manage: Manage;
  departmentId: string | null;
  assistant: boolean;
  onUse: (p: LibraryPrompt) => void;
  onMode: (s: DrawerState) => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const { ago, locale } = useFormat();
  const labels = topicLabels(topics, locale);
  const [copied, setCopied] = useState(false);
  const [note, setNote] = useState("");
  const [proposeTo, setProposeTo] = useState<"everyone" | "department">("everyone");
  const [reviewAudience, setReviewAudience] = useState<string[]>(state.mode === "review" ? state.prompt.audience : []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const deptName = (id: string) => departments.find((d) => d.id === id)?.name ?? id;

  if (state.mode === "new" || state.mode === "edit") {
    const level = state.mode === "new" ? state.level : state.prompt.level;
    return (
      <Drawer
        title={state.mode === "new" ? t(level === "company" ? "aiInsights.library.newCompany" : "aiInsights.library.newPrompt") : t("aiInsights.library.edit")}
        onClose={onClose}
        padded
      >
        <PromptForm
          prompt={state.mode === "edit" ? state.prompt : null}
          level={level}
          topics={topics}
          departments={departments}
          manage={manage}
          departmentId={departmentId}
          onCancel={state.mode === "edit" ? () => onMode({ mode: "view", prompt: state.prompt }) : onClose}
          onSaved={onSaved}
        />
      </Drawer>
    );
  }

  const p = state.prompt;
  const act = async (path: string, body: unknown) => {
    setBusy(true);
    setError(null);
    try {
      await api(`ai/insights/library/${p.id}/${path}`, { method: "POST", body });
      onSaved();
    } catch (e) {
      setError((e as { status?: number }).status === 409 ? t("aiInsights.library.proposeAgain") : t("aiInsights.library.form.failed"));
      setBusy(false);
    }
  };
  const copy = async () => {
    await navigator.clipboard.writeText(p.body).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
    onUse(p);
  };

  const footer =
    state.mode === "propose" ? (
      <div className="flex justify-end gap-2">
        <button type="button" className={cx(btnGhost, btnSm)} onClick={() => onMode({ mode: "view", prompt: p })}>
          {t("aiInsights.library.form.cancel")}
        </button>
        <button type="button" className={cx(btnPrimary, btnSm)} disabled={busy} onClick={() => void act("propose", { audience: proposeTo })}>
          {t("aiInsights.library.proposeSend")}
        </button>
      </div>
    ) : state.mode === "review" ? (
      <div className="flex justify-end gap-2">
        <button type="button" className={cx(btn, btnSm)} disabled={busy} onClick={() => void act("review", { decision: "decline", note: note || undefined })}>
          {t("aiInsights.library.decline")}
        </button>
        <button
          type="button"
          className={cx(btnPrimary, btnSm)}
          disabled={busy}
          onClick={() => void act("review", { decision: "approve", note: note || undefined, audience: reviewAudience })}
          data-testid="prompt-approve"
        >
          <CheckIcon />
          {t("aiInsights.library.approve")}
        </button>
      </div>
    ) : p.status === "live" ? (
      <div className="flex flex-wrap justify-end gap-2">
        {p.canEdit ? (
          <button type="button" className={cx(btnGhost, btnSm, "mr-auto")} onClick={() => onMode({ mode: "edit", prompt: p })}>
            {t("aiInsights.library.edit")}
          </button>
        ) : null}
        <button type="button" className={cx(assistant ? btn : btnPrimary, btnSm)} onClick={() => void copy()}>
          {copied ? <CheckIcon /> : <CopyIcon />}
          {copied ? t("aiInsights.library.copied") : t("aiInsights.library.copy")}
        </button>
        {assistant ? (
          <a href={askHref(p.body)} onClick={() => onUse(p)} className={cx(btnPrimary, btnSm, "no-underline")} title={t("aiInsights.library.useHint")}>
            <SparkleIcon />
            {t("aiInsights.library.use")}
          </a>
        ) : null}
      </div>
    ) : p.canEdit ? (
      <div className="flex justify-end">
        <button type="button" className={cx(btn, btnSm)} onClick={() => onMode({ mode: "edit", prompt: p })}>
          {t("aiInsights.library.edit")}
        </button>
      </div>
    ) : null;

  return (
    <Drawer title={p.title} label={t("aiInsights.library.detail")} onClose={onClose} padded footer={footer}>
      <div className="grid gap-5">
        {p.description ? <p className="text-ink-2 m-0 text-sm">{p.description}</p> : null}
        <PropertyList label={t("aiInsights.library.detail")}>
          <PropertyRow label={t("aiInsights.library.visLabel")}>
            <span className="text-ink flex items-center gap-1.5 text-sm [&_svg]:size-3.5">
              {p.level === "company" ? (
                <>
                  <GlobeIcon />
                  {p.audience.length ? p.audience.map(deptName).join(", ") : t("aiInsights.library.audienceAll")}
                </>
              ) : (
                <>
                  {VIS_ICON[p.visibility]}
                  {t(`aiInsights.library.vis.${p.visibility}`)}
                </>
              )}
              {p.status !== "live" ? <span className={p.status === "proposed" ? chipWarn : chip}>{t(`aiInsights.library.status.${p.status}`)}</span> : null}
            </span>
          </PropertyRow>
          <PropertyRow label={t("aiInsights.library.form.topic")}>
            <span className="text-ink flex items-center gap-1.5 text-sm">
              <TopicIcon topic={p.topic} className="text-ink-2 size-3.5" />
              {topicLabel(t, p.topic, labels)}
            </span>
          </PropertyRow>
          <PropertyRow label={t("aiInsights.library.author")}>
            <PersonChip userId={p.authorId} dense className="text-ink text-sm" />
          </PropertyRow>
          <PropertyRow label={t("aiInsights.library.usesLabel")}>
            <span className="text-ink-2 text-sm tabular-nums" suppressHydrationWarning>
              {p.uses} · {t("aiInsights.library.updated", { ago: ago(p.updatedAt) })}
            </span>
          </PropertyRow>
        </PropertyList>
        {p.proposal ? (
          <p className={cx(p.proposal.status === "live" ? chip : chipWarn, "m-0 w-fit")}>
            {t(`aiInsights.library.proposal.${p.proposal.status}`)}
            {p.proposal.note ? ` · ${p.proposal.note}` : ""}
          </p>
        ) : p.reviewNote ? (
          <p className="text-ink-2 m-0 text-[13px]">{p.reviewNote}</p>
        ) : null}
        <pre className="bg-ground text-ink border-hairline m-0 whitespace-pre-wrap break-words rounded-lg border p-3.5 font-sans text-sm/6">{p.body}</pre>
        {p.redacted ? <p className="text-ink-2 m-0 text-xs">{t("aiInsights.library.redactedNote")}</p> : null}

        {state.mode === "propose" ? (
          <div className="grid gap-3">
            <p className="text-ink-2 m-0 text-[13px]">{t("aiInsights.library.proposeLead")}</p>
            <div className={label}>
              {t("aiInsights.library.proposeFor")}
              <Segmented
                label={t("aiInsights.library.proposeFor")}
                size="sm"
                value={proposeTo}
                onChange={setProposeTo}
                options={[
                  { value: "everyone", label: t("aiInsights.library.audienceAll"), icon: <GlobeIcon /> },
                  ...(departmentId ? [{ value: "department" as const, label: t("aiInsights.library.audienceMine"), icon: <UsersIcon /> }] : []),
                ]}
              />
            </div>
          </div>
        ) : null}

        {state.mode === "review" ? (
          <div className="grid gap-3">
            <AudienceField
              value={reviewAudience}
              onChange={setReviewAudience}
              manage={manage}
              departmentId={departmentId}
              departments={departments}
              legend={t("aiInsights.library.reviewFor")}
            />
            <label className={label}>
              {t("aiInsights.library.reviewNote")}
              <textarea className={cx(textarea, "min-h-20 font-normal")} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
            </label>
          </div>
        ) : null}

        {state.mode === "view" && p.level === "personal" && p.canEdit && p.proposal?.status !== "proposed" ? (
          <button type="button" className={cx(btnGhost, btnSm, "w-fit")} onClick={() => onMode({ mode: "propose", prompt: p })}>
            {t("aiInsights.library.propose")}
          </button>
        ) : null}
        {error ? (
          <p role="alert" className="text-block m-0 text-[13px]">
            {error}
          </p>
        ) : null}
      </div>
    </Drawer>
  );
}
