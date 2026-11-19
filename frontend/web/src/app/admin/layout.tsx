import { I18nScope } from "@/lib/i18n/scope";
import type { Metadata } from "next";
import { headers } from "next/headers";
import type { MessageKey } from "@/lib/i18n/core";
import { getT } from "@/lib/i18n/server";
import Link from "next/link";
import { Suspense } from "react";
import { TopProgress } from "@/components/app/TopProgress";
import { redirect } from "next/navigation";
import { gw, signInUrl } from "@/lib/gateway";
import { DirectoryProvider, type Person } from "@/lib/people";
import { freshSession } from "@/lib/session";
import { ChevronLeftIcon } from "@/components/app/icons";
import { AdminFrame, AdminNav, AdminPermsProvider, AdminTitle } from "@/components/admin/AdminNav";
import { viewerPermissions } from "@/components/admin/guard";
import { WorkspaceLogo } from "@/components/shell/WorkspaceHeader";
import { StatusScreen } from "@/components/ui/StatusScreen";
import { btnGhost, btnPrimary, btnSm, cx, skeleton } from "@/lib/ui";
import { PageSkeleton } from "@/components/ui/PageSkeleton";
import { DemoBanner } from "@/components/shell/DemoBanner";
import { MotionProvider } from "@/components/app/MotionProvider";
import { FeaturesProvider } from "@/lib/features-context";

/** Tab title from the admin section being viewed (same labels as AdminNav). */
const SECTION: Record<string, MessageKey> = {
  "/admin/workspace": "admin.adminnav.tong_quan",
  "/admin/workspace/members": "admin.adminnav.thanh_vien",
  "/admin/workspace/teams": "admin.adminnav.team_phong_ban",
  "/admin/workspace/roles": "admin.adminnav.vai_tro_quyen",
  "/admin/workspace/attendance": "admin.adminnav.bang_cham_cong",
  "/admin/workspace/leave": "admin.adminnav.phep_nam",
  "/admin/workspace/leave/requests": "admin.adminnav.don_nghi",
  "/admin/workspace/holidays": "admin.adminnav.ngay_nghi_le",
  "/admin/workspace/settings": "admin.adminnav.cai_dat_tinh_nang",
  "/admin/workspace/announcements": "admin.adminnav.thong_bao_cong_ty",
  "/admin/workspace/custom-fields": "admin.adminnav.truong_tuy_chinh",
  "/admin/workspace/security": "admin.adminnav.dang_nhap_bao_mat",
  "/admin/workspace/audit": "admin.adminnav.nhat_ky_hoat_dong",
  "/admin/workspace/integrations": "admin.adminnav.tich_hop",
  "/admin/workspace/errors": "admin.adminnav.loi_trinh_duyet",
};
/** Sections whose nav label is the same in every language. */
const LITERAL: Record<string, string> = { "/admin/workspace/agents": "AI agent" };

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  const path = new URL((await headers()).get("x-pathname") ?? "/admin/workspace", "http://x").pathname;
  const hit = [...Object.keys(SECTION), ...Object.keys(LITERAL)].filter((h) => path === h || path.startsWith(`${h}/`)).sort((a, b) => b.length - a.length)[0];
  const admin = t("admin.layout.quan_tri");
  return { robots: { index: false, follow: false }, title: hit ? `${LITERAL[hit] ?? t(SECTION[hit]!)} · ${admin}` : admin };
}

