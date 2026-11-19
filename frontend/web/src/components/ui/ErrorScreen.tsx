"use client";

import { useT } from "@/lib/i18n/client";
import { btn, btnPrimary, btnSm, cx } from "@/lib/ui";
import { useEffect, useState } from "react";
import { mintErrorCode, reportClientError } from "@/components/rum/report";
import { StatusScreen } from "@/components/ui/StatusScreen";
import { isStaleBuildError, reloadIfStale } from "@/components/ui/staleBuild";
import { CheckIcon, CopyIcon } from "@/components/app/icons";

/** Shared error boundary screen: plain words, a way back, and a reference support can search for. */
export function ErrorScreen({
  error,
  reset,
  home = "/app/home",
  page = false,
  reported = false,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  home?: string;
  page?: boolean;
  /** CatchBoundary files the report itself (it has the component stack); the screen then only shows the code. */
  reported?: boolean;
}) {
  // Client-side render errors carry no digest, so mint the reference here: the report is filed under it, and the admin
  // pastes it in Admin › Lỗi trình duyệt to see the resolved stack.
  const [code] = useState(() => error.digest ?? mintErrorCode());
  // A chunk of an older build (the server was upgraded under this tab): reload once rather than show the screen.
  const [reloading, setReloading] = useState(() => isStaleBuildError(error));
  useEffect(() => {
    if (reloadIfStale(error)) return;
    setReloading(false);
    if (!reported) reportClientError({ message: error.message, stack: error.stack, digest: code, kind: "boundary" });
  }, [error, code, reported]);
  const t = useT();
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(code).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => undefined,
    );
  };
  if (reloading) return null;
  return (
    <StatusScreen
      page={page}
      title={t("ui.error.title")}
      body={t("ui.error.body")}
      actions={
        <>
          <button type="button" onClick={reset} className={btnPrimary}>
            {t("common.retry")}
          </button>
          <a href={home} className={btn}>
            {t("ui.error.home")}
          </a>
        </>
      }
      footnote={
        <span className="inline-flex flex-wrap items-center justify-center gap-x-2 gap-y-1">
          <span className="select-all font-mono">{t("ui.error.code", { code })}</span>
          <button type="button" onClick={copy} className={cx(btn, btnSm, copied && "text-ok")} aria-live="polite">
            {copied ? <CheckIcon /> : <CopyIcon />}
            {copied ? t("ui.error.copied") : t("ui.error.copy")}
          </button>
        </span>
      }
    />
  );
}
