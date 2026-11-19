"use client";

import { useT } from "@/lib/i18n/client";
import { useState } from "react";
import { api } from "@/lib/client";
import { btn, btnPrimary, input, textarea } from "@/lib/ui";
import { Modal } from "@/components/ui/Modal";
import { Field } from "@/components/ui/bits";
import { Picker } from "@/components/ui/Picker";
import { DateField } from "@/components/ui/DateField";
import { Checkbox } from "@/components/ui/Checkbox";
import { CATEGORY, type Announcement } from "./types";

const local = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : "");
const toIso = (v: string) => (v ? new Date(v).toISOString() : null);

/** Like Field, but a <div>: for pickers, date fields and checkbox groups (a <label> must not wrap buttons). */
function Group({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid min-w-0 content-start gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint ? <span className="text-ink-2 text-xs">{hint}</span> : null}
    </div>
  );
}

/** Create or edit a company announcement (needs announcement.publish; the server enforces it). */
export function AnnouncementComposer({
  initial,
  departments,
  onClose,
  onSaved,
}: {
  initial?: Announcement;
  departments: { id: string; name: string }[];
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const tx = useT();
  const [title, setTitle] = useState(initial?.title ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [category, setCategory] = useState(initial?.category ?? "general");
  const [pinned, setPinned] = useState(initial?.pinned ?? false);
  const [eventAt, setEventAt] = useState(local(initial?.eventAt ?? null));
  const [linkUrl, setLinkUrl] = useState(initial?.linkUrl ?? "");
  const [publishAt, setPublishAt] = useState("");
  const [expiresAt, setExpiresAt] = useState(local(initial?.expiresAt ?? null));
  const [depts, setDepts] = useState<string[]>(initial?.departmentIds ?? []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (category === "event" && !eventAt) {
      setError(tx("ann.announcementcomposer.su_kien_can_co"));
      return;
    }
    if (linkUrl && !linkUrl.startsWith("https://")) {
      setError(tx("ann.announcementcomposer.lien_ket_phai_bat"));
      return;
    }
    setBusy(true);
    setError(null);
    const common = { title, body, category, pinned, departmentIds: depts, eventAt: toIso(eventAt), linkUrl: linkUrl || null, expiresAt: toIso(expiresAt) };
    try {
      if (initial) await api(`employee/announcements/${initial.id}`, { method: "PATCH", body: common });
      else await api("employee/announcements", { method: "POST", body: { ...common, publishAt: toIso(publishAt) } });
      onSaved(
        initial
          ? tx("ann.announcementcomposer.da_cap_nhat_thong")
          : publishAt
            ? tx("ann.announcementcomposer.da_len_lich_thong")
            : depts.length
              ? tx("ann.announcementcomposer.da_dang_cho_phong_ban", {
                  p0: departments
                    .filter((d) => depts.includes(d.id))
                    .map((d) => d.name)
                    .join(", "),
                })
              : tx("ann.announcementcomposer.da_dang_thong_bao"),
      );
    } catch (e) {
      setError((e as Error).message.includes("https") ? tx("ann.announcementcomposer.lien_ket_phai_bat") : tx("ann.announcementcomposer.chua_dang_duoc_kiem"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={initial ? tx("ann.announcementcomposer.sua_thong_bao") : tx("ann.announcementcomposer.dang_thong_bao_cong")}
      wide
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btn} onClick={onClose}>
            {tx("ann.announcementcomposer.huy")}
          </button>
          <button type="button" className={btnPrimary} disabled={!title.trim() || busy} onClick={() => void save()}>
            {initial ? tx("ann.announcementcomposer.luu") : tx("ann.announcementcomposer.dang")}
          </button>
        </>
      }
    >
      <div className="grid gap-4 md:grid-cols-[1fr_240px]">
        <div className="grid content-start gap-4">
          {error ? (
            <p className="bg-block-wash text-block rounded-lg px-3 py-2 text-sm" role="alert">
              {error}
            </p>
          ) : null}
          <Field label={tx("ann.announcementcomposer.tieu_de")}>
            <input className={input} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder={tx("ann.announcementcomposer.lich_nghi_le_20")} />
          </Field>
          <Field label={tx("ann.announcementcomposer.noi_dung")} hint={tx("ann.announcementcomposer.ho_tro_dam_nghieng")}>
            <textarea className={`${textarea} min-h-44`} value={body} onChange={(e) => setBody(e.target.value)} maxLength={20000} />
          </Field>
        </div>
        <div className="grid content-start gap-4">
          <Group label={tx("ann.announcementcomposer.loai")}>
            <Picker
              variant="field"
              label={tx("ann.announcementcomposer.loai")}
              value={category}
              onChange={setCategory}
              options={Object.entries(CATEGORY(tx)).map(([k, v]) => ({ value: k, label: v }))}
            />
          </Group>
          {category === "event" ? (
            <Group label={tx("ann.announcementcomposer.thoi_gian_dien_ra")}>
              <DateField withTime label={tx("ann.announcementcomposer.thoi_gian_dien_ra")} value={eventAt} onChange={setEventAt} />
            </Group>
          ) : null}
          <Group label={tx("ann.announcementcomposer.gui_toi")} hint={depts.length ? undefined : tx("ann.announcementcomposer.de_trong_toan_cong")}>
            <div className="border-hairline grid max-h-40 gap-2 overflow-auto rounded-md border p-3 text-sm">
              {departments.length === 0 ? (
                <span className="text-ink-2">{tx("ann.announcementcomposer.toan_cong_ty")}</span>
              ) : (
                departments.map((d) => (
                  <Checkbox
                    key={d.id}
                    checked={depts.includes(d.id)}
                    onChange={(e) => setDepts((x) => (e.target.checked ? [...x, d.id] : x.filter((y) => y !== d.id)))}
                    label={d.name}
                  />
                ))
              )}
            </div>
          </Group>
          <Checkbox checked={pinned} onChange={(e) => setPinned(e.target.checked)} label={tx("ann.announcementcomposer.ghim_len_dau")} />
          <Field label={tx("ann.announcementcomposer.lien_ket_dang_ky")}>
            <input className={input} value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} placeholder="https://" inputMode="url" />
          </Field>
          {!initial ? (
            <Group label={tx("ann.announcementcomposer.hen_gio_dang_tuy")}>
              <DateField withTime label={tx("ann.announcementcomposer.hen_gio_dang_tuy")} value={publishAt} onChange={setPublishAt} />
            </Group>
          ) : null}
          <Group label={tx("ann.announcementcomposer.het_hieu_luc_tuy")}>
            <DateField withTime label={tx("ann.announcementcomposer.het_hieu_luc_tuy")} value={expiresAt} onChange={setExpiresAt} />
          </Group>
        </div>
      </div>
    </Modal>
  );
}
