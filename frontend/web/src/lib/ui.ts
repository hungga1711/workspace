/**
 * Shared Tailwind class sets for the design system (see /DESIGN.md).
 * Components compose these instead of re-spelling the same utilities.
 */
export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");

/* Buttons: 3px corners, 32px tall (28px small, 36px large), 14px medium. The default is a soft
   grey fill with navy text, the primary the brand blue, subtle ones transparent. Focus ring from the base layer. */
const btnBase =
  "inline-flex items-center justify-center gap-1.5 min-h-8 px-3.5 rounded-full border text-sm font-medium no-underline whitespace-nowrap select-none transition-[background-color,box-shadow,color,transform] duration-150 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100 [&_svg]:size-4 [&_svg]:shrink-0 max-md:min-h-9";
/** Default (secondary): white with the field edge and a hairline shade, ink text; it reads as a button on a
 * white card as well as on the grey canvas, where a grey fill looked like a disabled block ("Từ chối", "Chấm công vào"). */
export const btn = `${btnBase} border-transparent bg-surface text-ink shadow-[0_0_0_1px_var(--hairline)] hover:bg-hover hover:shadow-[0_0_0_1px_var(--edge)] active:bg-selected`;
/** Primary: the brand blue with a white label ("Tạo mới", "Duyệt"). */
export const btnPrimary = `${btnBase} border-transparent bg-brand text-on-brand hover:bg-ink-soft active:bg-ink`;
/** Destructive confirm (suspend, cancel a series, deactivate): solid red with a white label. */
export const btnDanger = `${btnBase} border-transparent bg-danger-fill text-white hover:bg-danger-fill/90`;
/** Subtle (transparent until hovered). */
export const btnGhost = `${btnBase} border-transparent bg-transparent text-ink-soft hover:bg-hover hover:text-ink`;
export const btnSm = "min-h-7 px-2.5 text-[13px] gap-1 [&_svg]:size-3.5 max-md:min-h-8";
/** Large (36px): sign-in and the few page-level calls to action. */
export const btnLg = "min-h-9 px-3.5";
export const iconBtn =
  "relative grid size-8 place-items-center rounded-full text-ink-2 transition-[background-color,color,transform] duration-150 hover:bg-ink/[0.06] hover:text-ink active:scale-95 [&_svg]:size-4";

/* Form fields: 32px (40px on phones), 3px radius, a visible field edge; 16px text below md so iOS Safari does not zoom
   the page on focus; focus = a 2px blue edge (1px border + 1px inset ring). `control` sizes to its content (filters);
   `input` takes the full width. */
export const control =
  "rounded-md border border-transparent bg-surface shadow-[0_0_0_1px_var(--hairline)] px-2.5 text-sm max-md:text-base text-ink transition-[box-shadow] duration-100 placeholder:text-ink-2 hover:shadow-[0_0_0_1px_var(--edge)] focus:bg-surface focus:shadow-[0_0_0_1px_var(--accent),0_0_0_4px_var(--accent-wash)] focus:outline-none focus-visible:outline-none disabled:opacity-50";
export const input = `${control} min-h-8 w-full aria-[invalid=true]:border-block max-md:min-h-10`;
export const textarea = `${input} py-2 min-h-30`;
/** The search field (top bar, list filters): 32px, white with the field edge, 3px corners; blue edge when focused. */
export const searchPill =
  "flex min-h-8 items-center gap-2 rounded-md bg-surface shadow-[0_0_0_1px_var(--hairline)] pl-2.5 pr-2 text-sm max-md:min-h-10 max-md:text-base text-ink-2 transition-[box-shadow] hover:shadow-[0_0_0_1px_var(--edge)] focus-within:shadow-[0_0_0_1px_var(--accent),0_0_0_4px_var(--accent-wash)]";

