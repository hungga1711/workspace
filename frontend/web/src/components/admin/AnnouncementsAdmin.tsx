"use client";

import { CalmEmpty } from "./AdminBits";
import { useT, useFormat } from "@/lib/i18n/client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/client";
import { useDirectory } from "@/lib/people";
import { btnPrimary, cx, table, tableScroll } from "@/lib/ui";
import { AdminHeader } from "./AdminNav";
import { Menu } from "@/components/ui/Menu";
import { MoreIcon, PinIcon, PlusIcon } from "@/components/app/icons";
import { AnnouncementComposer } from "@/components/announcements/AnnouncementComposer";
import { AnnouncementDrawer } from "@/components/announcements/AnnouncementDrawer";
import { CATEGORY, type Announcement } from "@/components/announcements/types";
import { useConfirm } from "@/components/ui/Confirm";

/** Company announcements (Employee Experience): schedule, target departments, pin, see reach. */
export function AnnouncementsAdmin({
  announcements,
  canPublish,
  departments,
}: {
  announcements: Announcement[];
  canPublish: boolean;
  departments: { id: string; name: string }[];
}) {
  const tx = useT();
  const { confirm, dialog } = useConfirm();
  const { dayLabel, time } = useFormat();
  const when = (iso: string) => `${dayLabel(iso)} ${time(iso)}`;
  const router = useRouter();
  const dir = useDirectory();
  const [modal, setModal] = useState<"new" | Announcement | null>(null);
  const [open, setOpen] = useState<Announcement | null>(null);
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "err" } | null>(null);
  const members = dir.people.filter((p) => p.status === "active").length;
  const dname = Object.fromEntries(departments.map((d) => [d.id, d.name]));
  const state = (a: Announcement) => {
    const now = Date.now();
    if (Date.parse(a.publishAt) > now) return { label: tx("admin.announcementsadmin.hen_dang", { p0: when(a.publishAt) }), tone: "text-warn" };
    if (a.expiresAt && Date.parse(a.expiresAt) <= now) return { label: tx("admin.announcementsadmin.da_het_hieu_luc"), tone: "text-ink-2" };
    return { label: tx("admin.announcementsadmin.dang_hien_thi"), tone: "text-ok" };
  };
  const remove = async (a: Announcement) => {
    if (!(await confirm({ title: tx("admin.announcementsadmin.go_thong_bao_moi", { p0: a.title }), danger: true }))) return;
    try {
      await api(`employee/announcements/${a.id}`, { method: "DELETE" });
      setMsg({ text: tx("admin.announcementsadmin.da_go_thong_bao"), tone: "ok" });
      router.refresh();
    } catch {
      setMsg({ text: tx("admin.announcementsadmin.chua_go_duoc"), tone: "err" });
    }
  };
  const pin = async (a: Announcement) => {
    try {
      await api(`employee/announcements/${a.id}`, { method: "PATCH", body: { pinned: !a.pinned } });
      setMsg({ text: a.pinned ? tx("admin.announcementsadmin.da_bo_ghim") : tx("admin.announcementsadmin.da_ghim"), tone: "ok" });
      router.refresh();
    } catch {
      setMsg({ text: tx("admin.announcementsadmin.chua_ghim_duoc"), tone: "err" });
    }
  };

  return (
    <>
      {dialog}
      <>
        <AdminHeader
          title={tx("admin.announcementsadmin.thong_bao_cong_ty")}
          sub={tx("admin.announcementsadmin.thong_bao_xuat_hien")}
          actions={
            canPublish ? (
              <button type="button" className={btnPrimary} onClick={() => setModal("new")}>
                <PlusIcon className="size-4" />
                {tx("admin.announcementsadmin.dang_thong_bao")}
              </button>
            ) : null
          }
        />
        {msg ? (
          <p className={cx("mb-4 rounded-lg px-3 py-2 text-sm", msg.tone === "ok" ? "bg-ok-wash text-ok" : "bg-block-wash text-block")} role="status">
            {msg.text}
          </p>
        ) : null}
        {!canPublish ? <p className="bg-hover text-ink-2 mb-4 rounded-md px-3 py-2 text-sm">{tx("admin.announcementsadmin.ban_can_quyen_announcement")}</p> : null}
        {announcements.length === 0 ? (
          <CalmEmpty title={tx("admin.announcementsadmin.chua_co_thong_bao")} hint={tx("admin.announcementsadmin.dang_lich_nghi_le")} />
        ) : (
          <div className="bg-surface shadow-card overflow-x-auto rounded-xl">
            <table className={cx(table, tableScroll)}>
              <thead>
                <tr>
                  <th>{tx("admin.announcementsadmin.tieu_de")}</th>
                  <th className="max-lg:hidden">{tx("admin.announcementsadmin.loai")}</th>
                  <th className="max-md:hidden">{tx("admin.announcementsadmin.gui_toi")}</th>
                  <th className="max-sm:hidden">{tx("admin.announcementsadmin.trang_thai")}</th>
                  <th className="text-right">{tx("admin.announcementsadmin.da_doc")}</th>
                  <th>
                    <span className="sr-only">{tx("admin.announcementsadmin.thao_tac")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {announcements.map((a) => {
                  const st = state(a);
                  return (
                    <tr key={a.id}>
                      {/* Below 1024px the type, then the audience and status, move under the title so the read count and the
                          actions stay on screen without scrolling sideways. */}
                      <td className="max-lg:!whitespace-normal">
                        <button type="button" className="flex items-center gap-1.5 text-left font-medium hover:underline" onClick={() => setOpen(a)}>
                          {a.pinned ? <PinIcon className="text-ink-2 size-3.5" /> : null}
                          {a.title}
                        </button>
                        <span className="text-ink-2 text-xs">
                          {dir.name(a.authorId)} · {when(a.publishAt)}
                        </span>
                        <span className="text-ink-2 block text-xs lg:hidden">
                          {CATEGORY(tx)[a.category] ?? a.category}
                          <span className="md:hidden">
                            {" · "}
                            {a.departmentIds.length
                              ? a.departmentIds.map((d) => dname[d] ?? tx("admin.announcementsadmin.phong_ban")).join(", ")
                              : tx("admin.announcementsadmin.toan_cong_ty")}
                          </span>
                          <span className={cx("sm:hidden", st.tone)}> · {st.label}</span>
                        </span>
                      </td>
                      <td className="max-lg:hidden">
                        {CATEGORY(tx)[a.category] ?? a.category}
                        {a.eventAt ? <span className="text-ink-2 block text-xs">{when(a.eventAt)}</span> : null}
                      </td>
                      <td className="text-sm max-md:hidden">
                        {a.departmentIds.length
                          ? a.departmentIds.map((d) => dname[d] ?? tx("admin.announcementsadmin.phong_ban")).join(", ")
                          : tx("admin.announcementsadmin.toan_cong_ty")}
                      </td>
                      <td className={cx("text-sm max-sm:hidden", st.tone)}>{st.label}</td>
                      <td className="text-right text-sm tabular-nums">
                        {a.readCount ?? 0}
                        {!a.departmentIds.length && members ? <span className="text-ink-2">/{members}</span> : null}
                      </td>
                      <td className="text-right">
                        {canPublish ? (
                          <Menu
                            label={tx("admin.announcementsadmin.thao_tac_cho", { p0: a.title })}
                            trigger={
                              <span className="text-ink-2 hover:bg-hover grid size-8 place-items-center rounded-md">
                                <MoreIcon />
                              </span>
                            }
                            items={[
                              { label: tx("admin.announcementsadmin.sua"), onSelect: () => setModal(a) },
                              { label: a.pinned ? tx("admin.announcementsadmin.bo_ghim") : tx("admin.announcementsadmin.ghim_len_dau"), onSelect: () => void pin(a) },
                              { label: tx("admin.announcementsadmin.go_thong_bao"), danger: true, onSelect: () => void remove(a) },
                            ]}
                          />
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {modal ? (
          <AnnouncementComposer
            initial={modal === "new" ? undefined : modal}
            departments={departments}
            onClose={() => setModal(null)}
            onSaved={(m) => {
              setModal(null);
              setMsg({ text: m, tone: "ok" });
              router.refresh();
            }}
          />
        ) : null}
        {open ? <AnnouncementDrawer a={open} onClose={() => setOpen(null)} /> : null}
      </>
    </>
  );
}
