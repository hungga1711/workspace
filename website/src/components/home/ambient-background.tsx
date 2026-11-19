// A fixed layer behind the landing page: a faint dot grid that fades toward the edges, and three soft lights that
// drift slowly across it. Pure CSS: the lights move with transform only, so the browser composites them without
// repainting the page or running any script. Styles and keyframes are in global.css (.ambient); reduced motion
// keeps the same picture, still.

export function AmbientBackground() {
  return (
    <div aria-hidden className="ambient pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <div className="ambient-light ambient-light-a" />
      <div className="ambient-light ambient-light-b" />
      <div className="ambient-light ambient-light-c" />
      <div className="ambient-grid" />
    </div>
  );
}
