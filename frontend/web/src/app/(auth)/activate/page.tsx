import type { Metadata } from "next";
import { getT } from "@/lib/i18n/server";
import Link from "next/link";
import { authCard, cx } from "@/lib/ui";
import { SetPasswordForm } from "@/components/auth/SetPassword";
import { inspectToken } from "../reset-password/actions";

export async function generateMetadata(): Promise<Metadata> {
  const tx = await getT();
  return { title: tx("signIn.activatePage.kich_hoat_tai_khoan"), robots: { index: false } };
}

/** Invite activation: the invitee chooses a password and is signed straight in. */
export default async function Activate({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const tx = await getT();
  const { token = "" } = await searchParams;
  const t = await inspectToken(token);
  return (
    <div className={cx(authCard, "!shadow-hero")}>
      <h1 className="font-display m-0 mb-1 text-center text-xl font-semibold tracking-tight">{tx("signIn.activatePage.chao_mung_ban_den")}</h1>
      <p className="text-ink-2 mb-4 mt-1 text-center text-sm">{tx("signIn.activatePage.dat_mat_khau_de")}</p>
      {t ? (
        <SetPasswordForm token={token} email={t.email} purpose="activate" />
      ) : (
        <div className="grid grid-cols-1 gap-3" role="alert">
          <p>{tx("signIn.activatePage.loi_moi_da_het")}</p>
          <p className="text-ink-2 text-sm">
            {tx("signIn.activatePage.nho_quan_tri_vien")} <Link href="/login">{tx("signIn.activatePage.dang_nhap")}</Link> {tx("signIn.activatePage.neu_ban_da_kich")}
          </p>
        </div>
      )}
    </div>
  );
}
