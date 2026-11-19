import { cx, skeleton } from "@/lib/ui";

/*
 * Home's own skeleton: the same frame as the page (greeting, the ask bar, Do now beside the ring, the bento of tiles) with fixed
 * heights, so the swap to the real page moves little. Only list pages get a loading boundary (a record page's 404 would
 * turn into a 200).
 */
const tile = "bg-surface shadow-card rounded-xl";

export default function Loading() {
  return (
    <div className="flex w-full flex-col gap-5 max-md:gap-4" aria-busy="true" aria-live="polite">
      <div className="@container flex flex-col gap-4">
        <span className={cx(skeleton, "h-8 w-72 max-w-full")} />
        <div className="bg-surface shadow-card h-14 rounded-xl" />
        <div className="@3xl:grid-cols-[minmax(0,1fr)_17rem] grid gap-4">
          <div className="bg-surface shadow-card h-52 rounded-xl" />
          <div className="bg-surface shadow-card @3xl:h-52 h-32 rounded-xl" />
        </div>
        <div className="@xl:grid-cols-2 @4xl:grid-cols-3 grid gap-4">
          <div className={cx(tile, "h-48")} />
          <div className={cx(tile, "@4xl:row-span-2 h-48")} />
          <div className={cx(tile, "@4xl:row-span-2 h-48")} />
          <div className={cx(tile, "h-48")} />
        </div>
      </div>
    </div>
  );
}
