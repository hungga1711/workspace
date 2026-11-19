"use client";

import { useState } from "react";
import Link from "next/link";
import { useT } from "@/lib/i18n/client";
import { btn, btnPrimary, cx, input } from "@/lib/ui";
import { Checkbox } from "@/components/ui/Checkbox";
import { Modal } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { ENV_ICON } from "../bits";
import { DEFAULT_IMAGE, type EnvKind, type Environment, type RunnerInfo } from "../types";
import { commandCount, withEnvironment } from "./draft";
import { Advanced, ChipInput, ChoiceCards, Group, Num, SectionCard } from "./parts";
import type { SectionProps } from "./sections";

const IMAGES = ["node:22-slim", "python:3.12-slim", "ubuntu:24.04"];
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/**
 * 3 · Where the steps run. Three environments as cards; a sandbox opens its own settings: whose runner, a clean folder
 * or a container (image, network, CPU, memory), a repository to clone, a setup command. Moving to the company's AI
 * drops the steps that need a shell, after asking.
 */
export function EnvironmentSection({ d, set, runners }: SectionProps & { runners: RunnerInfo[] | null }) {
  const t = useT();
  const env = d.config.environment;
  const [confirm, setConfirm] = useState(false);
  const patch = (p: Partial<Environment>) => set((x) => withEnvironment(x, { ...x.config.environment, ...p }));
  const pick = (kind: EnvKind) => {
    if (kind === env.kind) return;
    if (kind === "assistant" && commandCount(d.steps)) return setConfirm(true);
    set((x) => withEnvironment(x, kind === "sandbox" ? { kind, host: "person", isolation: "folder" } : { kind }));
  };
  const container = env.isolation === "container";
  // Open when a template (or someone before) already set one of them; closed for a sandbox just picked.
  const [technical] = useState(
    () =>
      !!(
        env.repo ||
        env.branch ||
        env.setup ||
        env.agent ||
        env.env?.length ||
        env.keep ||
        env.cpus ||
        env.memoryMb ||
        env.network === "off" ||
        (env.image && env.image !== DEFAULT_IMAGE)
      ),
  );
  const mine = runners?.filter((r) => r.mine && r.online) ?? [];
  const shared = runners?.filter((r) => r.shared && r.online) ?? [];
  const pool = env.host === "company" ? shared : mine;
  return (
    <SectionCard n={3} title={t("workflows.studio.section.environment")} hint={t("workflows.studio.hint.environment")}>
      <ChoiceCards
        label={t("workflows.studio.section.environment")}
        value={env.kind}
        onChange={pick}
        options={(["assistant", "sandbox", "computer"] as const).map((k) => ({
          value: k,
          title: t(`workflows.env.${k}`),
          text: t(`workflows.studio.env.${k}.text`),
          icon: ENV_ICON[k],
          ticks: [
            { on: k !== "assistant", text: t("workflows.studio.env.tick.commands") },
            { on: k !== "assistant", text: t("workflows.studio.env.tick.files") },
            { on: k === "assistant", text: t("workflows.studio.env.tick.noRunner") },
          ],
        }))}
      />

      {env.kind === "sandbox" ? (
        <div className="grid min-w-0 gap-4">
          <div className="grid min-w-0 gap-4 md:grid-cols-2">
            <Group label={t("workflows.studio.env.host")} hint={t(env.host === "company" ? "workflows.studio.env.hostCompanyHint" : "workflows.studio.env.hostPersonHint")}>
              <Segmented
                label={t("workflows.studio.env.host")}
                value={env.host ?? "person"}
                onChange={(v) => patch({ host: v })}
                className="justify-self-start"
                options={[
                  { value: "person", label: t("workflows.studio.env.hostPerson") },
                  { value: "company", label: t("workflows.studio.env.hostCompany") },
                ]}
              />
              {runners ? (
                <p className={cx("m-0 flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs", pool.length ? "text-ok" : "text-warn")}>
                  <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-current" />
                  {pool.length
                    ? t(env.host === "company" ? "workflows.studio.env.sharedOnline" : "workflows.studio.env.mineOnline", {
                        count: pool.length,
                        device: pool[0]!.device,
                      })
                    : t(env.host === "company" ? "workflows.studio.env.sharedNone" : "workflows.studio.env.mineNone")}
                  {pool.length && container ? (
                    <span className="text-ink-2">· {t(pool.some((r) => r.docker) ? "workflows.studio.env.dockerYes" : "workflows.studio.env.dockerNo")}</span>
                  ) : null}
                  {!pool.length ? (
                    <Link href="/app/ai/connect" className="text-accent-text">
                      {t("workflows.studio.env.connect")}
                    </Link>
                  ) : null}
                </p>
              ) : null}
            </Group>
            <Group label={t("workflows.studio.env.isolation")} hint={t(container ? "workflows.studio.env.containerHint" : "workflows.studio.env.folderHint")}>
              <Segmented
                label={t("workflows.studio.env.isolation")}
                value={env.isolation ?? "folder"}
                onChange={(v) => patch(v === "container" ? { isolation: v, image: env.image || DEFAULT_IMAGE, network: env.network ?? "on" } : { isolation: v })}
                className="justify-self-start"
                options={[
                  { value: "folder", label: t("workflows.studio.env.folder") },
                  { value: "container", label: t("workflows.studio.env.container") },
                ]}
              />
            </Group>
          </div>

          {/* Everything below is for whoever sets the computer up; a template that needs it arrives with it filled in. */}
          <Advanced label={t("workflows.studio.env.technical")} open={technical}>
            {container ? (
              <div className="bg-ground ring-hairline grid min-w-0 gap-4 rounded-xl p-3.5 ring-1 ring-inset">
                <Group label={t("workflows.studio.env.image")}>
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    {IMAGES.map((img) => (
                      <button
                        key={img}
                        type="button"
                        aria-pressed={env.image === img}
                        onClick={() => patch({ image: img })}
                        className={cx(
                          "inline-flex h-7 items-center rounded-full px-2.5 font-mono text-[12px] ring-1 ring-inset max-md:h-8",
                          env.image === img ? "bg-ink text-on-brand ring-ink" : "bg-surface text-ink-soft ring-hairline hover:ring-edge",
                        )}
                      >
                        {img}
                      </button>
                    ))}
                  </div>
                  <input
                    className={cx(input, "font-mono text-[13px]")}
                    value={env.image ?? ""}
                    onChange={(e) => patch({ image: e.target.value.trim() })}
                    placeholder={DEFAULT_IMAGE}
                    aria-label={t("workflows.studio.env.image")}
                    spellCheck={false}
                    maxLength={200}
                  />
                </Group>
                <div className="grid min-w-0 gap-4 sm:grid-cols-3">
                  <Group label={t("workflows.studio.env.network")}>
                    <Segmented
                      label={t("workflows.studio.env.network")}
                      value={env.network ?? "on"}
                      onChange={(v) => patch({ network: v })}
                      className="justify-self-start"
                      options={[
                        { value: "on", label: t("workflows.studio.env.netOn") },
                        { value: "off", label: t("workflows.studio.env.netOff") },
                      ]}
                    />
                  </Group>
                  <Group label={t("workflows.studio.env.cpus")}>
                    <Num
                      label={t("workflows.studio.env.cpus")}
                      value={env.cpus}
                      onChange={(n) => patch({ cpus: n })}
                      min={0.25}
                      max={16}
                      step={0.25}
                      blank={t("workflows.studio.env.noLimit")}
                    />
                  </Group>
                  <Group label={t("workflows.studio.env.memory")}>
                    <Num
                      label={t("workflows.studio.env.memory")}
                      value={env.memoryMb}
                      onChange={(n) => patch({ memoryMb: n })}
                      min={128}
                      max={65_536}
                      unit="MB"
                      blank={t("workflows.studio.env.noLimit")}
                    />
                  </Group>
                </div>
              </div>
            ) : null}

            <div className="grid min-w-0 gap-4 md:grid-cols-[minmax(0,1fr)_12rem]">
              <Group label={t("workflows.studio.env.repo")} hint={t("workflows.studio.env.repoHint")}>
                <input
                  className={cx(input, "font-mono text-[13px]")}
                  value={env.repo ?? ""}
                  onChange={(e) => patch({ repo: e.target.value.trim() || undefined })}
                  placeholder="https://github.com/acme/site.git"
                  aria-label={t("workflows.studio.env.repo")}
                  spellCheck={false}
                  maxLength={300}
                />
              </Group>
              <Group label={t("workflows.studio.env.branch")}>
                <input
                  className={cx(input, "font-mono text-[13px]")}
                  value={env.branch ?? ""}
                  onChange={(e) => patch({ branch: e.target.value.trim() || undefined })}
                  placeholder="main"
                  aria-label={t("workflows.studio.env.branch")}
                  spellCheck={false}
                  maxLength={120}
                />
              </Group>
            </div>
            <Group label={t("workflows.studio.env.setup")} hint={t("workflows.studio.env.setupHint")}>
              <input
                className={cx(input, "font-mono text-[13px]")}
                value={env.setup ?? ""}
                onChange={(e) => patch({ setup: e.target.value || undefined })}
                placeholder={container ? "pip install pandas openpyxl" : "npm ci"}
                aria-label={t("workflows.studio.env.setup")}
                spellCheck={false}
                maxLength={2000}
              />
            </Group>
            <p className="text-ink-2 m-0 text-xs">{t("workflows.studio.env.layout")}</p>

            {container ? (
              <>
                <Group label={t("workflows.studio.env.agent")} hint={t("workflows.studio.env.agentHint")}>
                  <input
                    className={cx(input, "font-mono text-[13px]")}
                    value={env.agent ?? ""}
                    onChange={(e) => patch({ agent: e.target.value || undefined })}
                    placeholder="claude -p"
                    aria-label={t("workflows.studio.env.agent")}
                    spellCheck={false}
                    maxLength={400}
                  />
                </Group>
                <Group label={t("workflows.studio.env.vars")} hint={t("workflows.studio.env.varsHint")}>
                  <ChipInput
                    label={t("workflows.studio.env.vars")}
                    values={env.env ?? []}
                    onChange={(v) => patch({ env: v.length ? v : undefined })}
                    placeholder="ANTHROPIC_API_KEY"
                    valid={(v) => ENV_NAME.test(v)}
                    mono
                  />
                </Group>
              </>
            ) : null}
            <Checkbox
              label={t("workflows.studio.env.keep")}
              hint={t("workflows.studio.env.keepHint")}
              checked={!!env.keep}
              onChange={(e) => patch({ keep: e.target.checked || undefined })}
            />
          </Advanced>
        </div>
      ) : (
        <p className="text-ink-2 m-0 text-[13px]">{t(env.kind === "assistant" ? "workflows.studio.env.assistantNote" : "workflows.studio.env.computerNote")}</p>
      )}

      {confirm ? (
        <Modal
          title={t("workflows.studio.env.dropTitle")}
          onClose={() => setConfirm(false)}
          footer={
            <>
              <button type="button" className={btn} onClick={() => setConfirm(false)}>
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className={btnPrimary}
                onClick={() => {
                  set((x) => withEnvironment(x, { kind: "assistant" }));
                  setConfirm(false);
                }}
              >
                {t("workflows.studio.env.dropConfirm")}
              </button>
            </>
          }
        >
          <p className="text-ink-soft m-0 text-sm">{t("workflows.studio.env.dropText", { count: commandCount(d.steps) })}</p>
        </Modal>
      ) : null}
    </SectionCard>
  );
}
