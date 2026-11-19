import { getT } from "@/lib/i18n/server";
import { btn, btnPrimary } from "@/lib/ui";
import Link from "next/link";
import type { Metadata } from "next";
import { StatusScreen } from "@/components/ui/StatusScreen";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("ui.notFound.title"), robots: { index: false } };
}

/** 404 in product language (also used when a record is not visible to the viewer: we never say which). */
export default async function NotFound() {
  const t = await getT();
  return (
    <StatusScreen
      page
      code="404"
      title={t("ui.notFound.title")}
      body={t("ui.notFound.body")}
      actions={
        <>
          <Link href="/app/home" className={btnPrimary}>
            {t("ui.notFound.home")}
          </Link>
          <Link href="/" className={btn}>
            {t("ui.notFound.site")}
          </Link>
        </>
      }
    />
  );
}
