/**
 * The files of a paste or a drop. `files` is what most browsers fill; a screenshot or a picture copied from another
 * app can arrive only as `items` (Safari, some Linux clipboards), so those are read when `files` is empty.
 */
export function transferFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  if (data.files.length) return Array.from(data.files);
  return Array.from(data.items ?? [])
    .filter((i) => i.kind === "file")
    .map((i) => i.getAsFile())
    .filter((f): f is File => !!f);
}
