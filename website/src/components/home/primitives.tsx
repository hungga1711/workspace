import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

export function Container({ className = "", children }: { className?: string; children: ReactNode }) {
  return <div className={`mx-auto w-full max-w-[1200px] px-5 sm:px-8 ${className}`}>{children}</div>;
}

export function Title({ as: Tag = "h2", className = "", children }: { as?: "h1" | "h2"; className?: string; children: ReactNode }) {
  return (
    <Tag className={`text-[2rem] leading-[1.08] font-medium tracking-[-0.045em] text-balance text-ink sm:text-[2.5rem] ${className}`}>
      {children}
    </Tag>
  );
}

/** Section opener: title on the left, one supporting sentence on the right (stacked on small screens). */
export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="mb-4 inline-flex items-center gap-2 text-xs font-medium tracking-[0.02em] text-ink-3 uppercase">
      <span className="h-px w-6 bg-signal" />
      {children}
    </p>
  );
}

export function SectionHead({
  eyebrow,
  title,
  lead,
  action,
  center,
}: {
  eyebrow?: string;
  title: ReactNode;
  lead?: ReactNode;
  action?: ReactNode;
  /** Title, lead and action stacked and centred, for sections that open on a wide figure. */
  center?: boolean;
}) {
  if (center)
    return (
      <div className="mx-auto max-w-[44rem] text-center">
        {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
        <Title className="mx-auto max-w-[22ch]">{title}</Title>
        {lead ? <p className="mx-auto mt-4 max-w-[52ch] text-base leading-relaxed text-ink-3">{lead}</p> : null}
        {action ? <div className="mt-4">{action}</div> : null}
      </div>
    );
  return (
    <div className="grid gap-4 lg:grid-cols-[1.1fr_1fr] lg:items-end lg:gap-16">
      <div>
        {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
        <Title className="max-w-[20ch]">{title}</Title>
      </div>
      <div className="lg:pb-1">
        {lead ? <p className="max-w-[46ch] text-base leading-relaxed text-ink-3">{lead}</p> : null}
        {action ? <div className="mt-4">{action}</div> : null}
      </div>
    </div>
  );
}

type ButtonProps = {
  href: string;
  variant?: "primary" | "secondary";
  children: ReactNode;
} & Omit<ComponentProps<"a">, "href">;

export function Button({ href, variant = "primary", className = "", children, ...rest }: ButtonProps) {
  const look = {
    primary: "bg-ink text-ground hover:bg-white hover:shadow-[0_0_0_1px_rgba(255,255,255,0.2),0_8px_24px_-8px_rgba(255,255,255,0.35)]",
    secondary: "bg-panel text-ink shadow-[0_0_0_1px_var(--color-hair)] hover:bg-[var(--color-muted)] hover:shadow-[0_0_0_1px_var(--color-hair-strong)]",
  }[variant];
  const cls = `group inline-flex h-10 items-center justify-center gap-2 whitespace-nowrap rounded-lg px-4 text-sm font-medium transition-[background-color,box-shadow,transform] duration-200 hover:-translate-y-px active:translate-y-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal ${look} ${className}`;
  if (href.startsWith("/") || href.startsWith("#")) {
    return (
      <Link href={href} className={cls}>
        {children}
      </Link>
    );
  }
  return (
    <a href={href} className={cls} target="_blank" rel="noreferrer" {...rest}>
      {children}
    </a>
  );
}

export function ArrowLink({ href, children }: { href: string; children: ReactNode }) {
  const cls = "group inline-flex items-center gap-1 text-sm font-medium text-ink hover:text-ink-3";
  const arrow = <span className="transition-transform group-hover:translate-x-0.5">→</span>;
  return href.startsWith("/") || href.startsWith("#") ? (
    <Link href={href} className={cls}>
      {children} {arrow}
    </Link>
  ) : (
    <a href={href} className={cls} target="_blank" rel="noreferrer">
      {children} {arrow}
    </a>
  );
}

export function GitHubIcon({ className = "size-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
