"use client";

import { IconTile } from "@/components/ui/Bento";
import { CalmEmpty } from "./AdminBits";
import type { T } from "@/lib/i18n/core";
import { useT, useFormat } from "@/lib/i18n/client";
import Link from "next/link";
import { useState } from "react";
import { ipLabel } from "@/lib/format";
import { useDirectory } from "@/lib/people";
import { cx, mono, nums, table, tableScroll } from "@/lib/ui";
import { AdminHeader } from "./AdminNav";
import { KpiStrip } from "@/components/ui/KpiStrip";
import { ListIcon, LockIcon, ShieldIcon, UsersIcon } from "@/components/app/icons";
import { Collapse } from "@/components/ui/Collapse";

export interface SignIn {
  at: string;
  type: string;
  userId: string;
  email: string;
  ip: string | null;
  error: string | null;
}

const TYPE = (tx: T): Record<string, { label: string; tone: string }> => ({
  LOGIN: { label: tx("admin.securityadmin.dang_nhap"), tone: "text-ink" },
  LOGIN_ERROR: { label: tx("admin.securityadmin.dang_nhap_that_bai"), tone: "text-block" },
  LOGOUT: { label: tx("admin.securityadmin.dang_xuat"), tone: "text-ink-2" },
  UPDATE_PASSWORD: { label: tx("admin.securityadmin.doi_mat_khau"), tone: "text-ink" },
  RESET_PASSWORD: { label: tx("admin.securityadmin.dat_lai_mat_khau"), tone: "text-ink" },
});
const ERROR = (tx: T): Record<string, string> => ({
  invalid_user_credentials: tx("admin.securityadmin.sai_mat_khau"),
  invalid_totp: tx("admin.securityadmin.sai_ma_xac_minh"),
  user_temporarily_disabled: tx("admin.securityadmin.tai_khoan_tam_khoa"),
  user_not_found: tx("admin.securityadmin.khong_co_tai_khoan"),
  user_disabled: tx("admin.securityadmin.tai_khoan_bi_vo"),
});

/** Security header: the numbers that matter and, folded away, the policies in force. */
export function SecurityAdmin({ summary }: { summary: { logins24h: number; failures24h: number; activeUsers7d: number } }) {
  const tx = useT();
  return (
    <>
      <AdminHeader title={tx("admin.securityadmin.bao_mat")} />
      <KpiStrip
        label={tx("admin.securityadmin.bao_mat")}
        items={[
          { label: tx("admin.securityadmin.luot_dang_nhap_24"), icon: <ShieldIcon />, hue: "blue" as const, value: summary.logins24h },
          { label: tx("admin.securityadmin.dang_nhap_that_bai_2"), icon: <LockIcon />, value: summary.failures24h, tone: summary.failures24h > 10 ? "bad" : "default" },
          { label: tx("admin.securityadmin.nguoi_dung_hoat_dong"), icon: <UsersIcon />, hue: "green" as const, value: summary.activeUsers7d },
        ]}
      />
      <Collapse id="policies" title={tx("admin.securityadmin.chinh_sach_dang_ap")} className="mt-6">
        <ul className="m-0 grid list-disc gap-1.5 pl-5 text-sm">
          <li>{tx("admin.securityadmin.mat_khau_it_nhat")}</li>
          <li>{tx("admin.securityadmin.sai_mat_khau_10")}</li>
          <li>{tx("admin.securityadmin.doi_hoac_dat_lai")}</li>
          <li>{tx("admin.securityadmin.lien_ket_dat_lai")}</li>
          <li>{tx("admin.securityadmin.mat_may")}</li>
        </ul>
      </Collapse>
    </>
  );
}

const LOG_ROWS = 10;

