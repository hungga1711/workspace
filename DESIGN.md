---
# gstack: design-md-format=spec
name: workspace
description: Near-white canvas under white hairline-ring cards, Geist + Inter Tight, ink #171717 with neutral greys, one blue (#2563EB) accent, red only for late/blocked/destructive, round buttons, a 6/10/14/18px radius scale; logo: a soft blue-to-violet w that is also a cat's mouth, on a white tile.
colors:
  ground: "#FAFAFA"
  panel: "#FAFAFA"
  frame: "#FAFAFA"
  surface: "#FFFFFF"
  ink: "#171717"
  ink-soft: "#4D4D4D"
  ink-2: "#666666"
  hairline: "#EBEBEB"
  divider: "#EBEBEB"
  divider-soft: "#F2F2F2"
  edge: "#E0E0E0"
  hover: "#F5F5F5"
  selected: "#F2F2F2"
  brand: "#171717"
  on-brand: "#FFFFFF"
  accent: "#2563EB"
  accent-text: "#1D4ED8"
  accent-wash: "#EFF4FF"
  lane: "#F2F2F2"
  progress: "#2563EB"
  progress-track: "#F2F2F2"
  ok: "#157A3A"
  ok-wash: "#E3F4EA"
  warn: "#A14A07"
  warn-wash: "#FFF4E5"
  block: "#C81E1E"
  block-wash: "#FDECEC"
  violet-text: "#5B4BC4"
  violet-wash: "#EFEDFB"
  dark-ground: "#0A0A0A"
  dark-surface: "#171717"
  dark-ink: "#FAFAFA"
  dark-ink-2: "#A3A3A3"
  dark-hairline: "#2A2A2A"
  dark-accent: "#60A5FA"
typography:
  display:
    fontFamily: Inter Tight
    fontWeight: 600
    fontSize: 1.75rem
    lineHeight: 1.2
    letterSpacing: -0.035em
  heading:
    fontFamily: Inter Tight
    fontWeight: 600
    fontSize: 1.25rem
    lineHeight: 1.3
    letterSpacing: -0.02em
  section:
    fontFamily: Geist
    fontWeight: 600
    fontSize: 1rem
    lineHeight: 1.4
  title:
    fontFamily: Geist
    fontWeight: 600
    fontSize: 0.875rem
    lineHeight: 1.5
  body:
    fontFamily: Geist
    fontWeight: 400
    fontSize: 0.875rem
    lineHeight: 1.5
  meta:
    fontFamily: Geist
    fontWeight: 400
    fontSize: 0.75rem
    lineHeight: 1.45
  eyebrow:
    fontFamily: Geist
    fontWeight: 500
    fontSize: 0.75rem
    letterSpacing: 0.08em
    textTransform: uppercase
  number:
    fontFamily: Inter Tight
    fontWeight: 600
    fontFeature: tnum
  mono:
    fontFamily: Geist Mono
    fontWeight: 400
    fontSize: 0.75rem
rounded:
  sm: 6px
  md: 10px
  lg: 14px
  xl: 18px
  2xl: 22px
  3xl: 28px
  full: 9999px
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
  2xl: 48px
components:
  button:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    ring: "{colors.hairline}"
    rounded: "{rounded.full}"
    height: 32px
  button-primary:
    backgroundColor: "{colors.brand}"
    textColor: "{colors.on-brand}"
    rounded: "{rounded.full}"
    height: 32px
  button-small:
    height: 28px
    fontSize: 13px
  input:
    backgroundColor: "{colors.surface}"
    borderColor: "{colors.edge}"
    rounded: "{rounded.md}"
    height: 32px
  card:
    backgroundColor: "{colors.surface}"
    ring: "{colors.hairline}"
    rounded: "{rounded.xl}"
  popover:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
  dialog:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.2xl}"
  chip:
    height: 20px
    rounded: "{rounded.full}"
  progress-bar:
    backgroundColor: "{colors.progress-track}"
    fillColor: "{colors.progress}"
    rounded: "{rounded.full}"
    height: 6px
