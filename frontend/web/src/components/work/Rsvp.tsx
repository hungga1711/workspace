"use client";

import { useT } from "@/lib/i18n/client";
import { btn, btnGhost, btnSm, chip, chipOk, cx } from "@/lib/ui";
import { CheckIcon, CloseIcon } from "@/components/app/icons";

export type Response = "accepted" | "declined";

/**
 * My answer to an invitation, the same on the calendar list and the meeting page. Before the event: the answer I
 * gave is filled (green yes, red no) and no longer a button; the other stays quiet, for a change of mind. After
 * the event: the answer as a record ("Đã tham gia", "Đã từ chối", "Không trả lời"), nothing to press.
 */
export function Rsvp({
  response,
  past,
  onRespond,
  size = "sm",
  className,
}: {
  response: string;
  past: boolean;
  onRespond: (r: Response) => void;
  size?: "sm" | "md";
  className?: string;
}) {
  const t = useT();
  const accepted = response === "accepted";
  const declined = response === "declined";
  if (past)
    return (
      <span className={cx(accepted ? chipOk : chip, className)}>
        {accepted ? <CheckIcon className="size-3.5" /> : null}
        {t(accepted ? "work.rsvp.attended" : declined ? "work.rsvp.declinedPast" : "work.rsvp.noReply")}
      </span>
    );
  const sm = size === "sm" ? btnSm : "";
  return (
    <span role="group" aria-label={t("work.rsvp.label")} className={cx("flex items-center gap-1.5", className)}>
      <button
        type="button"
        aria-pressed={accepted}
        onClick={() => !accepted && onRespond("accepted")}
        className={cx(declined ? btnGhost : btn, sm, accepted && "border-ok bg-ok-wash text-ok hover:bg-ok-wash hover:text-ok cursor-default")}
      >
        {accepted ? <CheckIcon /> : null}
        {t(accepted ? "work.rsvp.attending" : "work.rsvp.attend")}
      </button>
      <button
        type="button"
        aria-pressed={declined}
        onClick={() => !declined && onRespond("declined")}
        className={cx(accepted ? btnGhost : btn, sm, declined && "border-block bg-block-wash text-block hover:bg-block-wash hover:text-block cursor-default")}
      >
        {declined ? <CloseIcon /> : null}
        {t(declined ? "work.rsvp.declined" : "work.rsvp.decline")}
      </button>
    </span>
  );
}