/** Admin lives under its own route group: none of this code ships with Home/Chat/Work. */
async function AdminLayoutInner({ children }: { children: React.ReactNode }) {
  const tx = await getT();
  const session = await freshSession();
  if (!session) redirect(await signInUrl());
  const [members, ws, perms] = await Promise.all([
    gw<{ members: Person[]; me: (Person & { isOwner: boolean }) | null; total: number; nextCursor: string | null }>("/api/identity/members/summary?limit=300").catch(() => ({
      members: [] as Person[],
      me: null,
      total: 0,
      nextCursor: null,
    })),
    gw<{ config: { branding: { displayName: string; primaryColor: string; logoUrl?: string | null } }; features: Record<string, boolean> }>("/api/platform/workspace").catch(
      () => null,
    ),
    viewerPermissions(),
  ]);
  // Someone whose only role is Employee has nothing to administer: say so instead of showing tools that
  // would refuse every change (the modules still check each action; this is about not misleading people).
  const meRow = (members.me ?? members.members.find((m) => m.userId === session.userId)) as (Person & { isOwner?: boolean }) | undefined;
  const employeeOnly = !!meRow && !meRow.isOwner && (meRow.roles ?? []).every((r) => r === "Employee");
  if (employeeOnly)
    return (
      <StatusScreen
        page
        code="403"
        title={tx("admin.layout.onlyAdmins")}
        body={tx("admin.layout.onlyAdminsBody")}
        actions={
          <Link href="/app/home" className={btnPrimary}>
            {tx("admin.layout.ve_ung_dung")}
          </Link>
        }
      />
    );
  return (
    <DirectoryProvider me={session.userId} people={members.members} total={members.total} complete={members.nextCursor === null}>
      <FeaturesProvider features={ws?.features ?? {}}>
        <AdminPermsProvider perms={perms ? [...perms] : null} features={ws?.features ?? null}>
          <Suspense>
            <TopProgress />
          </Suspense>
          {/* Same frame as the app: sidebar on the grey ground, content on the floating panel under a 60px bar,
          so moving between the app and Quản trị does not make the page jump. */}
          {/* The app's frame: a flush sidebar a step off white, a hairline, the white content. */}
          <div className="bg-panel min-h-dvh md:flex">
            <aside className="bg-frame md:border-hairline min-w-0 md:sticky md:top-0 md:h-dvh md:w-14 md:shrink-0 md:self-start md:overflow-y-auto md:border-r lg:w-[232px]">
              <div className="flex h-12 items-center gap-1 px-2">
                <Link
                  href="/admin/workspace"
                  title={tx("admin.layout.quan_tri")}
                  className="text-ink hover:bg-hover flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 no-underline md:max-lg:justify-center md:max-lg:px-0"
                >
                  <WorkspaceLogo
                    name={ws?.config.branding.displayName ?? "Workspace"}
                    color={null}
                    logoUrl={ws?.config.branding.logoUrl}
                    className="size-5 rounded-[5px] text-[11px]"
                  />
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold md:max-lg:sr-only" title={ws?.config.branding.displayName}>
                    {tx("admin.layout.quan_tri")}
                  </span>
                </Link>
                {/* Phones have no top bar: the way back sits on the brand row. */}
                <Link href="/app/home" className="text-ink-2 hover:text-ink hover:bg-hover flex h-9 shrink-0 items-center gap-1 rounded-md px-2.5 text-sm no-underline md:hidden">
                  <ChevronLeftIcon className="size-4" />
                  {tx("admin.layout.ve_ung_dung")}
                </Link>
              </div>
              <AdminNav features={ws?.features ?? null} />
            </aside>
            <div className="bg-panel flex min-w-0 flex-1 flex-col max-md:min-h-[calc(100dvh-64px)] md:min-h-dvh">
              <div className="bg-surface sticky top-0 z-20 hidden md:block print:hidden">
                {/* One title per screen: "Quản trị / Thành viên" on the left, the way back on the right. */}
                <div className="border-hairline bg-surface flex h-12 items-center gap-3 border-b px-4">
                  <div className="flex min-w-0 flex-1">
                    <AdminTitle />
                  </div>
                  <Link href="/app/home" className={cx(btnGhost, btnSm, "shrink-0")}>
                    <ChevronLeftIcon className="size-4" />
                    {tx("admin.layout.ve_ung_dung")}
                  </Link>
                </div>
              </div>
              {/* The app's page column (components/shell/Main `pageColumn`, copied: that module is a client one), so
              Quản trị is as wide as every other destination. */}
              <main id="main" className="mx-auto w-full max-w-[1600px] px-4 pb-16 pt-4 md:px-7 md:pt-5">
                <AdminFrame>{children}</AdminFrame>
              </main>
            </div>
          </div>
        </AdminPermsProvider>
      </FeaturesProvider>
    </DirectoryProvider>
  );
}

/** The admin frame while its data loads: same columns and bar heights as the real one, so nothing jumps. */
function AdminFrameSkeleton() {
  return (
    <div className="bg-panel min-h-dvh md:flex">
      <div className="md:bg-frame md:border-hairline md:h-dvh md:w-14 md:shrink-0 md:border-r lg:w-[232px]" aria-hidden="true">
        <div className="grid gap-1.5 px-2 pb-3 pt-2">
          <span className={cx(skeleton, "h-8 w-full")} />
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <span key={i} className={cx(skeleton, "hidden h-[30px] w-full md:block")} />
          ))}
        </div>
      </div>
      <div className="bg-panel min-w-0 flex-1 md:min-h-dvh">
        <div className="border-hairline hidden h-12 border-b md:block" />
        <div className="mx-auto w-full max-w-[1600px] px-4 pb-16 pt-4 md:px-7 md:pt-5">
          <PageSkeleton />
        </div>
      </div>
    </div>
  );
}

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <I18nScope area="admin">
      {/* Dialogs (Modal) are motion `m` elements: without the features they keep their initial opacity 0. */}
      <MotionProvider>
        <DemoBanner />
        {/* The frame waits on members and the workspace: show its outline at once instead of a blank page. */}
        <Suspense fallback={<AdminFrameSkeleton />}>
          <AdminLayoutInner>{children}</AdminLayoutInner>
        </Suspense>
      </MotionProvider>
    </I18nScope>
  );
}
