"use client";

import { IconTile } from "@/components/ui/Bento";
import { ShieldIcon } from "@/components/app/icons";
import { useT, useFormat } from "@/lib/i18n/client";
import { roleLabel } from "./roleLabel";
import { Segmented } from "@/components/ui/Segmented";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/client";
import { csvFile } from "@/lib/csv";
import { btn, btnSm, cx, table, tableScroll } from "@/lib/ui";
import { InfoTip } from "@/components/ui/InfoTip";
import { useConfirm } from "@/components/ui/Confirm";

export interface ReviewMember {
  userId: string;
  email: string;
  displayName: string;
  status: string;
  isOwner: boolean;
  admin: boolean;
  roles: string[];
  createdAt: string;
  lastSeenAt: string | null;
}
export interface ReviewKey {
  id: string;
  name: string;
  permissions: string[];
  createdBy: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

const DAY = 86400_000;
const idle = (m: ReviewMember) => m.status === "active" && (!m.lastSeenAt || Date.now() - Date.parse(m.lastSeenAt) > 30 * DAY);

/** Access review (SOC 2 style): who still has access, with which rights, and when they last used it. */
export function AccessReview({ members, apiKeys }: { members: ReviewMember[]; apiKeys: ReviewKey[] }) {
  const { ago } = useFormat();
  const tx = useT();
  const { confirm, dialog } = useConfirm();
  const router = useRouter();
  const [view, setView] = useState<"all" | "idle" | "admin">("idle");
  const [msg, setMsg] = useState<string | null>(null);
  const rows = members.filter((m) => m.status !== "disabled" && (view === "all" || (view === "idle" ? idle(m) : m.admin)));
  const counts = {
    all: members.filter((m) => m.status !== "disabled").length,
    idle: members.filter(idle).length,
    admin: members.filter((m) => m.admin && m.status !== "disabled").length,
  };
  const disable = async (m: ReviewMember) => {
    if (!(await confirm({ title: tx("admin.accessreview.vo_hieu_hoa_ho", { p0: m.displayName }), danger: true }))) return;
    await api(`identity/members/${m.userId}/disable`, { method: "POST" });
    setMsg(tx("admin.accessreview.da_vo_hieu_hoa", { p0: m.displayName }));
    router.refresh();
  };
  const exportCsv = () => {
    const body = csvFile(
      [
        tx("admin.accessreview.ho_ten"),
        "Email",
        tx("admin.accessreview.trang_thai"),
        tx("admin.accessreview.vai_tro"),
        tx("admin.accessreview.quyen_quan_tri_2"),
        tx("admin.accessreview.chu_so_huu"),
        tx("admin.accessreview.hoat_dong_gan_nhat_2"),
        "Tham gia (UTC)",
      ],
      members.map((m) => [
        m.displayName,
        m.email,
        m.status,
        m.roles.map((r) => roleLabel(r, tx)).join(", "),
        m.admin ? tx("admin.accessreview.co") : tx("admin.accessreview.khong"),
        m.isOwner ? tx("admin.accessreview.co") : tx("admin.accessreview.khong"),
        m.lastSeenAt ?? "",
        m.createdAt,
      ]),
    );
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([body], { type: "text/csv;charset=utf-8" }));
    a.download = `ra-soat-truy-cap-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <>
      {dialog}
      <section className="mt-8" aria-labelledby="review-h">
        <div className="mb-2 flex flex-wrap items-center gap-3">
          <h2 id="review-h" className="flex min-w-0 flex-1 items-center gap-3 text-sm/6 font-semibold tracking-[-0.01em]">
            <IconTile tone="violet">
              <ShieldIcon />
            </IconTile>
            {tx("admin.accessreview.ra_soat_quyen_truy")}
            <InfoTip text={tx("admin.accessreview.dinh_ky")} label={tx("admin.accessreview.ra_soat_quyen_truy")} />
          </h2>
          <Segmented
            size="sm"
            phoneGrid={3}
            // Phones: three equal cells whose labels wrap, so "Không hoạt động 30 ngày" is not cut off.
            className="max-sm:[&>button]:h-auto max-sm:[&>button]:min-h-8 max-sm:[&>button]:flex-wrap max-sm:[&>button]:py-1 max-sm:[&>button]:text-center"
            label={tx("admin.accessreview.loc")}
            value={view}
            onChange={setView}
            options={[
              { value: "idle", label: tx("admin.accessreview.khong_hoat_dong_30"), count: counts.idle },
              { value: "admin", label: tx("admin.accessreview.co_quyen_quan_tri"), count: counts.admin },
              { value: "all", label: tx("admin.accessreview.tat_ca"), count: counts.all },
            ]}
          />
          <button type="button" className={cx(btn, btnSm)} onClick={exportCsv}>
            {tx("admin.accessreview.xuat_csv")}
          </button>
        </div>
        {msg ? (
          <p className="bg-ok-wash text-ok mb-3 rounded-lg px-3 py-2 text-sm" role="status">
            {msg}
          </p>
        ) : null}
        {rows.length === 0 ? (
          <p className="bg-surface shadow-card text-ink-2 rounded-xl p-4 text-sm">
            {view === "idle" ? tx("admin.accessreview.moi_nguoi_deu_hoat") : tx("admin.accessreview.khong_co_ai")}
          </p>
        ) : (
          <div className="bg-surface shadow-card overflow-x-auto rounded-xl">
            <table className={cx(table, tableScroll)}>
              <thead>
                <tr>
                  <th>{tx("admin.accessreview.thanh_vien")}</th>
                  <th className="max-md:hidden">{tx("admin.accessreview.vai_tro")}</th>
                  <th className="max-sm:hidden">{tx("admin.accessreview.hoat_dong_gan_nhat")}</th>
                  <th className="w-28 max-sm:w-auto">
                    <span className="sr-only">{tx("admin.accessreview.thao_tac")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => (
                  <tr key={m.userId}>
                    <td className="max-sm:!whitespace-normal">
                      <span className="text-ink block font-medium">{m.displayName}</span>
                      <span className="text-ink-2 block break-all text-xs">{m.email}</span>
                      <span className={cx("block text-xs sm:hidden", idle(m) ? "text-warn" : "text-ink-2")}>
                        {m.status === "invited" ? tx("admin.accessreview.chua_nhan_loi_moi") : m.lastSeenAt ? ago(m.lastSeenAt) : tx("admin.accessreview.chua_tung")}
                      </span>
                    </td>
                    <td className="max-md:hidden">
                      <span className="flex flex-wrap gap-1">
                        {m.roles.map((r) => (
                          <span key={r} className="bg-hover rounded-sm px-1.5 py-0.5 text-xs">
                            {roleLabel(r, tx)}
                          </span>
                        ))}
                        {m.admin ? <span className="bg-signal-wash rounded-sm px-1.5 py-0.5 text-xs">{tx("admin.accessreview.quyen_quan_tri")}</span> : null}
                      </span>
                    </td>
                    <td className={cx("max-sm:hidden", idle(m) && "text-warn")}>
                      {m.status === "invited" ? tx("admin.accessreview.chua_nhan_loi_moi") : m.lastSeenAt ? ago(m.lastSeenAt) : tx("admin.accessreview.chua_tung")}
                    </td>
                    <td>
                      {m.isOwner || m.status !== "active" ? null : (
                        <button type="button" className={cx(btn, btnSm)} onClick={() => void disable(m)} aria-label={tx("admin.accessreview.vo_hieu_hoa", { p0: m.displayName })}>
                          {tx("admin.accessreview.vo_hieu_hoa_2")}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {apiKeys.length ? (
          <p className="text-ink-2 mt-3 text-sm">
            {tx("admin.accessreview.khoa_api_dang_hoat", {
              p0: apiKeys.length,
              p1: apiKeys.some((k) => !k.lastUsedAt || Date.now() - Date.parse(k.lastUsedAt) > 30 * DAY)
                ? tx("admin.accessreview.trong_do_khoa_khong", { p0: apiKeys.filter((k) => !k.lastUsedAt || Date.now() - Date.parse(k.lastUsedAt) > 30 * DAY).length })
                : "",
            })}
          </p>
        ) : null}
      </section>
    </>
  );
}
