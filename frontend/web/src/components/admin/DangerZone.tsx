import { cx } from "@/lib/ui";

/**
 * The bottom-of-page home for actions that cannot be undone (delete all AI data, transfer ownership…): set apart by a
 * red hairline so they are never next to everyday settings. Each row says what happens; the button opens the app's
 * confirm dialog.
 */
export function DangerZone({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section aria-label={title} className={cx("border-block/40 grid gap-0 overflow-hidden rounded-xl border", className)}>
      <h2 className="text-block bg-block-wash/40 border-block/30 m-0 border-b px-4 py-2.5 text-sm/6 font-semibold">{title}</h2>
      <div className="bg-surface divide-hairline grid divide-y">{children}</div>
    </section>
  );
}

export function DangerRow({ title, hint, action }: { title: string; hint: React.ReactNode; action: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-4">
      <div className="grid min-w-0 flex-[1_1_20rem] gap-0.5">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-ink-2 text-xs/[1.5]">{hint}</span>
      </div>
      <div className="shrink-0">{action}</div>
    </div>
  );
}