/* Lozenges: 20px, 3px corners, 12px semibold on the state's wash; neutral ones grey. */
const chipBase = "inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-full px-2 text-[11px] font-medium";
export const chip = `${chipBase} bg-selected text-ink-soft`;
export const chipOk = `${chipBase} bg-ok-wash text-ok`;
export const chipWarn = `${chipBase} bg-warn-wash text-warn`;
export const chipBlock = `${chipBase} bg-block-wash text-block`;
export const chipAccent = `${chipBase} bg-accent-wash text-accent-text`;
/** A count beside a title ("Chờ tôi duyệt 4"): a round grey badge, tabular. */
export const countPill = "inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-selected px-1.5 text-[11px] font-medium tabular-nums text-ink-2";
/** A project tag in a row: 3px radius, muted fill. */
export const tag = "inline-flex items-center gap-1.5 whitespace-nowrap rounded-sm bg-selected px-1.5 py-0.5 text-xs text-ink-soft";
/* Dropdowns (menus, pickers, suggestion lists): hairline border, 4px radius, 4px padding, rows 32px tall. */
export const popover = "bg-surface shadow-popover rounded-lg p-1";
export const menuItem =
  "flex w-full min-h-8 items-center gap-2 rounded-md px-2 py-1 text-left text-sm text-ink transition-colors hover:bg-ink/[0.06] focus-visible:bg-ink/[0.06] focus-visible:outline-none [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-ink-2";
export const menuLabel = "m-0 px-2 pb-1 pt-1.5 text-xs font-semibold text-ink-2";
export const menuSep = "-mx-1 my-1 border-hairline";

/* Type scale (DESIGN.md › Typography): the system UI face; page and entity titles 24px semibold, section
   titles 14–16px semibold, body 14px, meta 12px (13px on phones). Page titles normally come from PageHeader. */
/** Home's heading and other page-level headings. */
export const displayTitle = "m-0 font-display text-2xl/8 font-medium tracking-[-0.03em] text-ink max-md:text-xl";
/** Meta: 12px on desktop, 13px on phones (12px is too small to read at arm's length). */
export const meta = "text-xs/[1.45] max-md:text-[13px]/[1.45] text-ink-2";
export const muted = "text-ink-2";
export const mono = "font-mono tabular-nums";
/** Figures (counts, times, percentages): aligned digits in the UI font. */
export const nums = "tabular-nums";

export const list = "m-0 list-none divide-y divide-divider-soft overflow-hidden rounded-xl bg-surface p-0 shadow-card";
export const row = "flex min-h-11 items-center gap-3 px-3 py-2";
export const grow = "min-w-0 flex-1";
export const rowTitle = "block truncate font-medium text-ink no-underline hover:underline";
export const rowSub = "block text-xs max-md:text-[13px] text-ink-2";
/** Phone-sized data text: 12px on desktop, 13px below md. Use for small figures and labels in tables and cards. */
export const smallText = "text-xs max-md:text-[13px]";

/* Hit areas (WCAG 2.5.8, DESIGN.md "44px tap target on touch"). `hit` centres an invisible ::after at least 24px
   (44px below md) over a small control without moving anything; it needs a box that does not clip (no overflow
   hidden). `hitPad` is for one-line truncated links (truncate clips ::after): padding grows the box to 44px on
   phones and an equal negative margin keeps the layout. */
export const hit =
  "relative after:absolute after:left-1/2 after:top-1/2 after:size-full after:min-h-6 after:min-w-6 after:-translate-x-1/2 after:-translate-y-1/2 after:content-[''] max-md:after:min-h-11 max-md:after:min-w-11";
export const hitPad = "max-md:-my-3 max-md:py-3";
/** A small text link in a card header ("Xem tất cả", "Mở lịch"): 12px (13px on phones), blue, with a 44px touch target. */
export const cardLink = `text-xs max-md:text-[13px] font-medium text-accent-text no-underline hover:underline ${hit}`;

