import { cx } from "@/lib/ui";

/**
 * The header of Tin nhắn's pages (overview, inbox lists, Thêm kênh) and search, in Home's look: a small
 * tight display title, actions on the right; a phone back link may lead it.
 * Server-safe: no hooks.
 */
export function PageHead({
  title,
  meta,
  actions,
  lead,
  as: Tag = "h1",
  className,
}: {
  title: React.ReactNode;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
  lead?: React.ReactNode;
  as?: "h1" | "h2";
  className?: string;
}) {
  return (
    <header className={cx("flex min-w-0 flex-wrap items-end justify-between gap-x-6 gap-y-3", className)}>
      <div className="flex min-w-0 items-end gap-2">
        {lead}
        <div className="min-w-0">
          <Tag
            data-page-title=""
            className="font-display text-ink m-0 text-balance text-[28px]/[1.15] font-semibold tracking-[-0.035em] [overflow-wrap:anywhere] max-sm:text-2xl/[1.2]"
          >
            {title}
          </Tag>
          {meta ? <p className="text-ink-2 m-0 mt-1 text-sm/[1.45]">{meta}</p> : null}
        </div>
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}
