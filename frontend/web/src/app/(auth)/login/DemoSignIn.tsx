import { getT } from "@/lib/i18n/server";
import { authCard, cx } from "@/lib/ui";
import { demoSignIn } from "./actions";

// Staff first: a visitor who suspects surveillance should see what a person sees about themselves before the
// owner's view, and the owner's view reads differently once the self-view is known.
const ROLES = [
  ["staff", "demo.asStaff", "demo.asStaffHint"],
  ["manager", "demo.asManager", "demo.asManagerHint"],
  ["owner", "demo.asOwner", "demo.asOwnerHint"],
] as const;

/** Above the sign-in form in the public demo: one button per seeded role, no password typed. */
export async function DemoSignIn() {
  const tx = await getT();
  return (
    <div className={cx(authCard, "!shadow-hero grid gap-3")} data-testid="demo-signin">
      <h2 className="font-display m-0 text-base font-semibold tracking-tight">{tx("demo.quickTitle")}</h2>
      <div className="grid gap-2">
        {ROLES.map(([as, label, hint]) => (
          <form key={as} action={demoSignIn}>
            <input type="hidden" name="as" value={as} />
            <button
              type="submit"
              className="border-hairline bg-surface hover:bg-hover grid w-full cursor-pointer gap-0.5 rounded-lg border px-3.5 py-2.5 text-left"
              data-testid={`demo-as-${as}`}
            >
              <span className="text-sm font-semibold">{tx(label)}</span>
              <span className="text-ink-2 text-xs">{tx(hint)}</span>
            </button>
          </form>
        ))}
      </div>
      <p className="text-ink-2 m-0 text-xs">{tx("demo.quickHint")}</p>
    </div>
  );
}
