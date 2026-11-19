import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getT } from "@/lib/i18n/server";
import { isSetUp, setupOptions } from "@/lib/setup";
import { authCard, cx } from "@/lib/ui";
import { SetupForm } from "./form";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const tx = await getT();
  return { title: tx("setup.metaTitle"), robots: { index: false } };
}

/** First-run setup: the installation's one workspace and its first admin. Once done, everyone else joins by invitation. */
export default async function Setup() {
  if (await isSetUp()) redirect("/login");
  const [tx, { tokenRequired, ai }] = await Promise.all([getT(), setupOptions()]);
  return (
    <div className={cx(authCard, "!shadow-hero")}>
      <h1 className="font-display m-0 mb-1 text-center text-xl font-semibold tracking-tight">{tx("setup.title")}</h1>
      <p className="text-ink-2 mb-6 mt-1 text-center text-sm">{tx("setup.leadShort")}</p>
      {/* TEST_FIXTURES=1 (test installations): AI starts switched on, as the signup API already does there. */}
      <SetupForm tokenRequired={tokenRequired} ai={ai} aiDefault={process.env.TEST_FIXTURES === "1"} />
    </div>
  );
}
