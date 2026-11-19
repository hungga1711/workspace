"use client";

import { useState } from "react";
import { Avatar, AvatarStack } from "@/lib/people";
import { btn, btnGhost, btnPrimary, btnSm, control, cx, empty, iconBtn, input, list, note, row, rowSub, rowTitle, skeleton } from "@/lib/ui";
import { BlockedTag, Field, Label, PageHead, PriorityTag, StatusPill } from "@/components/ui/bits";
import { Modal } from "@/components/ui/Modal";
import { Drawer } from "@/components/ui/Drawer";
import { Menu } from "@/components/ui/Menu";
import { Tabs } from "@/components/ui/Tabs";
import { Panel } from "@/components/home/Panel";
import { KpiStrip } from "@/components/ui/KpiStrip";
import { Bars, Donut, Meter, StackBar } from "@/components/ui/charts";
import { EmptyState } from "@/components/ui/EmptyState";
import { InfoTip } from "@/components/ui/InfoTip";
import { Collapse } from "@/components/ui/Collapse";
import { useToast } from "@/components/ui/Toast";
import { PropertyList, PropertyRow, propertyValue } from "@/components/ui/PropertyRow";
import { IconSwitch, Toolbar } from "@/components/ui/Toolbar";
import { BoardIcon, GanttIcon, ListIcon } from "@/components/app/icons";
import { BellIcon, CheckCircleIcon, PencilIcon, PlusIcon, SearchIcon, TrashIcon } from "@/components/app/icons";
import { PageHeader } from "@/components/ui/PageHeader";
import { Segmented } from "@/components/ui/Segmented";
import { Picker } from "@/components/ui/Picker";
import { Checkbox } from "@/components/ui/Checkbox";
import { DateField } from "@/components/ui/DateField";
import { AvatarFace } from "@/lib/people";
import { BrandMark } from "@/components/ui/BrandMark";
import { formatMoney } from "@/lib/money";
import { AttendanceHistory } from "@/components/me/AttendanceHistory";
import { addDays } from "@/components/me/attendanceGrid";

/**
 * The "Neutral" component set on one page (DESIGN.md), for reviewing the system as a whole.
 * Not linked from navigation; open /app/ui-kit.
 */
// A made-up year of weekdays for the attendance grid: varied hours, a few late mornings and two forgotten check-outs.
const SAMPLE_TODAY = "2026-10-27";
const SAMPLE_ATTENDANCE = Array.from({ length: 300 }, (_, i) => addDays(SAMPLE_TODAY, -i))
  .filter((d, i) => new Date(`${d}T00:00:00Z`).getUTCDay() % 6 !== 0 && i % 11 !== 3)
  .map((day, i) => {
    const h = 3 + ((i * 7) % 8);
    const checkIn = `${day}T01:${String((i * 13) % 60).padStart(2, "0")}:00Z`;
    return { day, checkIn, checkOut: i === 5 || i === 60 ? null : new Date(Date.parse(checkIn) + h * 3600_000).toISOString(), lateMinutes: i % 9 === 0 ? 12 : 0 };
  });

