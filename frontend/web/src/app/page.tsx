import { redirect } from "next/navigation";
import { readSession } from "@/lib/session";
import { isSetUp } from "@/lib/setup";

export const dynamic = "force-dynamic";

/** No public site: signed-in people go to the app, others to sign-in (or to first-run setup on a new installation). */
export default async function Root() {
  if (await readSession()) redirect("/app/home");
  redirect((await isSetUp()) ? "/login" : "/setup");
}
