"use client";

import { useCallback, useRef, useState } from "react";
import { useT } from "@/lib/i18n/client";
import { btn, btnDanger, btnPrimary, input } from "@/lib/ui";
import { Modal } from "./Modal";

export interface ConfirmOptions {
  title: string;
  /** One or two plain sentences: what happens and whether it can be undone. */
  body?: React.ReactNode;
  /** The confirm button says what it does ("Delete role"), never just "OK". */
  confirmLabel?: string;
  danger?: boolean;
  /** Irreversible, workspace-wide actions: the button stays disabled until this exact text is typed. */
  typeToConfirm?: string;
}

/**
 * The app's own confirmation step, in place of window.confirm (unstyled, untranslated buttons, easy to click through).
 * `await confirm({...})` resolves true only on the confirm button; Esc, ×, Cancel and the scrim resolve false.
 * Render `dialog` anywhere in the calling component.
 */
export function useConfirm() {
  const [open, setOpen] = useState<ConfirmOptions | null>(null);
  const settle = useRef<((ok: boolean) => void) | null>(null);
  const confirm = useCallback(
    (o: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        settle.current?.(false);
        settle.current = resolve;
        setOpen(o);
      }),
    [],
  );
  const done = (ok: boolean) => {
    settle.current?.(ok);
    settle.current = null;
    setOpen(null);
  };
  const dialog = open ? <ConfirmDialog o={open} onDone={done} /> : null;
  return { confirm, dialog };
}

function ConfirmDialog({ o, onDone }: { o: ConfirmOptions; onDone: (ok: boolean) => void }) {
  const t = useT();
  const [typed, setTyped] = useState("");
  const blocked = !!o.typeToConfirm && typed.trim() !== o.typeToConfirm.trim();
  return (
    <Modal
      title={o.title}
      onClose={() => onDone(false)}
      footer={
        <>
          <button type="button" className={btn} onClick={() => onDone(false)}>
            {t("common.cancel")}
          </button>
          <button type="button" className={o.danger ? btnDanger : btnPrimary} disabled={blocked} onClick={() => onDone(true)}>
            {o.confirmLabel ?? t("common.confirm")}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        {o.body ? <div className="text-ink-soft m-0">{o.body}</div> : null}
        {o.typeToConfirm ? (
          <label className="flex flex-col gap-1.5">
            <span className="text-ink-2 text-xs">{t("common.typeToConfirm", { text: o.typeToConfirm })}</span>
            <input
              className={input}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !blocked) onDone(true);
              }}
            />
          </label>
        ) : null}
      </div>
    </Modal>
  );
}
