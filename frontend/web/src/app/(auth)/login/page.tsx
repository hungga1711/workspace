import type { Metadata } from "next";
import type { T } from "@/lib/i18n/core";
import { getT } from "@/lib/i18n/server";
import { authCard, cx } from "@/lib/ui";
import { safeNext } from "@/lib/auth";
import { LoginForm } from "./form";
import { config } from "@/lib/config";
import { DemoSignIn } from "./DemoSignIn";

export async function generateMetadata(): Promise<Metadata> {
  const tx = await getT();
  return { title: tx("signIn.loginPage.dang_nhap"), robots: { index: false } };
}

const NOTICE = (tx: T): Record<string, string> => ({
  reset: tx("signIn.loginPage.da_dat_mat_khau"),
  activated: tx("signIn.loginPage.tai_khoan_da_kich"),
  signed_out: tx("signIn.loginPage.ban_da_dang_xuat"),
  expired: tx("signIn.loginPage.phien_lam_viec_da"),
});

const ALERT = (tx: T): Record<string, [string, string]> => ({
  demo_failed: [tx("demo.failed"), ""],
});

/** Our own sign-in screen; credentials go to the BFF, which talks to the identity module server-side. */
export default async function Login({ searchParams }: { searchParams: Promise<{ next?: string; email?: string; notice?: string }> }) {
  const tx = await getT();
  const sp = await searchParams;
  return (
    <div className="grid w-full max-w-[400px] gap-5">
      {config.demoMode ? <DemoSignIn /> : null}
      <div className={cx(authCard, "!shadow-hero")}>
        <h1 className="font-display m-0 mb-6 text-center text-xl font-semibold tracking-tight">{tx("auth.signInTitle")}</h1>
        <LoginForm
          next={safeNext(sp.next)}
          email={sp.email ?? ""}
          notice={sp.notice ? (NOTICE(tx)[sp.notice] ?? null) : null}
          alert={sp.notice ? (ALERT(tx)[sp.notice] ?? null) : null}
        />
      </div>
      <p className="text-ink-2 m-0 text-center text-sm">{tx("auth.noAccount")}</p>
    </div>
  );
}
