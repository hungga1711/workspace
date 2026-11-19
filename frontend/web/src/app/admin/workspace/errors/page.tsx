import { gw, GatewayError } from "@/lib/gateway";
import { getT } from "@/lib/i18n/server";
import { adminLoad, sectionGate } from "@/components/admin/guard";
import { AdminHeader } from "@/components/admin/AdminNav";
import { BrowserErrors } from "@/components/admin/BrowserErrorsLazy";
import type { ErrorGroup, ErrorOccurrence } from "@/components/admin/BrowserErrors";

/** Admin › Lỗi trình duyệt: the errors people hit on screen, found by the code the error screen showed them. */
export default async function BrowserErrorsPage({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
  const gate = await sectionGate("/admin/workspace/errors");
  if (gate) return gate;
  const tx = await getT();
  const code = (await searchParams).code?.trim().toUpperCase().slice(0, 40) ?? "";
  // The list decides access (403 → the "not allowed" screen); a code in the address is looked up alongside it and
  // fails on its own (an unknown code is simply not shown).
  const r = await adminLoad(async () => {
    const [list, found] = await Promise.all([
      gw<{ groups: ErrorGroup[]; days: number }>("/api/platform/client-errors").catch((e: unknown) => {
        if (e instanceof GatewayError && e.status === 403) throw e;
        return null;
      }),
      code ? gw<{ occurrence: ErrorOccurrence }>(`/api/platform/client-errors?code=${encodeURIComponent(code)}`).catch(() => null) : null,
    ]);
    return { list, found };
  });
  if ("denied" in r) return r.denied;
  return (
    <>
      <AdminHeader title={tx("admin.errors.title")} sub={tx("admin.errors.sub")} />
      <BrowserErrors groups={r.data.list?.groups ?? null} days={r.data.list?.days ?? 30} found={r.data.found?.occurrence ?? null} failed={!r.data.list} />
    </>
  );
}
