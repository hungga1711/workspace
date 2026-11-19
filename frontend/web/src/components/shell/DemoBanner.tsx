import { config } from "@/lib/config";
import { getT } from "@/lib/i18n/server";

/** The public demo (DEMO_MODE=1): one line above every app and admin page, so nobody mistakes it for a real company. */
export async function DemoBanner() {
  if (!config.demoMode) return null;
  const tx = await getT();
  return (
    <p className="bg-signal-wash text-signal-text m-0 px-4 py-1.5 text-center text-xs font-medium print:hidden" role="status" data-testid="demo-banner">
      {tx("demo.banner")}
    </p>
  );
}
