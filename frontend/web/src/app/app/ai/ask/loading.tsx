/*
 * Hỏi đáp's skeleton: the composer where it will be, so moving here from another page answers at once instead of
 * waiting on the server with the old page still up.
 */
export default function Loading() {
  return (
    <div className="bg-surface flex min-h-0 flex-1 flex-col" aria-busy="true" aria-live="polite">
      <div className="min-h-0 flex-1" />
      <div className="mx-auto w-full max-w-[720px] px-4 pb-4 md:px-6">
        <div className="bg-surface border-hairline h-[92px] rounded-2xl border" />
        <div className="mt-2 h-4" />
      </div>
    </div>
  );
}