---

# workspace design system

This file is the one source of truth for how the web app looks. The tokens live in
`frontend/web/src/styles/globals.css` and must match the tables below; shared class sets live in
`frontend/web/src/lib/ui.ts`. When the two disagree, fix one of them in the same change. Ask before departing from
anything here.

## Product and mode

Self-hosted, single-workspace work management (tasks, docs, chat, requests, attendance) with an optional AI layer.
English first; Vietnamese, Chinese and Spanish are full locales. Every feature works without AI. It is a tool people
use all day: dense, calm, fast. Colour carries meaning; decoration does not.

## Colour

Tokens are semantic CSS variables on `:root` (light) and `[data-theme="dark"]` (dark), exposed through
`@theme inline` as Tailwind utilities. Never write a hex value in a component.

| Utility | Light | Dark | Use |
| --- | --- | --- | --- |
| `bg-ground` / `bg-panel` / `bg-frame` | `#FAFAFA` | `#0A0A0A` / `#171717` | sign-in ground, the content canvas, the sidebar |
| `bg-surface` | `#FFFFFF` | `#171717` | cards, popovers, dialogs, bars |
| `text-ink` / `text-ink-soft` / `text-ink-2` | `#171717` / `#4D4D4D` / `#666666` | `#FAFAFA` / `#D4D4D4` / `#A3A3A3` | text, secondary labels, meta |
| `border-hairline` / `border-divider` / `border-edge` | `#EBEBEB` / `#EBEBEB` / `#E0E0E0` | `#2A2A2A` / `#262626` / `#333333` | card rings, rules, form fields |
| `bg-hover` / `bg-selected` | `#F5F5F5` / `#F2F2F2` | `#212121` / `#2A2A2A` | hover fill, selected fill |
| `bg-brand` / `text-on-brand` | `#171717` / `#FFFFFF` | `#FAFAFA` / `#171717` | primary buttons, toggles |
| `bg-accent` / `text-accent-text` / `bg-accent-wash` (= `signal`) | `#2563EB` / `#1D4ED8` / `#EFF4FF` | `#60A5FA` / `#93C5FD` / `#172036` | links in context, progress, "needs you", counts |
| `text-ok` / `bg-ok-wash`, `bg-ok-fill` | `#157A3A` / `#E3F4EA`, `#22A06B` | `#86EFAC` / `#10261D` | done, on track |
| `text-warn` / `bg-warn-wash`, `bg-warn-fill` | `#A14A07` / `#FFF4E5`, `#E5732D` | `#FBBF24` / `#2B2210` | at risk, waiting |
| `text-block` / `bg-block-wash`, `bg-danger-fill` | `#C81E1E` / `#FDECEC`, `#C81E1E` | `#F87171` / `#2C1414` | late, blocked, destructive only |
| `sky` / `violet` / `rose` / `tangerine` (`-text`, `-wash`) | | | icon tiles and kind marks (AI is violet) |
| `art-0`…`art-7` (`-text`, `-wash`) | | | identity: departments, avatars, project tiles; never status |
| `bg-lane` | `#F2F2F2` | `#1F1F1F` | kanban lanes |
| `bg-progress` / `bg-progress-track` | accent / `#F2F2F2` | | progress bars |
| `bg-term`, `text-term-ink` | `#161616`, `#EDEDED` | | terminal blocks (dark in both themes) |

Rules:

- Red is only lateness, blocking or destruction. Green is done. Amber is "at risk" or "waiting". Blue is the accent.
- Text on a wash uses that wash's `-text` or semantic token; every text pair passes WCAG AA (4.5:1).
- Status is shown as text, or a tinted pill (`TaskStatusPill`), never as a dot or ring icon next to the word.
- The focus ring is a 2px `ink` outline 2px off the element (inset `ink-2` inside rows).

