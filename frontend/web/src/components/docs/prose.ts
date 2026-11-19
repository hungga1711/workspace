import { cx } from "@/lib/ui";

/** Page content styles (reading measure and rhythm), from design tokens only. */
export const docProse = cx(
  // Rhythm: headings get more room above than below so each one belongs to the text under it; no rules
  // under h2 (they cut the page into strips); the first block starts flush with the body's top.
  "text-[15px]/7 text-ink [&_.ProseMirror]:outline-none [&_.ProseMirror]:min-h-[50vh] [&>*:first-child]:mt-0 [&_.ProseMirror>*:first-child]:mt-0",
  "[&_h1]:mt-10 [&_h1]:mb-3 [&_h1]:font-display [&_h1]:text-[24px]/8 [&_h1]:font-semibold [&_h1]:tracking-[-0.02em]",
  "[&_h2]:mt-9 [&_h2]:mb-2 [&_h2]:font-display [&_h2]:text-[19px]/7 [&_h2]:font-semibold [&_h2]:tracking-[-0.015em]",
  "[&_h3]:mt-7 [&_h3]:mb-1.5 [&_h3]:text-base/6 [&_h3]:font-semibold [&_h3]:tracking-tight",
  "[&_p]:my-3 [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:my-1 [&_li_p]:my-0 [&_li::marker]:text-ink-2",
  "[&_a]:text-brand-text [&_a]:underline",
  "[&_blockquote]:border-ink/20 [&_blockquote]:text-ink-soft [&_blockquote]:my-4 [&_blockquote]:border-l-2 [&_blockquote]:pl-4 [&_blockquote]:not-italic [&_blockquote_p]:my-1.5",
  "[&_code]:bg-hover [&_code]:border-hairline [&_code]:rounded-md [&_code]:border [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.875em]",
  "[&_pre]:bg-hover [&_pre]:border-hairline [&_pre]:my-4 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:p-4 [&_pre]:text-sm/6 [&_pre_code]:border-0 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-sm",
  "[&_hr]:border-hairline [&_hr]:my-8",
  "[&_mark]:bg-signal-wash [&_mark]:rounded-sm [&_mark]:px-0.5",
  "[&_img]:my-4 [&_img]:max-w-full [&_img]:rounded-lg [&_img]:border [&_img]:border-hairline",
  // Tables rule across, not into a grid: a head in quiet ink over a hairline, rows on soft dividers.
  "[&_table]:my-4 [&_table]:w-full [&_table]:border-collapse [&_table]:text-sm [&_td]:border-divider-soft [&_td]:border-b [&_td]:px-3 [&_td]:py-2 [&_td]:align-top [&_td_p]:my-0 [&_th_p]:my-0 [&_th]:border-hairline [&_th]:border-b [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:text-xs [&_th]:font-medium [&_th]:text-ink-2 [&_tr:last-child_td]:border-b-0",
  "[&_li:has(>input[type=checkbox])]:list-none [&_li:has(>label>input[type=checkbox])]:list-none [&_ul:has(>li>input[type=checkbox])]:pl-1 [&_input[type=checkbox]]:size-4 [&_input[type=checkbox]]:accent-ink [&_input[type=checkbox]]:mr-2 [&_input[type=checkbox]]:align-[-3px]",
  "[&_ul[data-type=taskList]]:list-none [&_ul[data-type=taskList]]:pl-1 [&_ul[data-type=taskList]>li]:flex [&_ul[data-type=taskList]>li]:items-start [&_ul[data-type=taskList]>li]:gap-2 [&_ul[data-type=taskList]>li>label]:mt-[3px] [&_ul[data-type=taskList]_input]:accent-brand [&_ul[data-type=taskList]_input]:size-4 [&_ul[data-type=taskList]>li>div]:min-w-0 [&_ul[data-type=taskList]>li>div]:flex-1 [&_ul[data-type=taskList]>li>div>p]:my-0 [&_li[data-checked=true]>div]:text-ink-2 [&_li[data-checked=true]>div]:line-through",
  "[&_[data-callout]]:my-5 [&_[data-callout]]:rounded-lg [&_[data-callout]]:border [&_[data-callout]]:px-4 [&_[data-callout]]:py-3.5 [&_[data-callout]_p]:my-1",
  "[&_[data-callout=info]]:bg-accent-wash [&_[data-callout=info]]:border-accent/25 [&_[data-callout=warning]]:bg-warn-wash [&_[data-callout=warning]]:border-warn/25 [&_[data-callout=success]]:bg-ok-wash [&_[data-callout=success]]:border-ok/25 [&_[data-callout=note]]:bg-hover/60 [&_[data-callout=note]]:border-hairline",
  "[&_[data-type=mention]]:bg-accent-wash [&_[data-type=mention]]:text-accent-text [&_[data-type=mention]]:rounded [&_[data-type=mention]]:px-1 [&_[data-type=mention]]:font-medium",
  "[&_.is-editor-empty:first-child::before]:text-ink-2 [&_.is-editor-empty:first-child::before]:pointer-events-none [&_.is-editor-empty:first-child::before]:float-left [&_.is-editor-empty:first-child::before]:h-0 [&_.is-editor-empty:first-child::before]:content-[attr(data-placeholder)]",
  "[&_.selectedCell]:bg-brand-wash",
  // Live editing: other people's carets, with their name above (colour set per person by ./collab).
  "[&_.collaboration-cursor\\_\\_caret]:relative [&_.collaboration-cursor\\_\\_caret]:-mx-px [&_.collaboration-cursor\\_\\_caret]:border-x [&_.collaboration-cursor\\_\\_caret]:pointer-events-none [&_.collaboration-cursor\\_\\_caret]:break-normal",
  "[&_.collaboration-cursor\\_\\_label]:absolute [&_.collaboration-cursor\\_\\_label]:-top-[1.35em] [&_.collaboration-cursor\\_\\_label]:-left-px [&_.collaboration-cursor\\_\\_label]:select-none [&_.collaboration-cursor\\_\\_label]:whitespace-nowrap [&_.collaboration-cursor\\_\\_label]:rounded-sm [&_.collaboration-cursor\\_\\_label]:rounded-bl-none [&_.collaboration-cursor\\_\\_label]:px-1 [&_.collaboration-cursor\\_\\_label]:py-px [&_.collaboration-cursor\\_\\_label]:text-xs/[1.3] [&_.collaboration-cursor\\_\\_label]:font-semibold [&_.collaboration-cursor\\_\\_label]:text-on-brand",
);
