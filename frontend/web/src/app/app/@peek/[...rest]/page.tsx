/**
 * Any page that is not a record opened from inside the app: nothing over it. Navigating anywhere else closes the
 * view (a slot keeps its last page on soft navigation otherwise).
 */
export default function NoPeekHere() {
  return null;
}
