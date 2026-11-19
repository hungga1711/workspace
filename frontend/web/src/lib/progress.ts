/**
 * App-wide "something is happening" signal for the top progress bar: page navigations and writes
 * (POST/PATCH/PUT/DELETE through `api`). Background reads (polling, lazy panels) stay quiet.
 */
type Listener = () => void;
let pending = 0;
const listeners = new Set<Listener>();
const emit = () => listeners.forEach((l) => l());

export const progress = {
  start() {
    pending++;
    emit();
  },
  done() {
    pending = Math.max(0, pending - 1);
    emit();
  },
  /** Navigations finish when the URL changes; this clears them all at once. */
  reset() {
    pending = 0;
    emit();
  },
  get: () => pending,
  subscribe(l: Listener) {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
};