## Typography

Faces: Geist for the UI (system CJK faces behind it for Chinese), Inter Tight for display titles and big figures, Geist
Mono for codes, keys and ids. All self-hosted with Latin and Vietnamese letters only; every face must draw ắ, ấ, ế, ở…
itself, since a tone mark borrowed from another font is lost or misplaced.

| Role | Size / line | Weight | Utility |
| --- | --- | --- | --- |
| Display (entity title, page hero) | 28/34 (24 on phones) | 600, −0.035em | `font-display text-[28px]` |
| Heading (dialog hero, section hero) | 20/26 | 600, −0.02em | `text-xl` |
| Section title | 16/22 | 600 | `text-base font-semibold` |
| Card title, button, nav | 14/21 | 500–600 | `text-sm` |
| Body | 14/21 | 400 | `text-sm` |
| Small body (dense tables, chips in toolbars) | 13/19 | 400–500 | `text-[13px]` |
| Meta, eyebrow, hint | 12/17 | 400 (eyebrow 500, uppercase, 0.08em) | `text-xs` |
| Figures | any | 600, tabular | `tabular-nums` |

- Nothing below 12px, except avatar initials, kbd hints, count badges and chips (11px, `chip`/`countPill` in
  `lib/ui.ts`) and the letter inside a tile of 20px or less (9–10px).
- Numbers, dates and ids use tabular figures. Codes (`T-041`) are mono. Money uses `formatMoney` (`lib/money.ts`);
  dates and numbers use the locale formatters (`useFormat`, `lib/format.ts`), never hand-built strings.

## Shape and depth

| Token | Radius | Use |
| --- | --- | --- |
| `rounded-sm` | 6px | lozenges, small tiles, kbd, code chips |
| `rounded-md` | 10px | inputs, menu and nav rows, small cards |
| `rounded-lg` | 14px | popovers, menus, pickers |
| `rounded-xl` | 18px | cards, tables, side cards |
| `rounded-2xl` | 22px | dialogs, hero cards |
| `rounded-3xl` | 28px | phone sheets |
| `rounded-full` | pill | buttons, icon buttons, avatars, badges, toggles |

- No other radii, except proportional corners on tiles of 20px or less (2–5px) and inheriting children.
- Cards are a 1px ring (`shadow-card`), no drop shadow at rest; on hover a card may lift (`shadow-lift`). Overlays
  carry depth: `shadow-popover` for menus, pickers, dialogs and the palette; `shadow-drawer` for drawers;
  `shadow-hero` for the one hero card on a page.
- Buttons: 32px tall (28px `btnSm`, 36px on phones), round, 14px medium. Default `btn` is white with a hairline ring;
  `btnPrimary` is `brand`; `btnGhost` is transparent until hovered; `btnDanger` is solid red for destructive confirms.
  Icon buttons are 32px circles (28px in dense rows).

## Layout

- **Frame:** a 232px sidebar flush to the left (a 56px icon rail on tablets), a 48px top bar (56px on phones) that
  names the screen, the content canvas under it. Phones get a bottom bar (Home · Messages · + · Work · Me).