export const empty = "rounded-lg border border-dashed border-hairline p-6";
/** Neutral status/info strip. AI output uses this too: AI has no visual identity of its own. */
export const note = "mt-4 flex min-h-11 items-center gap-3 rounded-lg bg-surface px-3.5 py-2.5 shadow-card";
/** A flat muted block that pulses while data loads. */
export const skeleton = "inline-block h-3 w-2/5 rounded-md shimmer";

/* `border-separate` + zero spacing (not `border-collapse`): a collapsed table ignores its radius; row rules are bottom
   borders on cells, so nothing doubles. Enterprise header: 12px semibold soft ink over a 2px rule. */
export const table =
  "relative w-full border-separate border-spacing-0 overflow-hidden rounded-xl bg-surface shadow-card text-sm [&_td]:border-b [&_td]:border-divider-soft [&_td]:px-3 [&_td]:py-2 [&_th]:h-9 [&_th]:border-b [&_th]:border-divider [&_th]:bg-ground [&_th]:px-3 [&_th]:text-left [&_th]:text-xs [&_th]:font-medium [&_th]:text-ink-2 [&_tr:last-child_td]:border-b-0 [&_tbody_tr:hover]:bg-hover";

/**
 * For a `table` inside an overflow-x-auto box: below 1024px cells stop wrapping (a name split one word per line
 * reads worse than a sideways scroll) and the first column stays put while the rest scroll.
 */
export const tableScroll =
  "max-lg:[&_td]:whitespace-nowrap max-lg:[&_th]:whitespace-nowrap max-lg:[&_tr>*:first-child]:sticky max-lg:[&_tr>*:first-child]:left-0 max-lg:[&_tr>*:first-child]:z-[1] max-lg:[&_tr>*:first-child]:bg-surface";

/** Card: white, 4px radius, hairline, a raised shade under it (it sits on the grey canvas). Header rules inside use
 * `border-divider`. */
export const card = "rounded-xl bg-surface shadow-card";
/** A card's header row: title (14px semibold) left, a blue link right, a divider under it. */
export const cardHead = "flex min-h-11 items-center gap-2 border-b border-divider px-4 py-2";
export const cardTitle = "m-0 text-sm/6 font-medium text-ink";

/*
 * Progress (DESIGN.md › Colors): every progress bar (task, project, goal, department) is a `progressTrack`
 * with a `progressFill` inside, width set inline: accent blue on a neutral track; late bars may swap the fill for
 * `bg-block`.
 */
export const progressTrack = "relative block h-1.5 overflow-hidden rounded-full bg-progress-track";
export const progressFill = "block h-full origin-left rounded-full bg-progress animate-grow-x transition-[width] duration-300";
/**
 * Navigation rows (sidebar, admin nav): 32px rows with 3px corners (40px on phones). "You are here" is the light blue
 * `nav-active` row with its icon and label in accent-text, semibold; other rows are ink-soft on a grey hover.
 * Icons are 16px (`navIcon`).
 */
export const navItem =
  "relative flex min-h-8 items-center gap-2.5 rounded-md px-2 text-sm no-underline transition-colors duration-100 [&>svg]:size-4 [&>svg]:shrink-0 max-md:min-h-10";
/** The selected row: a soft ink fill, the label and icon in ink. No ring: on the grey rail a ringed white pill read as a button. */
export const navActive = "bg-ink/[0.07] text-ink font-medium";
export const navIdle = "text-ink-soft hover:bg-ink/[0.04] hover:text-ink";
/** A nav row's icon: the accent when selected, a muted ink otherwise. */
export const navIcon = (active: boolean) => (active ? "size-4 shrink-0 text-ink" : "size-4 shrink-0 text-ink-2");

/* Sign-in, setup and account recovery. */
/** The one card those screens sit in. */
export const authCard = "bg-surface w-full max-w-[400px] rounded-2xl px-6 py-7 shadow-card sm:px-8";
/** Their full-width primary button. */
export const authCta = `${btnBase} min-h-10 w-full border-transparent bg-brand text-on-brand hover:bg-ink-soft`;
