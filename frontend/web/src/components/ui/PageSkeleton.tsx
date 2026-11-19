import { cx, skeleton } from "@/lib/ui";

/**
 * Shown by loading.tsx while a page renders on the server, so a click gets instant feedback and
 * the layout (sidebar, top bar) stays put. Decorative only: screen readers hear the busy region.
 */
export function PageSkeleton({ variant = "page" }: { variant?: "page" | "conversation" | "home" | "content" }) {
  if (variant === "content")
    // Below a page's own header and tabs (which stay put): a toolbar line and a list.
    return (
      <div className="grid grid-cols-1 gap-4" aria-busy="true" aria-live="polite">
        <div className="flex gap-2">
          <span className={cx(skeleton, "h-9 w-64")} />
          <span className={cx(skeleton, "h-9 w-40")} />
          <span className={cx(skeleton, "ml-auto h-9 w-28")} />
        </div>
        <div className="bg-surface border-hairline grid grid-cols-1 gap-4 rounded-xl border p-5">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <span key={i} className={cx(skeleton, i % 2 ? "w-2/3" : "w-5/6")} />
          ))}
        </div>
      </div>
    );
  if (variant === "conversation")
    return (
      <div className="grid h-full grid-cols-1 content-start gap-5 px-5 py-6" aria-busy="true" aria-live="polite">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex gap-3">
            <span className="bg-hover size-9 shrink-0 rounded-full" />
            <div className="grid flex-1 grid-cols-1 gap-2">
              <span className={cx(skeleton, "w-32")} />
              <span className={cx(skeleton, i % 2 ? "w-3/5" : "w-4/5")} />
            </div>
          </div>
        ))}
      </div>
    );
  if (variant === "home")
    // Same frame as the Focus Home (date, greeting, brief, needs + tiles) so the swap does not shift the page.
    return (
      <div className="mx-auto grid w-full max-w-[1120px] grid-cols-1 gap-5" aria-busy="true" aria-live="polite">
        <div className="grid grid-cols-1 gap-2">
          <span className={cx(skeleton, "h-3.5 w-40")} />
          <span className={cx(skeleton, "h-8 w-72")} />
        </div>
        <div className="bg-hover h-44 rounded-xl" />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="bg-surface border-hairline h-64 rounded-xl border lg:col-span-2" />
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-1">
            <div className="bg-surface border-hairline h-[124px] rounded-xl border" />
            <div className="bg-surface border-hairline h-[124px] rounded-xl border" />
          </div>
        </div>
      </div>
    );
  return (
    <div className="grid grid-cols-1 gap-6" aria-busy="true" aria-live="polite">
      <span className={cx(skeleton, "h-8 w-56")} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="bg-surface border-hairline grid h-28 grid-cols-1 content-start gap-3 rounded-xl border p-5">
            <span className={cx(skeleton, "w-20")} />
            <span className={cx(skeleton, "h-6 w-16")} />
          </div>
        ))}
      </div>
      <div className="bg-surface border-hairline grid grid-cols-1 gap-4 rounded-xl border p-5">
        {[0, 1, 2, 3, 4].map((i) => (
          <span key={i} className={cx(skeleton, i % 2 ? "w-2/3" : "w-5/6")} />
        ))}
      </div>
    </div>
  );
}
