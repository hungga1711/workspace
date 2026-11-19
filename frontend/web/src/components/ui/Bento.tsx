import Link from "next/link";
import { cx, iconBtn } from "@/lib/ui";
import { ArrowRightIcon, CheckIcon } from "@/components/app/icons";

/*
 * Bento building blocks, used on Home and every other screen: white
 * cards on the canvas drawn by a hairline ring, never a border; on hover a card lifts to a darker ring and a long soft
 * shadow and lights up around the pointer (`spot`). Each tile is led by a crisp tinted icon tile so the page scans by
 * colour and shape before a word is read; one big figure (tight tracking, tabular) and one action per tile. A tile
 * with nothing to show is never a tall empty box: it becomes a slim cell in the quiet strip (`Quiet`).
 * Server-safe: the page's own tiles (team, my week) and the client ones share them.
 */

export type Tone = "violet" | "sky" | "tangerine" | "rose" | "green" | "red";

/** Icon tile: the tone's wash with its deep tone for the glyph and a faint ring of the same tone (both themes). */
export const TONE: Record<Tone, string> = {
  violet: "bg-violet-wash text-violet-text",
  sky: "bg-sky-wash text-sky-text",
  tangerine: "bg-tangerine-wash text-tangerine-text",
  rose: "bg-rose-wash text-rose-text",
  green: "bg-ok-wash text-ok",
  red: "bg-block-wash text-block",
};
/** The tone as a bright fill (the hero's status dot). */
export const DOT: Record<Tone, string> = {
  violet: "bg-violet",
  sky: "bg-sky",
  tangerine: "bg-tangerine",
  rose: "bg-rose",
  green: "bg-ok-fill",
  red: "bg-block",
};
/** The hero's corner light, in its tone. */
export const GLOW: Record<Tone, string> = {
  violet: "[--glow:var(--violet)]",
  sky: "[--glow:var(--sky)]",
  tangerine: "[--glow:var(--tangerine)]",
  rose: "[--glow:var(--rose)]",
  green: "[--glow:var(--ok-fill)]",
  red: "[--glow:var(--block)]",
};

/** A Home card at rest and on hover (lift, darker ring, long shadow, pointer light). */
export const card = "spot bg-surface shadow-card hover:shadow-lift transition-[box-shadow,transform] duration-300 ease-out-soft motion-safe:hover:-translate-y-px";

/** Row inside a tile: the row itself lights on hover, flush with the tile's text. */
export const tileRow = "hover:bg-hover -mx-2 flex min-h-11 min-w-0 items-center gap-3 rounded-lg px-2 py-1.5 transition-colors";

/** A small caps label with a short rule (the landing page's eyebrow). */
export function Eyebrow({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cx("text-ink-2 inline-flex items-center gap-2 text-xs font-medium uppercase tracking-[0.08em]", className)}>{children}</span>;
}

export function IconTile({ tone, children, className }: { tone: Tone; children: React.ReactNode; className?: string }) {
  return (
    <span aria-hidden="true" className={cx("ring-current/10 grid size-8 shrink-0 place-items-center rounded-[9px] ring-1 ring-inset [&_svg]:size-4", TONE[tone], className)}>
      {children}
    </span>
  );
}

/** The arrow to where the rest lives; nudges right on the tile's hover. */
function TileLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      aria-label={label}
      title={label}
      className={cx(iconBtn, "text-ink-2 hover:text-ink -mr-1.5 shrink-0 [&_svg]:transition-transform group-hover/tile:[&_svg]:translate-x-0.5")}
    >
      <ArrowRightIcon />
    </Link>
  );
}

/** One bento tile: coloured icon, a short title, an arrow to where the rest lives, then its content. */
export function Tile({
  id,
  title,
  icon,
  tone,
  link,
  children,
  className,
}: {
  id: string;
  title: string;
  icon: React.ReactNode;
  tone: Tone;
  link?: { href: string; label: string };
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section aria-labelledby={id} className={cx(card, "group/tile @container/tile flex min-w-0 flex-col rounded-xl p-5 max-sm:p-4", className)}>
      <header className="flex min-h-8 items-center gap-3">
        <IconTile tone={tone}>{icon}</IconTile>
        <h2 id={id} className="m-0 min-w-0 flex-1 truncate text-sm font-semibold tracking-[-0.01em]">
          {title}
        </h2>
        {link ? <TileLink {...link} /> : null}
      </header>
      {children}
    </section>
  );
}

