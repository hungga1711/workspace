import { featureOn } from "@/lib/features";
import Link from "next/link";
import { gw } from "@/lib/gateway";
import { getT } from "@/lib/i18n/server";
import { aiStatus } from "@/lib/ai";
import { cx } from "@/lib/ui";
import { IconTile, type Tone } from "@/components/ui/Bento";
import { ChatIcon, ChevronRightIcon, InboxIcon, MeIcon, ShieldIcon, SparkleIcon, UsersIcon } from "@/components/app/icons";
import { WelcomeInvite } from "@/components/onboarding/WelcomeInvite";
import { BrandMark } from "@/components/ui/BrandMark";
import { permTokens } from "@/components/admin/page-perms";
import type { MessageKey } from "@/lib/i18n/core";

type Step = { key: string; href: string; icon: React.ReactNode; tone: Tone; title: MessageKey; body: MessageKey };

/**
 * First steps after joining, by role. The owner (workspace.configure) gets onboarding step 3 of 4: invite colleagues,
 * protect the account, connect AI tools. Managers get their team and approvals; everyone else their profile and
 * #general. When the company records AI use, everyone is pointed at the browser extension, the product's core.
 */
export default async function WelcomePage() {
  const t = await getT();
  const [perms, mfa, ai] = await Promise.all([
    gw<{ permissions: string[]; workspaceWide?: string[] }>("/api/identity/me/permissions")
      .then((r) => new Set(permTokens(r)))
      .catch(() => null),
    gw<{ enabled: boolean }>("/api/identity/me/mfa").catch(() => null),
    aiStatus(),
  ]);
  const owner = !!perms?.has("workspace.configure");
  const canInvite = !!perms?.has("member.invite");
  const manager = !owner && (!!perms?.has("approval.decide") || !!perms?.has("leave.approve") || canInvite);
  const role = owner ? "owner" : manager ? "manager" : "staff";

  const steps: Step[] = [];
  if (ai.monitoring) steps.push({ key: "ext", href: "/app/me?tab=ai", icon: <SparkleIcon />, tone: "violet", title: "onboarding.r2.extTitle", body: "onboarding.r2.extBody" });
  if (owner) steps.push({ key: "ai", href: "/admin/workspace/ai", icon: <SparkleIcon />, tone: "sky", title: "onboarding.r2.aiTitle", body: "onboarding.r2.aiBody" });
  if (manager) {
    if (await featureOn("time"))
      steps.push({ key: "team", href: "/app/time?tab=team", icon: <UsersIcon />, tone: "green", title: "onboarding.r2.teamTitle", body: "onboarding.r2.teamBody" });
    steps.push({ key: "approvals", href: "/app/work/ops", icon: <InboxIcon />, tone: "tangerine", title: "onboarding.r2.approvalsTitle", body: "onboarding.r2.approvalsBody" });
  }
  if (!owner) {
    steps.push({ key: "profile", href: "/app/me", icon: <MeIcon />, tone: "rose", title: "onboarding.r2.profileTitle", body: "onboarding.r2.profileBody" });
    steps.push({ key: "general", href: "/app/chat/general", icon: <ChatIcon />, tone: "sky", title: "onboarding.r2.generalTitle", body: "onboarding.r2.generalBody" });
  }
  if (mfa && !mfa.enabled)
    steps.push({
      key: "mfa",
      href: "/app/me?tab=security",
      icon: <ShieldIcon />,
      tone: "green",
      title: owner ? "onboarding.twoStepTitle" : "onboarding.r2.mfaTitle",
      body: owner ? "onboarding.twoStepBody" : "onboarding.r2.mfaBody",
    });

  return (
    <div className="mx-auto w-full max-w-[560px] pt-2 md:pt-8">
      <div className="mb-6">
        <BrandMark className="size-10" />
      </div>
      {owner ? <p className="text-ink-2 m-0 mb-1.5 text-[13px] tabular-nums">{t("onboarding.step", { n: 3, total: 4 })}</p> : null}
      <h1 data-page-title="" className="font-display text-ink m-0 text-balance text-[28px]/[1.15] font-semibold tracking-[-0.035em] max-sm:text-2xl/[1.2]">
        {t(owner ? "onboarding.inviteTitle" : (`onboarding.r2.${role}Title` as MessageKey))}
      </h1>
      <p className="text-ink-2 m-0 mt-2 text-pretty text-sm/[1.55]">{t(owner ? "onboarding.inviteIntro" : (`onboarding.r2.${role}Intro` as MessageKey))}</p>
      {owner ? (
        <div aria-hidden="true" className="mt-5 grid grid-cols-4 gap-1.5">
          {[1, 2, 3, 4].map((n) => (
            <span key={n} className={cx("h-1 rounded-full", n <= 3 ? "bg-signal" : "bg-progress-track")} />
          ))}
        </div>
      ) : null}
      {owner && canInvite ? (
        <section className="bg-surface shadow-card mt-6 rounded-xl p-5 max-sm:p-4">
          <WelcomeInvite />
        </section>
      ) : null}
      {steps.length ? (
        <ul className="bg-surface shadow-card divide-divider-soft m-0 mt-4 list-none divide-y overflow-hidden rounded-xl p-0">
          {steps.map((s) => (
            <li key={s.key}>
              <Link href={s.href} className="hover:bg-hover flex items-start gap-3.5 px-5 py-4 text-sm no-underline max-sm:px-4">
                <IconTile tone={s.tone}>{s.icon}</IconTile>
                <span className="min-w-0 flex-1">
                  <span className="text-ink block font-semibold tracking-[-0.01em]">{t(s.title)}</span>
                  <span className="text-ink-2 mt-0.5 block text-pretty text-[13px]/[1.5]">{t(s.body)}</span>
                </span>
                <ChevronRightIcon className="text-ink-2 mt-1 size-4 shrink-0" />
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      {owner ? (
        <aside className="border-divider mt-8 border-t pt-5 text-sm">
          <p className="m-0 font-medium">{t("onboarding.switchTitle")}</p>
          <p className="m-0 mt-2 flex flex-wrap gap-x-4 gap-y-1">
            <Link href="/admin/workspace/integrations">{t("onboarding.switchSlack")}</Link>
            <Link href="/app/work/tasks?view=projects">{t("onboarding.switchJira")}</Link>
          </p>
        </aside>
      ) : (
        <p className="mt-6">
          <Link href="/app/home" className="text-ink-2 text-sm">
            {t("onboarding.r2.goHome")}
          </Link>
        </p>
      )}
    </div>
  );
}
