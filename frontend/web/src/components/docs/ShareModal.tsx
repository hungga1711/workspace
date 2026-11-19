"use client";

import { useState } from "react";
import type { T } from "@/lib/i18n/core";
import { useT } from "@/lib/i18n/client";
import { useAiEnabled } from "@/lib/ai-context";
import { api } from "@/lib/client";
import { btn, btnPrimary } from "@/lib/ui";
import { Modal } from "@/components/ui/Modal";
import { Field } from "@/components/ui/bits";
import { PickerField } from "@/components/admin/PickerField";
import { PeoplePicker } from "@/components/chat/NewConversation";
import { LinkIcon } from "@/components/app/icons";

const VIS = (tx: T): Record<string, string> => ({
  private: tx("work.doceditor.chi_nguoi_duoc_chia"),
  project: tx("work.doceditor.thanh_vien_du_an"),
  workspace: tx("work.doceditor.ca_cong_ty"),
});

/** Who may read a page: its visibility and the people it is shared with. */
export function ShareModal({
  docId,
  meta,
  owner,
  onClose,
  onSaved,
  inSpace = false,
}: {
  docId: string;
  meta: { visibility: string; sharedWith: string[] };
  owner: string;
  /** A space page: "everyone in the space" replaces project/workspace. */
  inSpace?: boolean;
  onClose: () => void;
  onSaved: (m: { visibility: string; sharedWith: string[] }) => void;
}) {
  const tx = useT();
  const aiOn = useAiEnabled();
  const [visibility, setVisibility] = useState(meta.visibility);
  const [people, setPeople] = useState(meta.sharedWith);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const save = async () => {
    try {
      await api(`work/docs/${docId}/sharing`, { method: "PUT", body: { userIds: people, visibility } });
      onSaved({ visibility, sharedWith: people });
    } catch (e) {
      setError((e as { status?: number }).status === 403 ? tx("work.doceditor.chi_chu_tai_lieu") : tx("work.doceditor.chua_luu_duoc"));
    }
  };
  return (
    <Modal
      title={tx("work.doceditor.chia_se_tai_lieu")}
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            className={btn}
            onClick={() => {
              void navigator.clipboard.writeText(window.location.href);
              setCopied(true);
            }}
          >
            <LinkIcon className="size-4" />
            {copied ? tx("work.doceditor.da_chep") : tx("work.doceditor.chep_lien_ket")}
          </button>
          <span className="flex-1" />
          <button type="button" className={btn} onClick={onClose}>
            {tx("work.doceditor.huy")}
          </button>
          <button type="button" className={btnPrimary} onClick={() => void save()}>
            {tx("work.doceditor.luu")}
          </button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4">
        <div className="grid gap-1.5">
          <PickerField
            label={tx("work.doceditor.ai_duoc_xem")}
            value={visibility}
            onChange={setVisibility}
            options={Object.entries(inSpace ? { space: tx("docs.page.visSpace"), private: VIS(tx).private } : VIS(tx)).map(([k, v]) => ({ value: k, label: v ?? k }))}
          />
          {error ? (
            <span className="text-block text-xs" role="alert">
              {error}
            </span>
          ) : null}
        </div>
        <Field label={tx("work.doceditor.chia_se_them_cho")} hint={tx(aiOn ? "work.doceditor.nguoi_duoc_chia_se" : "work.doceditor.nguoi_duoc_chia_se_noAi")}>
          <PeoplePicker selected={people} onChange={setPeople} exclude={[owner]} />
        </Field>
      </div>
    </Modal>
  );
}
