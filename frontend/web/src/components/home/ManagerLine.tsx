"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/client";
import { useFormat } from "@/lib/i18n/client";
import { useDirectory } from "@/lib/people";
import { btn, btnSm, cx } from "@/lib/ui";

/** First day (nothing assigned yet): who my manager is, one tap to say hello. */
export function ManagerLine({ managerId }: { managerId: string }) {
  const { t } = useFormat();
  const dir = useDirectory();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const message = () => {
    setBusy(true);
    api<{ id: string }>("chat/dms", { method: "POST", body: { userId: managerId } })
      .then((r) => router.push(`/app/chat/${r.id}`))
      .catch(() => setBusy(false));
  };
  return (
    <p className="bg-surface shadow-card m-0 flex items-center gap-3 rounded-xl px-[18px] py-3 text-sm max-md:px-3.5">
      <span className="min-w-0 flex-1 truncate">{t("home.firstDay.manager", { name: dir.name(managerId) })}</span>
      <button type="button" disabled={busy} onClick={message} className={cx(btn, btnSm)}>
        {t("home.firstDay.message")}
      </button>
    </p>
  );
}
