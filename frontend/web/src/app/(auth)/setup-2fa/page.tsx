import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getT } from "@/lib/i18n/server";
import { freshSession } from "@/lib/session";
import { authCard, cx } from "@/lib/ui";
import { TwoStep } from "@/components/me/TwoStep";

export async function generateMetadata(): Promise<Metadata> {
  const tx = await getT();
  return { title: tx("auth.twoStep.title"), robots: { index: false } };
}

/** Where a workspace that requires two-step sign-in sends a session that has not set it up yet. */
export default async function SetupTwoStep() {
  // Signed out: plain sign-in, not a "session expired" scare; a workspace that requires two-step sign-in sends the
  // person back here after signing in.
  if (!(await freshSession())) redirect("/login");
  const tx = await getT();
  return (
    <div className="grid w-full max-w-[460px] gap-5">
      <div className={cx(authCard, "!shadow-hero")}>
        <h1 className="font-display m-0 mb-1 text-center text-xl font-semibold tracking-tight">{tx("auth.twoStep.gateTitle")}</h1>
        <p className="text-ink-2 mb-6 mt-1 text-center text-sm">{tx("auth.twoStep.gateLead")}</p>
        <TwoStep gate />
      </div>
      <form method="post" action="/auth/logout" className="text-center">
        <button type="submit" className="text-ink-2 text-sm hover:underline">
          {tx("auth.twoStep.signOut")}
        </button>
      </form>
    </div>
  );
}
