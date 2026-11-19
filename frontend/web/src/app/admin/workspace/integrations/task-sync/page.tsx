import { gw, GatewayError } from "@/lib/gateway";
import { getT } from "@/lib/i18n/server";
import { adminLoad, sectionGate } from "@/components/admin/guard";
import { AdminHeader } from "@/components/admin/AdminNav";
import { TaskSyncAdmin } from "@/components/admin/TaskSyncAdminLazy";
import type { SyncConnection } from "@/components/admin/TaskSyncAdmin";

/** Admin › Integrations › Task sync: Asana, ClickUp, Linear and Jira Cloud, read into projects for AI Insights. */
export default async function TaskSyncPage() {
  const gate = await sectionGate("/admin/workspace/integrations");
  if (gate) return gate;
  const tx = await getT();
  // 403 decides access; any other failure shows a retry in the section, not an error page.
  const r = await adminLoad(() =>
    gw<{ connections: SyncConnection[] }>("/api/work/task-sync").catch((e: unknown) => {
      if (e instanceof GatewayError && e.status === 403) throw e;
      return null;
    }),
  );
  if ("denied" in r) return r.denied;
  return (
    <>
      <AdminHeader title={tx("taskSync.title")} sub={tx("taskSync.sub")} />
      <TaskSyncAdmin connections={r.data?.connections ?? null} />
    </>
  );
}
