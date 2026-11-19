import type { Locale } from "@/lib/i18n/config";

/** Page templates: the structures teams write most, in the writer's language. */
const VI = [
  { key: "blank", html: "" },
  {
    key: "meeting",
    html:
      `<h2>Thông tin</h2><table><tbody><tr><th><p>Ngày</p></th><td><p></p></td></tr><tr><th><p>Người tham dự</p></th><td><p>@</p></td></tr></tbody></table>` +
      `<h2>Mục tiêu</h2><ul><li><p></p></li></ul><h2>Nội dung thảo luận</h2><table><tbody><tr><th><p>Chủ đề</p></th><th><p>Người trình bày</p></th><th><p>Ghi chú</p></th></tr><tr><td><p></p></td><td><p></p></td><td><p></p></td></tr></tbody></table>` +
      `<h2>Quyết định</h2><div data-callout="success"><p></p></div><h2>Việc cần làm</h2><ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>@ … trước ngày …</p></li></ul>`,
  },
  {
    key: "prd",
    html:
      `<table><tbody><tr><th><p>Người phụ trách</p></th><td><p>@</p></td></tr><tr><th><p>Trạng thái</p></th><td><p>Nháp</p></td></tr><tr><th><p>Ngày ra mắt dự kiến</p></th><td><p></p></td></tr></tbody></table>` +
      `<h2>Vấn đề</h2><p>Người dùng nào đang gặp khó khăn gì, và vì sao nó đáng giải quyết bây giờ?</p><h2>Mục tiêu và chỉ số</h2><ul><li><p></p></li></ul>` +
      `<h2>Yêu cầu</h2><table><tbody><tr><th><p>#</p></th><th><p>Câu chuyện người dùng</p></th><th><p>Mức ưu tiên</p></th><th><p>Ghi chú</p></th></tr><tr><td><p>1</p></td><td><p>Là …, tôi muốn … để …</p></td><td><p>Phải có</p></td><td><p></p></td></tr></tbody></table>` +
      `<h2>Thiết kế</h2><p></p><h2>Câu hỏi còn mở</h2><ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p></p></li></ul><h2>Ngoài phạm vi</h2><ul><li><p></p></li></ul>`,
  },
  {
    key: "howto",
    html: `<div data-callout="info"><p>Hướng dẫn này giúp bạn … trong khoảng … phút.</p></div><h2>Chuẩn bị</h2><ul><li><p></p></li></ul><h2>Các bước</h2><ol><li><p></p></li><li><p></p></li><li><p></p></li></ol><h2>Lỗi thường gặp</h2><table><tbody><tr><th><p>Hiện tượng</p></th><th><p>Cách xử lý</p></th></tr><tr><td><p></p></td><td><p></p></td></tr></tbody></table>`,
  },
  {
    key: "retro",
    html: `<h2>Điều làm tốt</h2><ul><li><p></p></li></ul><h2>Điều cần cải thiện</h2><ul><li><p></p></li></ul><h2>Ý tưởng</h2><ul><li><p></p></li></ul><h2>Hành động</h2><ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>@ …</p></li></ul>`,
  },
  {
    key: "plan",
    html:
      `<h2>Bối cảnh</h2><p></p><h2>Mục tiêu</h2><ul><li><p></p></li></ul><h2>Phạm vi</h2><p></p>` +
      `<h2>Mốc thời gian</h2><table><tbody><tr><th><p>Mốc</p></th><th><p>Ngày</p></th><th><p>Người phụ trách</p></th><th><p>Trạng thái</p></th></tr><tr><td><p></p></td><td><p></p></td><td><p>@</p></td><td><p>Chưa bắt đầu</p></td></tr></tbody></table>` +
      `<h2>Rủi ro</h2><div data-callout="warning"><p></p></div><h2>Ngân sách và nguồn lực</h2><p></p>`,
  },
  {
    key: "weekly",
    html: `<h2>Tóm tắt tuần</h2><div data-callout="info"><p></p></div><h2>Đã xong</h2><ul><li><p></p></li></ul><h2>Đang làm</h2><ul><li><p></p></li></ul><h2>Bị chặn / cần hỗ trợ</h2><div data-callout="warning"><p></p></div><h2>Kế hoạch tuần tới</h2><ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p></p></li></ul>`,
  },
] as const;
const EN = [
  { key: "blank", html: "" },
  {
    key: "meeting",
    html:
      `<h2>Details</h2><table><tbody><tr><th><p>Date</p></th><td><p></p></td></tr><tr><th><p>Attendees</p></th><td><p>@</p></td></tr></tbody></table>` +
      `<h2>Goals</h2><ul><li><p></p></li></ul><h2>Discussion</h2><table><tbody><tr><th><p>Topic</p></th><th><p>Presenter</p></th><th><p>Notes</p></th></tr><tr><td><p></p></td><td><p></p></td><td><p></p></td></tr></tbody></table>` +
      `<h2>Decisions</h2><div data-callout="success"><p></p></div><h2>Action items</h2><ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>@ … by …</p></li></ul>`,
  },
  {
    key: "prd",
    html:
      `<table><tbody><tr><th><p>Owner</p></th><td><p>@</p></td></tr><tr><th><p>Status</p></th><td><p>Draft</p></td></tr><tr><th><p>Target launch date</p></th><td><p></p></td></tr></tbody></table>` +
      `<h2>Problem</h2><p>Which users struggle with what, and why is it worth solving now?</p><h2>Goals and metrics</h2><ul><li><p></p></li></ul>` +
      `<h2>Requirements</h2><table><tbody><tr><th><p>#</p></th><th><p>User story</p></th><th><p>Priority</p></th><th><p>Notes</p></th></tr><tr><td><p>1</p></td><td><p>As a …, I want … so that …</p></td><td><p>Must have</p></td><td><p></p></td></tr></tbody></table>` +
      `<h2>Design</h2><p></p><h2>Open questions</h2><ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p></p></li></ul><h2>Out of scope</h2><ul><li><p></p></li></ul>`,
  },
  {
    key: "howto",
    html: `<div data-callout="info"><p>This guide helps you … in about … minutes.</p></div><h2>Before you start</h2><ul><li><p></p></li></ul><h2>Steps</h2><ol><li><p></p></li><li><p></p></li><li><p></p></li></ol><h2>Common problems</h2><table><tbody><tr><th><p>Symptom</p></th><th><p>Fix</p></th></tr><tr><td><p></p></td><td><p></p></td></tr></tbody></table>`,
  },
  {
    key: "retro",
    html: `<h2>What went well</h2><ul><li><p></p></li></ul><h2>What to improve</h2><ul><li><p></p></li></ul><h2>Ideas</h2><ul><li><p></p></li></ul><h2>Actions</h2><ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>@ …</p></li></ul>`,
  },
  {
    key: "plan",
    html:
      `<h2>Background</h2><p></p><h2>Goals</h2><ul><li><p></p></li></ul><h2>Scope</h2><p></p>` +
      `<h2>Timeline</h2><table><tbody><tr><th><p>Milestone</p></th><th><p>Date</p></th><th><p>Owner</p></th><th><p>Status</p></th></tr><tr><td><p></p></td><td><p></p></td><td><p>@</p></td><td><p>Not started</p></td></tr></tbody></table>` +
      `<h2>Risks</h2><div data-callout="warning"><p></p></div><h2>Budget and resources</h2><p></p>`,
  },
  {
    key: "weekly",
    html: `<h2>Week in brief</h2><div data-callout="info"><p></p></div><h2>Done</h2><ul><li><p></p></li></ul><h2>In progress</h2><ul><li><p></p></li></ul><h2>Blocked / needs help</h2><div data-callout="warning"><p></p></div><h2>Next week</h2><ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p></p></li></ul>`,
  },
] as const;

export const TEMPLATE_KEYS = VI.map((x) => x.key);
export type TemplateKey = (typeof VI)[number]["key"];

export function templateHtml(key: TemplateKey, locale: Locale): string {
  const set: readonly { key: string; html: string }[] = locale === "vi" ? VI : EN;
  return set.find((x) => x.key === key)?.html ?? "";
}