export default function UiKit() {
  const [modal, setModal] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [on, setOn] = useState(true);
  const [view, setView] = useState<"board" | "list" | "gantt">("board");
  const [days, setDays] = useState("30");
  const [who, setWho] = useState("p1");
  const [checked, setChecked] = useState(true);
  const [due, setDue] = useState("2026-10-30T17:00");
  const toast = useToast();
  const swatches = [
    ["ground", "bg-ground"],
    ["surface", "bg-surface"],
    ["hover", "bg-hover"],
    ["hairline", "bg-hairline"],
    ["brand-wash", "bg-brand-wash"],
    ["brand", "bg-brand"],
    ["brand-text", "bg-brand-text"],
    ["signal-wash", "bg-signal-wash"],
    ["signal", "bg-signal"],
    ["ink", "bg-ink"],
    ["ok", "bg-ok"],
    ["warn", "bg-warn"],
    ["block", "bg-block"],
  ] as const;
  const section = "grid gap-3";
  const h2 = "text-sm font-semibold text-ink-2";
  return (
    <div className="grid gap-10 pb-10">
      <PageHead title="UI kit · Neutral" />

      <section className={section}>
        <h2 className={h2}>Lịch sử chấm công</h2>
        <AttendanceHistory days={SAMPLE_ATTENDANCE} today={SAMPLE_TODAY} leaves={[{ startDate: addDays(SAMPLE_TODAY, -40), endDate: addDays(SAMPLE_TODAY, -38) }]} />
      </section>

      <section className={section}>
        <h2 className={h2}>Đầu trang, tab, lọc</h2>
        <div className="border-hairline bg-surface rounded-lg border p-5">
          <PageHeader
            title="Yêu cầu"
            count={4}
            actions={
              <button type="button" className={btnPrimary}>
                <PlusIcon />
                Gửi yêu cầu
              </button>
            }
            tabs={
              <Tabs
                active="mine"
                tabs={[
                  { key: "mine", label: "Cần tôi duyệt", href: "#", count: 4 },
                  { key: "sent", label: "Tôi đã gửi", href: "#" },
                  { key: "all", label: "Tất cả", href: "#" },
                ]}
              />
            }
            toolbar={
              <Segmented
                label="Khoảng thời gian"
                size="sm"
                value={days}
                onChange={setDays}
                options={[
                  { value: "7", label: "7 ngày" },
                  { value: "30", label: "30 ngày" },
                  { value: "90", label: "90 ngày" },
                ]}
              />
            }
          />
          <div className="flex flex-wrap items-center gap-3">
            <Segmented
              label="Kiểu xem"
              value={view}
              onChange={setView}
              options={[
                { value: "board", label: "Bảng", icon: <BoardIcon />, iconOnly: true },
                { value: "list", label: "Danh sách", icon: <ListIcon />, iconOnly: true },
                { value: "gantt", label: "Gantt", icon: <GanttIcon />, iconOnly: true },
              ]}
            />
            <Picker
              variant="button"
              prefix="Người làm:"
              label="Người làm"
              value={who}
              onChange={setWho}
              options={[
                { value: "p1", label: "Trần Minh Hưng" },
                { value: "p2", label: "Ngô Mai Linh" },
                { value: "p3", label: "Vũ Hoàng Long" },
              ]}
            />
            <div className="w-56">
              <DateField label="Hạn chót" value={due} onChange={setDue} withTime />
            </div>
            <Checkbox label="Hiện việc đã xong" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <BrandMark className="size-4" />
          <BrandMark className="size-6" />
          <BrandMark className="size-10" />
          <BrandMark variant="plain" className="text-ink-2 size-10" />
          <AvatarFace name="Ngô Mai Linh" size="xs" />
          <AvatarFace name="Ngô Mai Linh" size="sm" />
          <AvatarFace name="Ngô Mai Linh" size="md" />
          <AvatarFace name="Ngô Mai Linh" size="lg" />
          <AvatarFace name="workspace" size="md" system />
          {[165_000_000, 2_100_000_000, 850_000].map((v) => (
            <span key={v} title={formatMoney(v).full} className="text-sm tabular-nums">
              {formatMoney(v).short}
            </span>
          ))}
          <span className="text-sm tabular-nums">{formatMoney(0.1627, "USD").short}</span>
        </div>
      </section>

      <section className={section}>
        <h2 className={h2}>Màu</h2>
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-5 lg:grid-cols-7">
          {swatches.map(([name, cls]) => (
            <div key={name} className="bg-surface shadow-card overflow-hidden rounded-lg">
              <div className={cx("h-12", cls)} />
              <p className="text-ink-2 px-2.5 py-1.5 font-mono text-xs">{name}</p>
            </div>
          ))}
        </div>
      </section>

      <section className={section}>
        <h2 className={h2}>Nút</h2>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={btnPrimary}>
            <PlusIcon className="size-4" />
            Tạo mới
          </button>
          <button type="button" className={btn}>
            Huỷ
          </button>
          <button type="button" className={btnGhost}>
            <PencilIcon className="size-4" />
            Sửa
          </button>
          <button type="button" className={cx(btn, "text-block")}>
            <TrashIcon className="size-4" />
            Xoá
          </button>
          <button type="button" className={btnPrimary} disabled>
            Đang lưu…
          </button>
          <button type="button" className={cx(btnPrimary, btnSm)}>
            Duyệt
          </button>
          <button type="button" className={cx(btn, btnSm)}>
            Từ chối
          </button>
          <button type="button" className={iconBtn} aria-label="Thông báo">
            <BellIcon className="size-5" />
          </button>
        </div>
      </section>

      <section className={section}>
        <h2 className={h2}>Trường nhập</h2>
        <div className="grid max-w-2xl gap-4 sm:grid-cols-2">
          <Field label="Tên dự án" hint="Hiển thị cho cả đội.">
            <input className={input} placeholder="Ví dụ: Ra mắt Q4" />
          </Field>
          <Field label="Email" error="Email chưa đúng định dạng.">
            <input className={input} aria-invalid="true" defaultValue="lan@" />
          </Field>
          <Field label="Ưu tiên">
            <select className={input} defaultValue="medium">
              <option value="high">Cao</option>
              <option value="medium">Trung bình</option>
            </select>
          </Field>
          <label className="relative grid gap-1.5">
            <span className="text-sm font-medium">Tìm</span>
            <SearchIcon className="text-ink-2 pointer-events-none absolute bottom-3 left-3 size-4" />
            <input className={cx(control, "min-h-10 w-full pl-9")} placeholder="Tìm việc…" />
          </label>
          <label className="flex items-center gap-3 text-sm">
            <button
              type="button"
              role="switch"
              aria-checked={on}
              onClick={() => setOn(!on)}
              className={cx("relative h-6 w-10 shrink-0 rounded-full transition-colors", on ? "bg-ink" : "bg-hairline")}
            >
              <span className={cx("bg-surface absolute top-0.5 size-5 rounded-full shadow transition-[left]", on ? "left-[18px]" : "left-0.5")} />
            </button>
            Email tóm tắt mỗi ngày
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" defaultChecked className="size-4 accent-[var(--brand)]" />
            Báo khi có tin nhắn riêng
          </label>
        </div>
      </section>

      <section className={section}>
        <h2 className={h2}>Nhãn và trạng thái</h2>
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill status="todo" />
          <StatusPill status="in_progress" />
          <StatusPill status="review" />
          <StatusPill status="done" />
          <StatusPill status="pending" />
          <StatusPill status="rejected" />
          <PriorityTag priority="urgent" />
          <PriorityTag priority="high" />
          <BlockedTag reason="Chờ hợp đồng" />
          <Label>marketing</Label>
          <AvatarStack ids={["a1", "b2", "c3", "d4", "e5"]} max={4} />
        </div>
      </section>

      <section className={section}>
        <h2 className={h2}>Tab</h2>
        <Tabs
          active="tasks"
          tabs={[
            { key: "overview", label: "Tổng quan", href: "#" },
            { key: "tasks", label: "Việc", href: "#", count: 12 },
            { key: "board", label: "Kanban", href: "#" },
            { key: "approvals", label: "Phê duyệt", href: "#", count: 2 },
          ]}
        />
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <Panel id="kit-panel" title="Cần bạn ngay" count={2} flush action={<a href="#">Xem tất cả</a>}>
          <ul className="divide-hairline m-0 list-none divide-y p-0">
            <li className="bg-signal-wash flex items-center gap-3 px-5 py-3">
              <span className="bg-signal size-2 rounded-full" />
              <span className="flex-1 font-semibold">Duyệt ngân sách Q4</span>
              <button type="button" className={cx(btnPrimary, btnSm)}>
                Duyệt
              </button>
            </li>
            <li className="flex items-center gap-3 px-5 py-3">
              <CheckCircleIcon className="text-ink-2 size-4" />
              <span className="flex-1">Gửi báo cáo tuần</span>
              <button type="button" className={cx(btn, btnSm)}>
                Hoàn thành
              </button>
            </li>
          </ul>
        </Panel>
        <ul className={list}>
          {["Trần Minh Hưng", "Lan Nguyễn", "Minh Phạm"].map((n, i) => (
            <li key={n} className={row}>
              <Avatar id={`p${i}`} name={n} size="md" />
              <span className="min-w-0 flex-1">
                <span className={rowTitle}>{n}</span>
                <span className={rowSub}>Thiết kế · Hà Nội</span>
              </span>
            </li>
          ))}
        </ul>
        <div className={note}>
          <CheckCircleIcon className="text-ok size-4" />
          Đã lưu thay đổi.
        </div>
        <div className={empty}>
          <p className="font-semibold">Chưa có tài liệu</p>
          <p className="text-ink-2">Viết tài liệu đầu tiên cho đội.</p>
        </div>
        <div className="bg-surface shadow-card grid gap-2 rounded-xl p-5">
          <span className={skeleton} />
          <span className={cx(skeleton, "w-4/5")} />
          <span className={cx(skeleton, "w-3/5")} />
        </div>
      </section>

      <section className={section}>
        <h2 className={h2}>Lớp phủ</h2>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={btn} onClick={() => setModal(true)}>
            Mở modal
          </button>
          <button type="button" className={btn} onClick={() => setDrawer(true)}>
            Mở drawer
          </button>
          <Menu
            label="Tuỳ chọn"
            align="left"
            items={[
              { label: "Sửa", icon: <PencilIcon />, onSelect: () => undefined },
              { label: "Xoá", icon: <TrashIcon />, onSelect: () => undefined, danger: true },
            ]}
            trigger={<span className={btn}>Mở menu</span>}
          />
        </div>
      </section>

      <section className={section}>
        <h2 className={h2}>Số liệu, biểu đồ</h2>
        <KpiStrip
          label="Số liệu mẫu"
          items={[
            { label: "Đang làm", value: 37, spark: [3, 5, 4, 8, 6, 9, 7, 10] },
            { label: "Trễ hạn", value: 7, tone: "bad", delta: { value: 2, goodWhen: "down" } },
            { label: "Bị chặn", value: 0 },
            { label: "Xong 7 ngày", value: 13, delta: { value: 4, goodWhen: "up" } },
            { label: "Đúng hạn", value: 82, format: (n) => `${Math.round(n)}%`, info: "Tỉ lệ việc xong trước hạn chót trong 30 ngày." },
          ]}
        />
        <div className="grid gap-4 md:grid-cols-[2fr_1fr]">
          <div className="border-hairline bg-surface rounded-xl border p-4">
            <Bars
              label="Hoàn thành và tạo mới, 8 tuần"
              seriesLabels={["Hoàn thành", "Tạo mới"]}
              data={["21/08", "28/08", "04/09", "11/09", "18/09", "25/09", "02/10", "09/10"].map((l, i) => ({
                label: l,
                value: [4, 6, 5, 9, 7, 11, 8, 13][i]!,
                highlight: i === 7,
              }))}
              compare={[6, 5, 7, 8, 9, 10, 9, 12]}
            />
          </div>
          <div className="border-hairline bg-surface grid place-items-center gap-4 rounded-xl border p-4">
            <Donut
              label="Công cụ AI"
              parts={[
                { label: "ChatGPT", value: 46, tone: "ink" },
                { label: "Claude", value: 28, tone: "tangerine" },
                { label: "Gemini", value: 16, tone: "sky" },
                { label: "Copilot", value: 10, tone: "violet" },
              ]}
              center={<span className="text-lg font-semibold tabular-nums">100</span>}
            />
            <div className="w-full">
              <StackBar
                label="Trạng thái"
                parts={[
                  { label: "Cần làm", value: 18, tone: "muted" },
                  { label: "Đang làm", value: 9, tone: "ink" },
                  { label: "Review", value: 4, tone: "accent" },
                  { label: "Trễ", value: 3, tone: "block" },
                ]}
              />
            </div>
            <div className="w-full">
              <Meter label="Mục tiêu quý" value={42} marker={55} />
            </div>
          </div>
        </div>
      </section>

      <section className={section}>
        <h2 className={h2}>Thanh công cụ, thuộc tính, gập, gợi ý</h2>
        <Toolbar
          label="Mẫu"
          left={
            <>
              <span className="text-2xl font-semibold tracking-tight">Việc</span>
              <InfoTip text="Giải thích ngắn nằm trong ⓘ thay vì một đoạn văn trên trang." />
            </>
          }
          right={
            <>
              <IconSwitch
                label="Kiểu xem"
                value={view}
                onChange={setView}
                options={[
                  { value: "board", label: "Bảng", icon: <BoardIcon /> },
                  { value: "list", label: "Danh sách", icon: <ListIcon /> },
                  { value: "gantt", label: "Gantt", icon: <GanttIcon /> },
                ]}
              />
              <button type="button" className={btnPrimary} onClick={() => toast({ message: "Đã duyệt đề nghị", undo: () => undefined })}>
                Thử toast
              </button>
            </>
          }
        />
        <div className="grid gap-4 md:grid-cols-2">
          <div className="border-hairline bg-surface rounded-xl border p-4">
            <PropertyList label="Thuộc tính">
              <PropertyRow label="Trạng thái">
                <button type="button" className={propertyValue}>
                  <span className="bg-ink size-2 rounded-full" aria-hidden="true" />
                  Đang làm
                </button>
              </PropertyRow>
              <PropertyRow label="Người làm">
                <button type="button" className={propertyValue}>
                  <Avatar id="u-1" name="Trần Minh Hưng" size="xs" />
                  Trần Minh Hưng
                </button>
              </PropertyRow>
              <PropertyRow label="Hạn chót">
                <button type="button" className={propertyValue}>
                  24/10
                </button>
              </PropertyRow>
            </PropertyList>
          </div>
          <Collapse id="ui-kit-collapse" title="Phòng ban" meta="5 phòng ban">
            <p className="text-ink-2 m-0 text-sm">Chi tiết gập lại để trang ngắn.</p>
          </Collapse>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          <EmptyState kind="done" title="Xong hết rồi" compact />
          <EmptyState kind="none" title="Chưa có tài liệu" compact />
          <EmptyState kind="filtered" title="Không có kết quả" compact />
        </div>
      </section>

      {modal ? (
        <Modal
          title="Tạo dự án"
          onClose={() => setModal(false)}
          footer={
            <>
              <button type="button" className={btn} onClick={() => setModal(false)}>
                Huỷ
              </button>
              <button type="button" className={btnPrimary} onClick={() => setModal(false)}>
                Tạo dự án
              </button>
            </>
          }
        >
          <div className="grid grid-cols-1 gap-4">
            <Field label="Tên dự án">
              <input className={input} autoFocus />
            </Field>
            <Field label="Mô tả">
              <textarea className={cx(input, "min-h-24 py-2")} />
            </Field>
          </div>
        </Modal>
      ) : null}
      {drawer ? (
        <Drawer title="Chi tiết việc" onClose={() => setDrawer(false)} padded>
          <p className="text-ink-2">Nội dung drawer.</p>
        </Drawer>
      ) : null}
    </div>
  );
}
