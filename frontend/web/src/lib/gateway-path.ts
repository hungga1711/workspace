/**
 * Whether a gateway path climbs out of where it was built to point. Pages put ids from the URL into paths
 * (`/api/work/files/${id}/download`), and the id arrives decoded: "a/../../identity/x" or "%2e%2e" would
 * otherwise become dot segments that fetch() resolves, reaching another gateway route with the viewer's token.
 */
export function hasDotSegment(path: string): boolean {
  const pathname = path.split(/[?#]/, 1)[0]!;
  return pathname.split(/[/\\]/).some((seg) => {
    const s = seg.replace(/%2e/gi, ".");
    return s === "." || s === "..";
  });
}
