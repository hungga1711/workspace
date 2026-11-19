import { BrandMark } from "@/components/ui/BrandMark";
import { cx } from "@/lib/ui";

/**
 * One look for every "you can't be here" screen: 404, 403, errors, offline. The bòn bon mark, an optional
 * muted code, one title, one sentence and at most two buttons (the first one solid). `page` fills the
 * viewport with the sign-in screens' faint dot grid (no shell around it); inside the app or admin shell
 * it sits in the content column. Server-safe: no hooks.
 */
export function StatusScreen({
  code,
  title,
  body,
  actions,
  footnote,
  page = false,
}: {
  code?: string;
  title: React.ReactNode;
  body?: React.ReactNode;
  actions?: React.ReactNode;
  footnote?: React.ReactNode;
  page?: boolean;
}) {
  const inner = (
    <div className="grid w-full max-w-md justify-items-center gap-3 text-center">
      <BrandMark className="mb-2 size-10" />
      {code ? (
        <p className="text-ink-2 m-0 font-mono text-xs tabular-nums" aria-hidden="true">
          {code}
        </p>
      ) : null}
      <h1 className="font-display text-ink m-0 text-balance text-2xl/[1.2] font-semibold tracking-[-0.03em]">{title}</h1>
      {body ? <p className="text-ink-2 m-0 max-w-sm text-pretty text-sm/6">{body}</p> : null}
      {actions ? <div className="mt-3 flex flex-wrap justify-center gap-2">{actions}</div> : null}
      {footnote ? <div className="text-ink-2 mt-2 text-xs">{footnote}</div> : null}
    </div>
  );
  // Inside the shell: one raised card (Home's hero) with the dot grid fading from its top, on the canvas.
  if (!page)
    return (
      <div className="grid min-h-[60vh] place-items-center px-4 py-8 md:py-12">
        <div className="bg-surface shadow-hero relative isolate grid w-full max-w-lg place-items-center overflow-hidden rounded-2xl px-6 py-12 max-sm:rounded-2xl max-sm:py-10">
          <div aria-hidden="true" className="dot-grid pointer-events-none absolute inset-0 -z-10 [mask-image:radial-gradient(ellipse_70%_60%_at_50%_0%,black,transparent)]" />
          {inner}
        </div>
      </div>
    );
  return (
    <main id="main" className="bg-ground relative isolate grid min-h-dvh place-items-center px-4 py-12">
      <div
        aria-hidden="true"
        className={cx(
          "pointer-events-none absolute inset-0 -z-10",
          "bg-[radial-gradient(var(--hairline)_1px,transparent_1px)] [background-size:22px_22px]",
          "[mask-image:radial-gradient(ellipse_60%_55%_at_50%_45%,black,transparent)]",
        )}
      />
      {inner}
    </main>
  );
}
