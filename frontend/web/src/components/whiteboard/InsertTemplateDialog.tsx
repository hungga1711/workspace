"use client";

import { useState } from "react";
import { useT } from "@/lib/i18n/client";
import { btn, btnPrimary } from "@/lib/ui";
import { Modal } from "@/components/ui/Modal";
import { TemplateGrid } from "./TemplateCards";
import type { TemplateKey } from "./types";

/** "Mẫu": inserts a template's shapes in the middle of the open board. */
export function InsertTemplateDialog({ onClose, onInsert }: { onClose: () => void; onInsert: (key: TemplateKey) => void }) {
  const t = useT();
  const [key, setKey] = useState<TemplateKey>("retro");
  return (
    <Modal
      wide
      title={t("whiteboard.insertTitle")}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btn} onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className={btnPrimary}
            disabled={key === "blank"}
            onClick={() => {
              onInsert(key);
              onClose();
            }}
          >
            {t("whiteboard.insert")}
          </button>
        </>
      }
    >
      <TemplateGrid value={key} onChange={setKey} label={t("whiteboard.templateLabel")} />
    </Modal>
  );
}
