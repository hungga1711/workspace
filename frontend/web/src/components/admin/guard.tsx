import { notFound } from "next/navigation";
import { cache } from "react";
import { gw, GatewayError } from "@/lib/gateway";
import { Empty } from "@/components/ui/bits";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { AdminHeader } from "./AdminNav";
import { getT } from "@/lib/i18n/server";
import { canOpen, permTokens, sectionFeature } from "./page-perms";
import { requireFeature } from "@/lib/features";

async function deniedScreen() {
  const tx = await getT();
  return <Empty title={tx("admin.guard.ban_khong_co_quyen")}>{tx("admin.guard.nho_chu_workspace_cap")}</Empty>;
}

/**
 * Renders a clear "not allowed" state instead of an error page when a section needs a permission the
 * viewer lacks, and the admin 404 page for a record that does not exist (e.g. a wrong person id). A read that is
 * throttled (429) or failing (5xx) shows "load failed + retry" in the page's place, never the crash screen: the
 * frame, the menu and every other section stay usable.
 */
export async function adminLoad<T>(fn: () => Promise<T>): Promise<{ data: T } | { denied: React.ReactNode }> {
  try {
    return { data: await fn() };
  } catch (e) {
    if (e instanceof GatewayError && e.status === 403) return { denied: await deniedScreen() };
    if (e instanceof GatewayError && e.status === 404) notFound();
    if (e instanceof GatewayError && (e.status === 429 || e.status >= 500))
      return {
        denied: (
          <>
            <AdminHeader />
            <LoadFailed className="bg-surface shadow-card min-h-14 rounded-xl px-5 py-3.5" />
          </>
        ),
      };
    throw e;
  }
}

/**
 * The viewer's permission names, once per request. Null when they cannot be read: the screens then render as before
 * and every action is still checked by its module, so a hiccup never locks an admin out.
 */
export const viewerPermissions = cache(async (): Promise<Set<string> | null> => {
  try {
    return new Set(permTokens(await gw<{ permissions: string[]; workspaceWide?: string[] }>("/api/identity/me/permissions")));
  } catch {
    return null;
  }
});

/** The gate of an admin section by its path, from the same map as the admin menu (page-perms.ts). */
export async function sectionGate(href: string): Promise<React.ReactNode | null> {
  // A section of a feature the deployment left out (DISABLED_FEATURES) does not exist, whoever asks.
  const feature = sectionFeature(href);
  if (feature) await requireFeature(feature);
  return canOpen(await viewerPermissions(), href) ? null : deniedScreen();
}
