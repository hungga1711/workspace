import { I18nScope } from "@/lib/i18n/scope";
import Link from "next/link";
import { headers } from "next/headers";
import { BrandMark } from "@/components/ui/BrandMark";
import { getLocale, getT } from "@/lib/i18n/server";
import { cx, menuItem, popover } from "@/lib/ui";
import { LOCALES, LOCALE_NAME } from "@/lib/i18n/config";
import { CheckIcon, ChevronDownIcon, GlobeIcon } from "@/components/app/icons";
import { getWorkspaceLogoUrl } from "@/lib/setup";

/** Sign-in, setup and account recovery: one centred column on the plain ground, server-rendered, no app JavaScript. */
async function AuthLayoutInner({ children }: { children: React.ReactNode }) {
  const tx = await getT();
  const locale = await getLocale();
  const here = new URL((await headers()).get("x-pathname") ?? "/login", "http://x");
  const path = here.pathname + here.search;
  const logoUrl = await getWorkspaceLogoUrl();
  return (
    <div className="bg-ground relative isolate grid min-h-dvh grid-rows-[auto_1fr_auto] overflow-x-clip">
      {/* The landing page's ground: a dot grid fading down from the top and one soft light behind the
          card. CSS only, like the rest of these screens. */}
      <span aria-hidden="true" className="dot-grid pointer-events-none absolute inset-x-0 top-0 -z-10 h-[70vh] [mask-image:radial-gradient(60%_70%_at_50%_0%,black,transparent)]" />
      <span aria-hidden="true" className="glow pointer-events-none absolute left-1/2 top-[8vh] -z-10 size-[44rem] -translate-x-1/2 [--glow:var(--violet)] max-sm:size-[22rem]" />
      <header className="flex items-center justify-end px-5 py-4 sm:px-8">
        {/* A list, not buttons, so more languages fit; <details> opens it without the app's JavaScript. */}
        <details className="group relative">
          <summary
            aria-label={tx("common.language")}
            className="text-ink-2 hover:bg-hover hover:text-ink flex h-8 cursor-pointer list-none items-center gap-1.5 rounded-md px-2.5 text-xs [&::-webkit-details-marker]:hidden"
          >
            <GlobeIcon className="size-4" />
            {LOCALE_NAME[locale]}
            <ChevronDownIcon className="size-3.5 transition-transform group-open:rotate-180" />
          </summary>
          <ul className={cx(popover, "absolute right-0 z-10 m-0 mt-1 min-w-40 list-none")}>
            {LOCALES.map((l) => (
              <li key={l}>
                <a
                  href={`/locale?l=${l}&next=${encodeURIComponent(path)}`}
                  hrefLang={l}
                  lang={l}
                  aria-current={l === locale ? "true" : undefined}
                  className={cx(menuItem, "no-underline", l === locale && "font-medium")}
                >
                  <span className="flex-1">{LOCALE_NAME[l]}</span>
                  {l === locale ? <CheckIcon className="text-ink-2 size-4" /> : null}
                </a>
              </li>
            ))}
          </ul>
        </details>
      </header>
      <main id="main" className="grid place-items-center px-4 pb-16 pt-4">
        <div className="grid w-full justify-items-center gap-6">
          <Link href="/" className="flex items-center gap-2 text-base no-underline" aria-label="workspace">
            {logoUrl ? (
              // The company's own logo once an admin uploaded one (Admin › Cài đặt); a small mark, so a plain <img>.
              <img src={logoUrl} alt="" className="h-9 max-w-40 object-contain" />
            ) : (
              <BrandMark className="size-9" />
            )}
          </Link>
          {children}
        </div>
      </main>
      <footer className="text-ink-2 px-5 py-5 text-center text-xs sm:px-8">{tx("auth.footer")}</footer>
    </div>
  );
}

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <I18nScope area="signIn">
      <AuthLayoutInner>{children}</AuthLayoutInner>
    </I18nScope>
  );
}
