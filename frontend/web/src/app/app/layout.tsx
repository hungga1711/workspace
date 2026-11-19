import { I18nScope } from "@/lib/i18n/scope";
import type { Metadata } from "next";
import { btn } from "@/lib/ui";
import { redirect, unstable_rethrow } from "next/navigation";
import { TopBar } from "@/components/app/TopBar";
import { Sidebar } from "@/components/shell/Sidebar";
import { BottomTabs } from "@/components/shell/BottomTabs";
import { Main } from "@/components/shell/Main";
import { ScreenTitleProvider } from "@/components/shell/ScreenTitle";
import type { ChannelSummary, ShellAttendance } from "@/components/shell/types";
import { gw, GatewayError, signInUrl } from "@/lib/gateway";
import { DirectoryProvider, type Person } from "@/lib/people";
import { MotionProvider } from "@/components/app/MotionProvider";
import { ToastProvider } from "@/components/ui/Toast";
import { TopProgress } from "@/components/app/TopProgress";
import { StatusProvider } from "@/lib/status";
import { CallListener } from "@/components/call/CallListener";
import { AskLauncher } from "@/components/ai/panel/AskLauncher";
import { Suspense } from "react";
import { DemoBanner } from "@/components/shell/DemoBanner";
import { freshSession } from "@/lib/session";
import { getT } from "@/lib/i18n/server";
import type { T } from "@/lib/i18n/core";
import { aiStatus } from "@/lib/ai";
import { AiProvider } from "@/lib/ai-context";
import { FeaturesProvider } from "@/lib/features-context";
import { workspaceInfo } from "@/lib/features";
import { TaskRefsProvider } from "@/lib/task-refs";
import { CatchBoundary } from "@/components/ui/CatchBoundary";

export const metadata: Metadata = { robots: { index: false, follow: false } };

interface Workspace {
  workspace: { name: string };
  features?: Record<string, boolean>;
  config: { branding: { displayName: string; primaryColor: string; logoUrl?: string | null }; codeFormats?: { task?: string } };
}

/** The platform's default branding colour: the workspace keeps the standard mark until an admin picks its own. */
const DEFAULT_BRAND_COLOR = "#163b7a";

/**
 * App shell: the grey ground with the sidebar (workspace switcher, destinations, channels, direct
 * messages) and the content on one floating white panel under its top bar. One request each to the BFF, all
 * started together; channel and member lists are shared with every screen below.
 */
/** The workspace as last read: one installation holds one workspace, so this is safe to share across requests. */
let lastWorkspace: Workspace | null = null;
type MembersSummary = { members: Person[]; me: (Person & { isOwner: boolean }) | null; total: number; nextCursor: string | null };
/** The directory's first page as last read (the same for everyone; `me` is dropped when it is reused). */
let lastMembers: MembersSummary | null = null;

