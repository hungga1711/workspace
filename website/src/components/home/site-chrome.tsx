import Link from "next/link";
import { Mark } from "@/components/brand";
import { SITE, repoFile } from "@/lib/site";
import { NAV } from "@/lib/nav";
import { HeaderNav } from "./header-nav";
import { Container, GitHubIcon } from "./primitives";

const external = (href: string) => (href.startsWith("http") ? { target: "_blank", rel: "noreferrer" } : {});

const small =
  "h-8 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal";

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-transparent bg-ground/60 backdrop-blur-md transition-[border-color,background-color] duration-300 data-scrolled:border-hair data-scrolled:bg-ground/85">
      <Container className="flex h-14 items-center gap-4 md:gap-8">
        <Link href="/" aria-label="Workspace home" className="flex items-center gap-2 text-ink">
          <Mark className="size-7" />
          <span className="text-[1.0625rem] font-medium tracking-[-0.04em]">Workspace</span>
        </Link>
        <HeaderNav />
        <div className="ml-auto flex items-center gap-2">
          <a
            href={SITE.demo}
            target="_blank"
            rel="noreferrer"
            className={`${small} hidden bg-panel text-ink shadow-[0_0_0_1px_var(--color-hair)] hover:bg-[var(--color-muted)] sm:inline-flex`}
          >
            Live demo
          </a>
          <a
            href={SITE.repo}
            target="_blank"
            rel="noreferrer"
            className={`${small} hidden bg-panel text-ink shadow-[0_0_0_1px_var(--color-hair)] hover:bg-[var(--color-muted)] sm:inline-flex`}
          >
            <GitHubIcon className="size-3.5" />
            GitHub
          </a>
          <Link href="/docs/quick-start" className={`${small} inline-flex bg-ink text-ground hover:bg-[#d4d4d4]`}>
            Get started
          </Link>
          <details className="relative lg:hidden">
            <summary
              className={`${small} flex cursor-pointer list-none bg-panel px-2 text-ink shadow-[0_0_0_1px_var(--color-hair)] [&::-webkit-details-marker]:hidden`}
              aria-label="Menu"
            >
              <svg viewBox="0 0 16 16" className="size-4" fill="none" aria-hidden>
                <path d="M2.5 5.5h11M2.5 10.5h11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </summary>
            <div className="absolute right-0 mt-2 w-56 rounded-xl bg-panel p-1.5 shadow-[0_0_0_1px_var(--color-hair),0_8px_24px_rgba(0,0,0,0.08)]">
              {[...NAV, { label: "Live demo", href: SITE.demo }, { label: "GitHub", href: SITE.repo }].map((n) => (
                <Link
                  key={n.href}
                  href={n.href}
                  {...external(n.href)}
                  className="block rounded-md px-3 py-2 text-sm text-ink hover:bg-[var(--color-muted)] focus-visible:outline-2 focus-visible:outline-signal"
                >
                  {n.label}
                </Link>
              ))}
            </div>
          </details>
        </div>
      </Container>
    </header>
  );
}

const FOOTER = [
  {
    title: "Product",
    links: [
      { label: "Live demo", href: SITE.demo },
      { label: "Agent workflows", href: "/#workflows" },
      { label: "How it fits", href: "/#overview" },
      { label: "Measure AI", href: "/#measure" },
    ],
  },
  {
    title: "Docs",
    links: [
      { label: "Quick start", href: "/docs/quick-start" },
      { label: "Self-hosting", href: "/docs/self-hosting/configuration" },
      { label: "Contributor guide", href: "/docs/advanced" },
    ],
  },
  {
    title: "Project",
    links: [
      { label: "GitHub", href: SITE.repo },
      { label: "Changelog", href: repoFile("CHANGELOG.md") },
      { label: "Security", href: repoFile("SECURITY.md") },
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className="border-t border-hair bg-[#050505]">
      <Container className="grid gap-10 py-14 sm:grid-cols-3 lg:grid-cols-[1.6fr_1fr_1fr_1fr]">
        <div className="sm:col-span-3 lg:col-span-1">
          <Link href="/" className="inline-flex items-center gap-2.5 text-ink" aria-label="Workspace home">
            <Mark className="size-7" />
            <span className="text-base font-medium tracking-[-0.03em]">Workspace</span>
          </Link>
          <p className="mt-4 max-w-[34ch] text-sm leading-relaxed text-ink-3">
            The self-hosted workspace connected to your team&apos;s AI agents.
          </p>
          <a
            href={SITE.repo}
            target="_blank"
            rel="noreferrer"
            className="mt-5 inline-flex h-8 items-center gap-2 rounded-md px-3 text-sm text-ink shadow-[0_0_0_1px_var(--color-hair-strong)] transition-colors hover:bg-[var(--color-muted)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
          >
            <GitHubIcon className="size-4" /> Star on GitHub
          </a>
        </div>
        {FOOTER.map((col) => (
          <div key={col.title}>
            <p className="text-xs font-medium tracking-[0.04em] text-ink-4 uppercase">{col.title}</p>
            <ul className="mt-4 space-y-2.5">
              {col.links.map((l) => (
                <li key={l.label}>
                  <Link
                    href={l.href}
                    {...external(l.href)}
                    className="rounded-sm text-sm text-ink-2 transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
                  >
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </Container>
      <Container>
        <div className="flex flex-col gap-2 border-t border-hair py-6 text-xs text-ink-4 sm:flex-row sm:items-center sm:justify-between">
          <span>© {new Date().getFullYear()} Workspace contributors. Released under the MIT License.</span>
          <span>v{SITE.version}</span>
        </div>
      </Container>
    </footer>
  );
}
