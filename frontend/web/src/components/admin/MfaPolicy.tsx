"use client";

import { IconTile } from "@/components/ui/Bento";
import { LockIcon } from "@/components/app/icons";
import { useState } from "react";
import { useT } from "@/lib/i18n/client";
import { api } from "@/lib/client";
import { cx } from "@/lib/ui";

/** Admin › Bảo mật: require two-step sign-in for everyone who signs in with a password. */
export function MfaPolicy({ required: initial, selfEnabled }: { required: boolean; selfEnabled: boolean }) {
  const tx = useT();
  const [required, setRequired] = useState(initial);
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    setBusy(true);
    try {
      setRequired((await api<{ required: boolean }>("identity/security/mfa-policy", { method: "PUT", body: { required: !required } })).required);
    } finally {
      setBusy(false);
    }
  };
  const blocked = !required && !selfEnabled;
  return (
    <section className="bg-surface shadow-card my-6 grid gap-2 rounded-xl p-5" aria-labelledby="mfa-policy-h">
      <div className="flex items-center gap-3">
        <h2 id="mfa-policy-h" className="m-0 flex min-w-0 flex-1 items-center gap-3 text-sm/6 font-semibold tracking-[-0.01em]">
          <IconTile tone="green">
            <LockIcon />
          </IconTile>
          {tx("auth.twoStep.policyTitle")}
        </h2>
        <button
          type="button"
          role="switch"
          aria-checked={required}
          aria-labelledby="mfa-policy-h"
          disabled={busy || blocked}
          onClick={() => void toggle()}
          className={cx("relative h-6 w-11 rounded-full transition-colors disabled:opacity-50", required ? "bg-brand" : "bg-hairline")}
        >
          <span className={cx("bg-surface absolute top-0.5 size-5 rounded-full shadow transition-[left]", required ? "left-[22px]" : "left-0.5")} />
        </button>
      </div>
      <p className="text-ink-2 m-0 text-sm">{tx("auth.twoStep.policyLead")}</p>
      <p className={cx("m-0 text-sm font-medium", required ? "text-ok" : "text-ink-2")}>{required ? tx("auth.twoStep.policyOn") : tx("auth.twoStep.policyOff")}</p>
      {blocked ? <p className="text-warn m-0 text-sm">{tx("auth.twoStep.policyNeedSelf")}</p> : null}
    </section>
  );
}
