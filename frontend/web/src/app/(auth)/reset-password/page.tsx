import type { Metadata } from "next";
import { getT } from "@/lib/i18n/server";
import Link from "next/link";
import { authCta, authCard, cx } from "@/lib/ui";
import { SetPasswordForm } from "@/components/auth/SetPassword";
import { inspectToken } from "./actions";

export async function generateMetadata(): Promise<Metadata> {
  const tx = await getT();
  return { title: tx("signIn.resetPasswordPage.dat_mat_khau_moi"), robots: { index: false } };
}

export default async function ResetPassword({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const tx = await getT();
  const { token = "" } = await searchParams;
  const t = await inspectToken(token);
  return (
    <div className={cx(authCard, "!shadow-hero")}>
      <h1 className="font-display m-0 mb-1 text-center text-xl font-semibold tracking-tight">{tx("signIn.resetPasswordPage.dat_mat_khau_moi")}</h1>
      {t ? (
        <SetPasswordForm token={token} email={t.email} purpose={t.purpose} />
      ) : (
        <div className="grid grid-cols-1 gap-4" role="alert">
          <p>{tx("signIn.resetPasswordPage.lien_ket_da_het")}</p>
          <Link href="/forgot-password" className={`${authCta} w-full`}>
            {tx("signIn.resetPasswordPage.gui_lien_ket_moi")}
          </Link>
        </div>
      )}
    </div>
  );
}