async function AppLayoutInner({ children }: { children: React.ReactNode }) {
  const session = await freshSession();
  const t = await getT();
  if (!session) redirect(await signInUrl());
  // All four at once (one round trip, not two); the others are only used once the workspace answered.
  const rest = Promise.all([
    gw<{ badge: number }>("/api/home/notifications").catch(() => ({ badge: 0 })),
    gw<{ channels: ChannelSummary[] }>("/api/chat/channels").catch(() => ({ channels: [] })),
    // The first page of the directory (names, status) plus the caller's own row with roles; not every member.
    gw<MembersSummary>("/api/identity/members/summary?limit=300").then(
      (m) => ((lastMembers = m), m),
      // A failed read keeps the directory last seen (names and avatars across the app), never an empty one.
      (): MembersSummary => (lastMembers ? { ...lastMembers, me: null } : { members: [], me: null, total: 0, nextCursor: null }),
    ),
    aiStatus(),
  ]);
  // Shared with the pages below (lib/features.ts): one read per request.
  const workspaceP = workspaceInfo<Workspace>();
  // The top bar's check-in pill: only asked for when the workspace uses attendance (no cost otherwise).
  const attendanceP = workspaceP
    .then((w) =>
      w.features?.attendance ? gw<{ attendanceToday: ShellAttendance["today"] }>("/api/employee/me").then((m): ShellAttendance => ({ today: m.attendanceToday ?? null })) : null,
    )
    .catch(() => null);
  let workspace: Workspace;
  try {
    workspace = await workspaceP;
    lastWorkspace = workspace;
  } catch (e) {
    // A signed-out or revoked session (offboarding revokes them) is gw()'s redirect to sign-in: let it through.
    unstable_rethrow(e);
    // Disabled by an admin (offboarding) or removed from the workspace.
    if (e instanceof GatewayError && e.status === 403 && (e.body as { error?: string } | null)?.error === "not a member of this workspace") return <NoAccess t={t} />;
    // Anything else (a slow or restarting server): keep the shell with the branding last seen (one installation, one
    // workspace), so the page's own sections can say what did not load instead of the app turning into an error
    // screen or showing the product's name where the company's was.
    workspace = lastWorkspace ?? { workspace: { name: "" }, features: {}, config: { branding: { displayName: "", primaryColor: DEFAULT_BRAND_COLOR, logoUrl: null } } };
  }

  const [[inbox, chat, members, aiState], attendance] = await Promise.all([rest, attendanceP]);
  // The AI switches (Admin › AI): assistant off hides Trợ lý AI, @AI and AI buttons; monitoring off hides the AI tabs.
  const ai = { assistant: aiState.assistant, monitoring: aiState.monitoring, assistantWanted: aiState.assistantWanted };
  const meRow = members.me ?? members.members.find((m) => m.userId === session.userId);
  const brandColor = workspace.config.branding.primaryColor;
  const logoColor = brandColor.toLowerCase() === DEFAULT_BRAND_COLOR ? null : brandColor;
  const user = {
    userId: session.userId,
    name: meRow?.displayName ?? session.name,
    email: session.email,
    isAdmin: Boolean((meRow as { isOwner?: boolean } | undefined)?.isOwner || meRow?.roles?.some((r) => r === "Owner" || r === "Admin")),
  };
  return (
    <DirectoryProvider
      me={session.userId}
      people={members.members.map(({ userId, displayName, status, avatarVersion, nickname }) => ({
        userId,
        displayName,
        status,
        ...(avatarVersion ? { avatarVersion } : {}),
        ...(nickname ? { nickname } : {}),
      }))}
      total={members.total}
      complete={members.nextCursor === null}
    >
      <FeaturesProvider features={workspace.features ?? {}}>
        <AiProvider flags={ai}>
          <TaskRefsProvider format={workspace.config.codeFormats?.task}>
            <StatusProvider>
              <MotionProvider>
                <ToastProvider>
                  <Suspense>
                    <TopProgress />
                  </Suspense>
                  <DemoBanner />
                  <div className="bg-panel flex min-h-dvh print:block">
                    <Sidebar
                      workspace={workspace.config.branding.displayName}
                      logoColor={logoColor}
                      logoUrl={workspace.config.branding.logoUrl}
                      channels={chat.channels}
                      memberCount={members.total}
                      user={user}
                      insightsOnly={Boolean(workspace.features?.insightsOnly)}
                    />
                    {/* The content: white and flush, a hairline from the sidebar; no floating panel. */}
                    {/* ScreenTitleProvider: pages hand the top bar an entity's name and their phone switcher (one title per screen). */}
                    <ScreenTitleProvider>
                      <div className="bg-panel flex min-h-dvh min-w-0 flex-1 flex-col">
                        <TopBar
                          badge={inbox.badge}
                          user={user}
                          workspace={workspace.config.branding.displayName}
                          logoColor={logoColor}
                          logoUrl={workspace.config.branding.logoUrl}
                          attendance={attendance}
                        />
                        <Main>
                          <CatchBoundary>{children}</CatchBoundary>
                        </Main>
                      </div>
                    </ScreenTitleProvider>
                  </div>
                  <BottomTabs mentions={chat.channels.some((c) => c.mentions > 0)} insightsOnly={Boolean(workspace.features?.insightsOnly)} />
                  <CallListener me={session.userId} />
                  {/* Ask AI beside any screen (⌘J); loads on first use. */}
                  <AskLauncher />
                </ToastProvider>
              </MotionProvider>
            </StatusProvider>
          </TaskRefsProvider>
        </AiProvider>
      </FeaturesProvider>
    </DirectoryProvider>
  );
}

function NoAccess({ t }: { t: T }) {
  return (
    <main id="main" className="mx-auto grid min-h-dvh max-w-lg content-center gap-4 p-6 text-center">
      <h1 className="font-display text-xl font-semibold">{t("shell.access.noAccessTitle")}</h1>
      <p className="text-ink-2">{t("shell.access.noAccessBody")}</p>
      <div className="flex justify-center gap-2">
        <form method="post" action="/auth/logout">
          <button type="submit" className={btn}>
            {t("shell.top.logout")}
          </button>
        </form>
      </div>
    </main>
  );
}

/** `peek`: tasks, approvals and meetings opened from inside the app show over the page; see app/app/@peek. */
export default async function AppLayout({ children, peek }: { children: React.ReactNode; peek: React.ReactNode }) {
  return (
    <I18nScope area="app">
      <AppLayoutInner>
        {children}
        {peek}
      </AppLayoutInner>
    </I18nScope>
  );
}