/**
 * A tile with nothing to show (or whose read failed), as one cell of the quiet strip: its icon, its title and one
 * calm line, with a green tick when all is clear. The whole cell leads where the rest lives.
 */
export function Quiet({
  id,
  title,
  icon,
  tone,
  link,
  children,
  clear,
}: {
  id: string;
  title: string;
  icon: React.ReactNode;
  tone: Tone;
  link: { href: string; label: string };
  children: React.ReactNode;
  /** All clear (a tick); false when the cell carries a load failure instead. */
  clear: boolean;
}) {
  return (
    <section
      aria-labelledby={id}
      className="spot bg-surface group/quiet hover:bg-hover/40 flex min-h-[4.75rem] min-w-0 items-center gap-3.5 px-5 py-4 transition-colors max-sm:px-4"
    >
      <IconTile tone={tone}>{icon}</IconTile>
      <span className="min-w-0 flex-1 leading-[1.35]">
        <h2 id={id} className="m-0 truncate text-sm font-semibold tracking-[-0.01em]">
          {title}
        </h2>
        <span className="text-ink-2 block truncate text-[13px]">{children}</span>
      </span>
      {clear ? (
        <>
          <span aria-hidden="true" className="bg-ok-wash text-ok ring-current/15 grid size-6 shrink-0 place-items-center rounded-full ring-1 ring-inset">
            <CheckIcon className="size-3.5" />
          </span>
          <Link href={link.href} aria-label={link.label} title={link.label} className="absolute inset-0 z-[1] rounded-[inherit]" />
        </>
      ) : null}
    </section>
  );
}

/** A tile's headline number with a short label beside it. */
export function Figure({ n, label, tone, children }: { n: React.ReactNode; label?: string; tone?: "alert" | "muted"; children?: React.ReactNode }) {
  return (
    <p className="m-0 mt-4 flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
      <span
        className={cx(
          "font-display text-[38px]/none font-semibold tabular-nums tracking-[-0.045em]",
          tone === "alert" ? "text-block" : tone === "muted" ? "text-ink-2" : "text-ink",
        )}
      >
        {n}
      </span>
      {label ? <span className="text-ink-2 text-[13px]">{label}</span> : null}
      {children}
    </p>
  );
}

/** A small rounded figure chip ("✓ 12 xong"); a link when it leads somewhere. */
export function Chip({ href, n, label, tone, title }: { href?: string; n: React.ReactNode; label: string; tone?: "ok" | "alert"; title?: string }) {
  const body = (
    <>
      <b className={cx("font-semibold tabular-nums", n === 0 ? "text-ink-2" : tone === "alert" ? "text-block" : tone === "ok" ? "text-ok" : "text-ink")}>{n}</b>
      <span className="text-ink-2">{label}</span>
    </>
  );
  const cls = "bg-ground ring-hairline inline-flex min-h-7 items-center gap-1 rounded-full px-2.5 text-xs no-underline ring-1 ring-inset";
  return href ? (
    <Link href={href} title={title} className={cx(cls, "hover:bg-hover hover:ring-edge transition-[background-color,box-shadow]")}>
      {body}
    </Link>
  ) : (
    <span title={title} className={cls}>
      {body}
    </span>
  );
}

/**
 * A progress ring (pathLength 100, so the dash is the percentage) that fills once on arrival; reduced motion shows it
 * filled. Full turns green.
 */
export function Ring({ pct, className, children }: { pct: number; className?: string; children?: React.ReactNode }) {
  const p = Math.max(0, Math.min(100, pct));
  return (
    <span className={cx("relative grid shrink-0 place-items-center", className)}>
      <svg viewBox="0 0 120 120" aria-hidden="true" className="absolute inset-0 size-full -rotate-90">
        <circle cx="60" cy="60" r="52" fill="none" strokeWidth="11" className="stroke-progress-track" />
        {p > 0 ? (
          <circle
            cx="60"
            cy="60"
            r="52"
            fill="none"
            strokeWidth="11"
            strokeLinecap="round"
            pathLength={100}
            strokeDasharray="100"
            strokeDashoffset={100 - p}
            className={cx("animate-ring", p >= 100 ? "stroke-ok-fill" : "stroke-progress")}
          />
        ) : null}
      </svg>
      <span className="relative flex flex-col items-center leading-none">{children}</span>
    </span>
  );
}
