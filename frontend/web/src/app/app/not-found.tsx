import Link from "next/link";
import { getT } from "@/lib/i18n/server";
import { btn, btnPrimary } from "@/lib/ui";
import { StatusScreen } from "@/components/ui/StatusScreen";

/** 404 inside the app keeps the sidebar and top bar (the root one would drop the whole shell). */
export default async function AppNotFound() {
  const t = await getT();
  return (
    <StatusScreen
      code="404"
      title={t("ui.notFound.title")}
      body={t("ui.notFound.body")}
      actions={
        <>
          <Link href="/app/home" className={btnPrimary}>
            {t("ui.notFound.home")}
          </Link>
          <Link href="/app/work" className={btn}>
            {t("shell.nav.work")}
          </Link>
        </>
      }
    />
  );
}
