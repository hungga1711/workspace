import { gw } from "@/lib/gateway";
import { adminLoad, sectionGate } from "@/components/admin/guard";
import { SecurityAdmin, SignInLog, type SignIn } from "@/components/admin/SecurityAdmin";
import { AccessReview, type ReviewKey, type ReviewMember } from "@/components/admin/AccessReview";
import { MfaPolicy } from "@/components/admin/MfaPolicy";
import { getT } from "@/lib/i18n/server";
import { LoadFailed } from "@/components/ui/LoadFailed";

export default async function SecurityPage({ searchParams }: { searchParams: Promise<{ failed?: string }> }) {
  const gate = await sectionGate("/admin/workspace/security");
  if (gate) return gate;
  const { failed } = await searchParams;
  const r = await adminLoad(() =>
    Promise.all([
      gw<{ signIns: SignIn[]; summary: { logins24h: number; failures24h: number; activeUsers7d: number } }>(`/api/identity/security/sign-ins${failed === "1" ? "?failed=1" : ""}`),
      // The sign-in log is the page; the access review and the two-step policy are sections that show a retry when
      // their read fails rather than taking the log down with them.
      gw<{ members: ReviewMember[]; apiKeys: ReviewKey[] }>("/api/identity/security/access-review").catch(() => null),
      gw<{ required: boolean }>("/api/identity/security/mfa-policy").catch(() => null),
      gw<{ enabled: boolean }>("/api/identity/me/mfa").catch(() => null),
    ]),
  );
  if ("denied" in r) return r.denied;
  const [log, review, policy, mine] = r.data;
  const tx = await getT();
  return (
    <>
      <SecurityAdmin summary={log.summary} />
      {policy && mine ? <MfaPolicy required={policy.required} selfEnabled={mine.enabled} /> : <LoadFailed what={tx("auth.twoStep.policyTitle")} className="my-6" />}
      {review ? <AccessReview members={review.members} apiKeys={review.apiKeys} /> : <LoadFailed what={tx("admin.accessreview.ra_soat_quyen_truy")} className="mt-8" />}
      <SignInLog signIns={log.signIns} failedOnly={failed === "1"} />
    </>
  );
}