- **One title per screen:** the top bar names the destination ("Work") or "Destination / Entity". Every page has one
  `h1` (visually hidden where the top bar already shows it; on a task, the task's title). Tabs never repeat the
  destination's name.
- **Page column:** max 1600px, 28px sides (16px on phones), content 16–20px under the top bar. Detail pages: max
  1120px; reading text: 760px.
- **Detail pattern:** entities opened from a list open in the peek (a large dialog on desktop, a full sheet on phones)
  with a link to the full page; the full page uses the same parts.
- **Empty and failed states:** an empty section is one slim line (or a quiet strip cell), never a tall blank box. A
  failed read shows `LoadFailed` with Retry in that section only; a page never crashes on data. Missing permission says
  so ("You don't have access"), it is not a 404.
- **Responsive:** check 390, 768 and 1440, including open menus and dialogs. Nothing scrolls sideways at 360px; flex
  and grid children that hold text get `min-w-0`; long text truncates with a tooltip.
- **Connection:** a thin bar under the top edge says when the app is offline or reconnecting, or when the session
  ended (with Sign in); send buttons are disabled meanwhile and unsent text is kept.

## Components

Shared building blocks; use them instead of re-spelling utilities.

- `lib/ui.ts`: `btn`, `btnPrimary`, `btnGhost`, `btnDanger`, `btnSm`, `input`, `textarea`, `card`, `popover`,
  `menuItem`, `chip`, `countPill`.
- `components/ui`: `Modal` and `Drawer` (focus trap, Esc, focus returns to the opener), `Menu` and `Picker` (keyboard,
  focus returns to the trigger), `Tabs` (navigation) and `Segmented` (filters), `DateField`, `Checkbox`, `Toast` (with
  Undo or a link), `ReasonDialog` (asks why before a refusal), `LoadFailed`, `ReadFailed`, `EmptyState`, `KpiStrip`,
  `PageHeader`, `Peek`.
- Never use the browser's `alert`, `confirm` or `prompt`; use `Confirm`/`Modal`.

## Motion

Minimal and functional. Ease-out on enter (`cubic-bezier(.2,.7,.2,1)`), 80ms for hover and press, 160ms for state
changes, 240ms for panels. Motion (`motion/react`, `m.*` under `LazyMotion`) in the signed-in app only; animate
`transform` and `opacity`. Everything respects `prefers-reduced-motion`.

## Writing

English is the source language (`messages/en.ts`); other locales may lag and fall back to English. Sentence case,
plain words, active voice. A button says what it does ("Approve", "Send"); a toast says what happened ("Approved").
Errors say what went wrong and what to do. No exclamation marks, no emoji in UI copy.

## Decisions still in force

| Date | Decision |
| --- | --- |
| 2026-11-11 | No eyebrow over a title: the short rule with a small-caps line (the date, the section's group) is gone from every page head. Small-caps labels remain only inside cards ("Do now"). A tabs row starts 20px under the top bar on every page. |
| 2026-11-11 | Home: the greeting with the week in one sentence, then the ask bar (only with a company AI) as the first thing on the page, then "Do now" beside today's ring, then the tiles. Plain white cards: no glow, dot grid or gradient on Home; red only on the late label. On AI › Ask the composer sits under the greeting while the thread is empty. A run's pipeline is a track of round nodes with the stage's facts in a side column. |
| 2026-11-08 | One design file: this document replaces the earlier stacked "refresh" sections. 12px minimum text, the 6/10/14/18 radius scale, 32px buttons. |
| 2026-11-08 | Status as text or a tinted pill, no circle icons; the task status is the first row of the task's Details card. |
| 2026-11-08 | Refusing a leave or request asks for a reason; decisions in the request queue can be undone for 10 seconds. |
| 2026-11-08 | Comments send with Enter like chat (Shift+Enter for a new line, ⌘Enter also sends); unsent comments and AI questions are kept per task. |
| 2026-11-06 | Ask AI on a task is a button by the title that opens a side panel, not a tab beside comments. |
| 2026-11-05 | Home: under the hero, a bento of tiles; empty tiles collapse into a quiet strip. |
| 2026-11-04 | Logo: the soft "w" cat mouth with a triangle nose, blue to violet on a white tile (`lib/brand-mark.ts`). |
| 2026-11-01 | The landing page's palette app-wide: ink `#171717`, neutral greys, hairline-ring cards, blue `#2563EB`. |
| 2026-10-16 | One title per screen; `Tabs` for navigation and `Segmented` for filters; one `Avatar`; unread is a count. |
| 2026-10-13 | Performance: fonts self-hosted as subsets; heavy editors, dialogs and tabs load on demand. |
| 2026-10-08 | Tailwind CSS v4 with `@theme` tokens. |
