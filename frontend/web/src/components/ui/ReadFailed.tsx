import { getT } from "@/lib/i18n/server";
import { btn } from "@/lib/ui";
import { StatusScreen } from "@/components/ui/StatusScreen";
import { RetryButton } from "@/components/ui/RetryButton";

/**
 * Stands in for a page body whose main read failed (lib/page-read.ts): "no access" for a 403, otherwise a calm
 * retry. The shell around it stays usable, unlike the error screen a thrown read brings up.
 */
export async function ReadFailed({ status, home = "/app/home" }: { status: number; home?: string }) {
  const t = await getT();
  if (status === 403)
    return (
      <StatusScreen
        code="403"
        title={t("ui.noAccess.title")}
        body={t("ui.noAccess.body")}
        actions={
          <a href={home} className={btn}>
            {t("ui.notFound.home")}
          </a>
        }
      />
    );
  return <StatusScreen title={t("ui.pageFailed.title")} body={t("ui.pageFailed.body")} actions={<RetryButton label={t("ui.pageFailed.retry")} />} />;
}
