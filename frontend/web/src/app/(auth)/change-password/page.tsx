import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getLocale, getMessages, getT } from "@/lib/i18n/server";
import { CHANGE_PASSWORD_EXTRA } from "@/lib/i18n/areas";
import { I18nProvider } from "@/lib/i18n/client";
import { safeNext } from "@/lib/auth";
import { freshSession } from "@/lib/session";
import { authCard, cx } from "@/lib/ui";
import { ChangePasswordForm } from "@/components/me/ChangePassword";

export async function generateMetadata(): Promise<Metadata> {
  const tx = await getT();
  return { title: tx("auth.passwordGate.title"), robots: { index: false } };
}

/**
 * Where a session with a temporary password lands (admin reset, invite with a password): the gateway refuses
 * everything else until the person picks their own password, so this screen has no way around it but sign-out.
 */
export default async function ChangePasswordGate({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const next = safeNext((await searchParams).next);
  // Signed out (an old bookmark, a shared link): plain sign-in, not a "session expired" scare. A temporary password
  // brings the person back here after signing in (the gateway's password gate), so no return path is needed.
  if (!(await freshSession())) redirect(next !== "/app/home" ? `/login?next=${encodeURIComponent(next)}` : "/login");
  const tx = await getT();
  // The sign-in screens ship only their own message groups; the form's labels live in me.changepassword.
  const messages = await getMessages("signIn", CHANGE_PASSWORD_EXTRA);
  return (
    <div className="grid w-full max-w-[460px] gap-5">
      <div className={cx(authCard, "!shadow-hero")}>
        <h1 className="font-display m-0 mb-1 text-center text-xl font-semibold tracking-tight">{tx("auth.passwordGate.title")}</h1>
        <p className="text-ink-2 mb-6 mt-1 text-center text-sm">{tx("auth.passwordGate.lead")}</p>
        <I18nProvider locale={await getLocale()} messages={messages}>
          <ChangePasswordForm next={next} />
        </I18nProvider>
      </div>
      <form method="post" action="/auth/logout" className="text-center">
        <button type="submit" className="text-ink-2 text-sm hover:underline">
          {tx("auth.passwordGate.signOut")}
        </button>
      </form>
    </div>
  );
}
