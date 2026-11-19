"use client";

import { useT } from "@/lib/i18n/client";
import type { T } from "@/lib/i18n/core";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/client";
import { btnPrimary, btnGhost, cx, textarea } from "@/lib/ui";
import { Picker } from "@/components/ui/Picker";

/** `link`: the activation link when the email did not go out (no SMTP), for the owner to hand over instead. */
type Result = { email: string; ok: boolean; message?: string; link?: string };

const NEXT = "/app/chat/general";

function reason(err: unknown, t: T): { text: string } {
  const e = err as { status?: number };
  return {
    text: t(e.status === 409 ? "onboarding.alreadyMember" : e.status === 400 ? "onboarding.badEmail" : e.status === 403 ? "onboarding.noPermission" : "onboarding.inviteFailed"),
  };
}

/** Emails separated by commas, spaces or new lines. */
const parse = (text: string) => [
  ...new Set(
    text
      .split(/[\s,;]+/)
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  ),
];
const ROLES = ["Employee", "Manager", "Admin"] as const;

function CopyLink({ url }: { url: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="text-ink-2 hover:text-ink ml-2 text-xs underline"
      onClick={() =>
        void navigator.clipboard
          .writeText(url)
          .then(() => setCopied(true))
          .catch(() => window.prompt(t("onboarding.copyLink"), url))
      }
    >
      {copied ? t("onboarding.linkCopied") : t("onboarding.copyLink")}
    </button>
  );
}

/**
 * One box for any number of colleagues (paste a list) and one role for all of them. Each address succeeds or fails
 * on its own, so one bad email never blocks the others; the ones that failed stay in the box.
 */
export function WelcomeInvite() {
  const router = useRouter();
  const t = useT();
  const [text, setText] = useState("");
  const [role, setRole] = useState<(typeof ROLES)[number]>("Employee");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Result[] | null>(null);

  const submit = async () => {
    const list = parse(text);
    if (list.length === 0) {
      router.push(NEXT);
      return;
    }
    setBusy(true);
    const out: Result[] = [];
    for (const email of list) {
      try {
        const r = await api<{ emailed?: boolean; activationUrl?: string | null }>("identity/members/invite", {
          method: "POST",
          body: { email, displayName: email.split("@")[0], roleNames: [role] },
        });
        // Added but not emailed (no SMTP yet): keep the link on screen, this is the only place the owner sees it.
        out.push(r.emailed || !r.activationUrl ? { email, ok: true } : { email, ok: true, link: r.activationUrl });
      } catch (err) {
        const why = reason(err, t);
        out.push({ email, ok: false, message: why.text });
      }
    }
    setBusy(false);
    if (out.every((r) => r.ok && !r.link)) {
      router.push(NEXT);
      return;
    }
    setResults(out);
    setText(
      out
        .filter((r) => !r.ok)
        .map((r) => r.email)
        .join("\n"),
    );
  };

  return (
    <form
      className="grid grid-cols-1 gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {results ? (
        <ul className="bg-hover m-0 grid list-none gap-1 rounded-md p-3 text-sm" role="status">
          {results.map((r) => (
            <li key={r.email} className={r.ok ? (r.link ? "text-warn" : "text-ok") : "text-block"}>
              <span className="font-medium">{r.email}</span>: {r.ok ? (r.link ? t("onboarding.emailNotSent") : t("onboarding.invited")) : r.message}
              {r.link ? <CopyLink url={r.link} /> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <label className="grid gap-1.5 text-sm font-medium">
        {t("onboarding.emailsLabel")}
        <textarea
          className={cx(textarea, "min-h-28 font-normal")}
          placeholder={t("onboarding.r2.emailsPh")}
          value={text}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={results?.some((r) => !r.ok) || undefined}
          onChange={(e) => setText(e.target.value)}
        />
        <span className="text-ink-2 text-xs font-normal">{parse(text).length ? t("onboarding.emailsCount", { count: parse(text).length }) : t("onboarding.emailsHint")}</span>
      </label>
      <div className="grid gap-1.5 text-sm font-medium">
        <span id="invite-role">{t("onboarding.roleLabel")}</span>
        <Picker
          variant="field"
          label={t("onboarding.roleLabel")}
          value={role}
          onChange={(v) => setRole(v as (typeof ROLES)[number])}
          options={ROLES.map((r) => ({ value: r, label: t(`onboarding.roles.${r}`) }))}
        />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button className={btnPrimary} type="submit" disabled={busy}>
          {t(busy ? "onboarding.sending" : results ? "onboarding.retryContinue" : "onboarding.inviteContinue")}
        </button>
        <Link className={cx(btnGhost)} href={NEXT}>
          {t(results ? "onboarding.continueLater" : "onboarding.skip")}
        </Link>
      </div>
    </form>
  );
}