/** The sign-in log (newest first): ten rows, the rest on request. */
export function SignInLog({ signIns, failedOnly }: { signIns: SignIn[]; failedOnly: boolean }) {
  const { dayLabel, time } = useFormat();
  const tx = useT();
  const dir = useDirectory();
  const [all, setAll] = useState(false);
  const rows = all ? signIns : signIns.slice(0, LOG_ROWS);
  return (
    <>
      <section className="mt-10" aria-labelledby="log-h">
        <div className="mb-2 flex items-center gap-3">
          <h2 id="log-h" className="flex min-w-0 flex-1 items-center gap-3 text-sm/6 font-semibold tracking-[-0.01em]">
            <IconTile tone="sky">
              <ListIcon />
            </IconTile>
            {tx("admin.securityadmin.nhat_ky_dang_nhap")}
          </h2>
          <nav className="bg-hover flex gap-0.5 rounded-full p-0.5 text-sm" aria-label={tx("admin.securityadmin.loc_nhat_ky")}>
            <Link
              href="/admin/workspace/security"
              aria-current={!failedOnly ? "page" : undefined}
              className={cx("rounded-md px-3 py-1 no-underline", !failedOnly ? "bg-surface text-ink shadow-raised font-medium" : "text-ink-2")}
            >
              {tx("admin.securityadmin.tat_ca")}
            </Link>
            <Link
              href="/admin/workspace/security?failed=1"
              aria-current={failedOnly ? "page" : undefined}
              className={cx("rounded-md px-3 py-1 no-underline", failedOnly ? "bg-surface text-ink shadow-raised font-medium" : "text-ink-2")}
            >
              {tx("admin.securityadmin.chi_that_bai")}
            </Link>
          </nav>
        </div>
        {signIns.length === 0 ? (
          <CalmEmpty title={tx("admin.securityadmin.chua_co_luot_dang")} />
        ) : (
          <div className="bg-surface shadow-card overflow-x-auto rounded-xl">
            <table className={cx(table, tableScroll)}>
              <thead>
                <tr>
                  <th className="max-sm:hidden">{tx("admin.securityadmin.thoi_gian")}</th>
                  <th>{tx("admin.securityadmin.nguoi")}</th>
                  <th>{tx("admin.securityadmin.su_kien")}</th>
                  <th className="max-md:hidden">{tx("admin.securityadmin.dia_chi_ip")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s, i) => (
                  <tr key={i}>
                    <td className="whitespace-nowrap max-sm:hidden">
                      {dayLabel(s.at)} <span className={nums}>{time(s.at)}</span>
                    </td>
                    {/* Phones: two columns (who, what); the time and address go under the name instead of off-screen. */}
                    <td className="max-sm:!whitespace-normal">
                      <span className="block font-medium">{dir.name(s.userId)}</span>
                      <span className="text-ink-2 block break-all text-xs">{s.email}</span>
                      <span className="text-ink-2 block text-xs sm:hidden">
                        {dayLabel(s.at)} <span className={nums}>{time(s.at)}</span>
                        {ipLabel(s.ip, "") ? ` · ${ipLabel(s.ip, "")}` : ""}
                      </span>
                    </td>
                    <td className={cx(TYPE(tx)[s.type]?.tone, "max-sm:!whitespace-normal")}>
                      {TYPE(tx)[s.type]?.label ?? s.type}
                      {s.error ? <span className="text-ink-2 block text-xs">{ERROR(tx)[s.error] ?? s.error}</span> : null}
                    </td>
                    <td className={cx(ipLabel(s.ip, "") ? mono : "text-ink-2", "text-sm max-md:hidden")}>{ipLabel(s.ip, tx("common.localMachine"))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {signIns.length > LOG_ROWS ? (
              <button type="button" onClick={() => setAll(!all)} className="text-ink-2 hover:text-ink border-hairline w-full border-t py-2.5 text-sm font-medium">
                {all ? tx("ui.showLess") : `${tx("ui.showAll")} (${signIns.length})`}
              </button>
            ) : null}
          </div>
        )}
      </section>
    </>
  );
}
