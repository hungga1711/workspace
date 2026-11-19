import type { PoolClient } from "pg";

/**
 * Text the home module writes for a person (inbox, Home items, "while you were away", push, email digest),
 * in that person's UI language. The web app records the language in user_prefs.locale whenever it calls
 * Home (x-locale header), so text created later follows the language the person last used.
 */
export type Locale = "vi" | "en" | "zh" | "es";
export const isLocale = (v: unknown): v is Locale => v === "vi" || v === "en" || v === "zh" || v === "es";

/**
 * A due time kept as data ({ at, tz }) is written in the reader's language when shown; older rows kept the text as it
 * was formatted then (a string), which is shown as is.
 */
export interface DueAt {
  at: string;
  tz: string;
}
const TAG: Record<Locale, string> = { vi: "vi-VN", en: "en-US", zh: "zh-CN", es: "es-ES" };
export const dueAt = (at: Date | string, tz: string): DueAt => ({ at: new Date(at).toISOString(), tz });
function fmtDue(when: unknown, lang: Locale): string {
  if (typeof when === "string") return when;
  const w = when as Partial<DueAt> | null;
  if (!w?.at) return "";
  try {
    return new Intl.DateTimeFormat(TAG[lang], { timeZone: w.tz || "UTC", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(w.at));
  } catch {
    return new Date(w.at).toISOString().slice(0, 16).replace("T", " ");
  }
}

const ddmm = (d: unknown) => (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d.slice(8, 10)}/${d.slice(5, 7)}` : String(d));

// Every source the extension and imports report (ai/insight.ts SOURCES); "company" and "other" differ by language.
const AI_SOURCE: Record<string, string> = {
  chatgpt: "ChatGPT",
  claude: "Claude",
  gemini: "Gemini",
  copilot: "Copilot",
  perplexity: "Perplexity",
  deepseek: "DeepSeek",
  grok: "Grok",
  meta: "Meta AI",
  poe: "Poe",
  qwen: "Qwen",
  kimi: "Kimi",
  doubao: "Doubao",
  you: "You.com",
  huggingchat: "HuggingChat",
  zai: "Z.ai",
  duckai: "Duck.ai",
};
const AI_SOURCE_VI: Record<string, string> = { ...AI_SOURCE, company: "Trợ lý AI công ty", import: "dữ liệu nhập từ nhà cung cấp", other: "một công cụ AI khác" };
const AI_SOURCE_EN: Record<string, string> = { ...AI_SOURCE, company: "the company assistant", import: "imported provider data", other: "another AI tool" };
const AI_KIND_VI: Record<string, string> = {
  personal_id: "số CCCD/hộ chiếu",
  card: "số thẻ",
  secret: "mật khẩu/khoá API",
  contacts: "danh sách liên hệ",
  bank_account: "số tài khoản",
  keyword: "từ khoá công ty đặt",
};
const AI_KIND_EN: Record<string, string> = {
  personal_id: "ID number",
  card: "card number",
  secret: "password/API key",
  contacts: "contact list",
  bank_account: "bank account",
  keyword: "company keyword",
};

const vi = {
  lang: "vi" as Locale,
  push: {
    "task.assigned": "Bạn vừa được giao một việc",
    "approval.requested": "Có yêu cầu cần bạn duyệt",
    mention: "Bạn được nhắc tên trong một cuộc trò chuyện",
    "leave.requested": "Có đơn nghỉ phép cần bạn duyệt",
    "decision.proposed": "Có quyết định cần bạn chốt",
    "task.mention": "Bạn được nhắc tên trong một việc",
    "task.agent_ask": "AI cần bạn trả lời vài câu hỏi",
    "task.agent_approval": "Có kết quả của AI cần bạn duyệt",
  } as Record<string, string>,
  pushDefault: "Có việc cần bạn",
  pushDm: "Bạn có tin nhắn riêng mới",
  pushChannel: (name: string) => (name ? `Tin nhắn mới trong #${name}` : "Tin nhắn mới trong kênh"),
  pushOpen: "Mở workspace để xem",
  taskAssigned: (t: string) => `Bạn được giao: ${t}`,
  taskByAi: (t: string) => `AI đã tạo việc: ${t}`,
  taskFromChat: (t: string) => `Việc mới từ cuộc trò chuyện: ${t}`,
  done: (t: string) => `Đã xong: ${t}`,
  blocked: (t: string) => `${t} đang bị chặn`,
  commented: (code: string, t: string) => `Bình luận mới ở ${code}: ${t}`,
  taskMention: (code: string) => `Bạn được nhắc tên trong ${code}`,
  approvalOnBehalf: "Duyệt thay người vắng mặt",
  approvalWaiting: "Chờ bạn duyệt",
  approvalNeeded: (t: string) => `Cần duyệt: ${t}`,
  approvalDecided: (approved: boolean, t: string) => `${approved ? "Đã duyệt" : "Bị từ chối"}: ${t}`,
  approvalCommented: (t: string) => `Trao đổi mới về yêu cầu: ${t}`,
  message: "Tin nhắn",
  mentioned: "Bạn được nhắc tên",
  dmWaiting: "Đang chờ bạn trả lời",
  meeting: (rescheduled: boolean, recurrence: string | null, t: string) =>
    `${rescheduled ? "Cuộc họp thay đổi" : recurrence !== null ? `Lời mời họp ${({ daily: "hằng ngày", weekdays: "các ngày trong tuần", weekly: "hằng tuần", biweekly: "2 tuần một lần", monthly: "hằng tháng" } as Record<string, string>)[recurrence] ?? "định kỳ"}` : "Lời mời họp"}: ${t}`,
  leaveItem: (name: string, days: number) => `Nghỉ phép: ${name} (${days} ngày)`,
  leaveRange: (a: unknown, b: unknown) => `${ddmm(a)} → ${ddmm(b)}`,
  leaveRequested: (name: string, days: number) => `${name} xin nghỉ ${days} ngày`,
  leaveDecided: (approved: boolean): string => (approved ? "Đơn nghỉ phép đã được duyệt" : "Đơn nghỉ phép bị từ chối"),
  aiFlagged: (kinds: string[], source: string): string =>
    `Dữ liệu nhạy cảm (${kinds.map((k) => AI_KIND_VI[k] ?? k).join(", ")}) vừa được gửi vào ${AI_SOURCE_VI[source] ?? source}`,
  aiFlaggedBody: "Xem ai đã gửi và gửi ở đâu trong AI › Áp dụng AI › Mức sử dụng. Thông báo này không kèm nội dung đã gửi.",
  aiPolicy: "Công ty vừa đổi chính sách ghi nhận việc dùng AI",
  announcement: (t: string) => `Thông báo mới: ${t}`,
  leaveReminder: (name: string, days: number) => `Nhắc: đơn nghỉ ${days} ngày của ${name} vẫn chờ bạn duyệt`,
  aiExtension: "Công ty đề nghị bạn cài tiện ích workspace AI",
  aiExtensionBody: "Chỉ mất khoảng 1 phút: tải tiện ích rồi dán mã kết nối lấy ở Của tôi › AI. Bạn luôn xem được mọi thứ tiện ích ghi lại.",
  aiPolicyBody: (detail: string, answers: boolean, days: number): string =>
    `Quản lý được xem: ${detail === "topic" ? "chỉ chủ đề" : detail === "summary" ? "chủ đề và tóm tắt" : "quản trị viên đọc được toàn bộ nội dung"}; ${answers ? "có" : "không"} lưu câu trả lời của AI; dữ liệu tự xoá sau ${days} ngày. Chi tiết ở Của tôi › AI.`,
  quota: (pct: number): string => (pct >= 100 ? "Đã dùng hết hạn mức AI tháng này" : `Đã dùng ${pct}% hạn mức AI tháng này`),
  quotaBody: "Hạn mức mới bắt đầu từ ngày 1 tháng sau; cần dùng thêm thì nhờ quản trị viên nâng hạn mức.",
  decisionWaiting: "Chờ bạn chốt",
  decisionNeeded: (t: string) => `Cần bạn chốt: ${t}`,
  decided: (t: string) => `Đã chốt: ${t}`,
  docCreated: (t: string) => `Tài liệu mới: ${t}`,
  docUpdated: (t: string) => `${t} vừa được cập nhật`,
  docCommented: (t: string) => `Bình luận mới ở trang ${t}`,
  agentAnswered: (agent: string, prompt: string) => `${agent} đã trả lời: ${prompt}`,
  dueSoon: (when: unknown, t: string) => `Sắp đến hạn (${fmtDue(when, "vi")}): ${t}`,
  overdue: (when: unknown, t: string) => `Đã quá hạn (${fmtDue(when, "vi")}): ${t}`,
  dueSoonPush: "Một việc của bạn sắp đến hạn",
  reminder: (t: string) => `Nhắc bạn: ${t}`,
  reminderPush: "Bạn có một lời nhắc",
  agentAsked: (code: string, n: number) => `AI đang hỏi ở ${code}: ${n} câu hỏi cần bạn trả lời`,
  agentApproval: (code: string, step: string) => `Kết quả của AI ở ${code} chờ bạn duyệt: ${step}`,
  quickApprove: "Duyệt",
  quickOpen: "Mở",
  quickDone: "Đã ghi nhận. AI tiếp tục làm.",
  today: "hôm nay",
  tomorrow: "ngày mai",
  dayTitle: "Hôm nay của bạn",
  dayCounts: (tasks: number, meetings: number, approvals: number) => `${tasks} việc · ${meetings} cuộc họp · ${approvals} phê duyệt`,
  briefTitle: "Tóm tắt hôm nay",
  digest: {
    kind: { approval: "Phê duyệt", decision: "Quyết định chờ chốt", blocker: "Việc bị chặn", mention: "Nhắc tên bạn", dm: "Tin nhắn chờ trả lời", task: "Việc" } as Record<
      string,
      string
    >,
    body: (n: number, meetings: number) => `${n} việc cần bạn xử lý${meetings ? ` · ${meetings} cuộc họp hôm nay` : ""}.`,
    heading: "Việc cần bạn hôm nay",
    open: "Mở workspace",
    subject: (n: number, meetings: number) => `Hôm nay: ${n} việc cần bạn xử lý${meetings ? `, ${meetings} cuộc họp` : ""}`,
    teamHeading: "Đội của bạn tuần này",
    team: (overdue: number, stale: number, blocked: number, done: number, risk = 0) =>
      `${overdue} việc trễ hạn · ${risk ? `${risk} việc có nguy cơ trễ · ` : ""}${stale} việc lâu chưa cập nhật · ${blocked} việc bị chặn · ${done} việc xong trong 7 ngày.`,
    teamWhy: { late: "trễ hạn", risk: "có nguy cơ trễ", stale: "lâu chưa cập nhật", blocked: "bị chặn" } as Record<string, string>,
    teamSubject: (overdue: number) => (overdue ? `Đầu tuần: đội có ${overdue} việc trễ hạn` : "Đầu tuần: đội của bạn đang đúng tiến độ"),
    teamOpen: "Xem tiến độ của đội",
    myWeek: (done: number, doing: number, late: number) => `Tuần qua bạn đã xong ${done} việc · ${doing} việc đang làm${late ? ` · ${late} việc trễ hạn` : ""}.`,
  },
};
export type Texts = typeof vi;

/** "1 task", "2 tasks". */
const n = (k: number, word: string) => `${k} ${word}${k === 1 ? "" : "s"}`;

const en: Texts = {
  lang: "en",
  push: {
    "task.assigned": "You were assigned a task",
    "approval.requested": "A request needs your approval",
    mention: "You were mentioned in a conversation",
    "leave.requested": "A leave request needs your approval",
    "decision.proposed": "A decision is waiting for you",
    "task.mention": "You were mentioned in a task",
    "task.agent_ask": "The AI needs a few answers from you",
    "task.agent_approval": "An AI result is waiting for your approval",
  },
  pushDefault: "Something needs your attention",
  pushDm: "You have a new direct message",
  pushChannel: (name: string) => (name ? `New messages in #${name}` : "New messages in a channel"),
  pushOpen: "Open workspace to see it",
  taskAssigned: (t) => `Assigned to you: ${t}`,
  taskByAi: (t) => `AI created a task: ${t}`,
  taskFromChat: (t) => `New task from a conversation: ${t}`,
  done: (t) => `Done: ${t}`,
  blocked: (t) => `${t} is blocked`,
  commented: (code, t) => `New comment on ${code}: ${t}`,
  taskMention: (code) => `You were mentioned in ${code}`,
  approvalOnBehalf: "Approving for someone who's away",
  approvalWaiting: "Awaiting your approval",
  approvalNeeded: (t) => `Approval needed: ${t}`,
  approvalDecided: (approved, t) => `${approved ? "Approved" : "Declined"}: ${t}`,
  approvalCommented: (t) => `New message on a request: ${t}`,
  message: "Message",
  mentioned: "You were mentioned",
  dmWaiting: "Waiting for your reply",
  meeting: (rescheduled, recurrence, t) =>
    `${rescheduled ? "Meeting changed" : recurrence !== null ? `${({ daily: "Daily", weekdays: "Weekday", weekly: "Weekly", biweekly: "Fortnightly", monthly: "Monthly" } as Record<string, string>)[recurrence] ?? "Recurring"} meeting invitation` : "Meeting invitation"}: ${t}`,
  leaveItem: (name, days) => `Leave: ${name} (${days} ${days === 1 ? "day" : "days"})`,
  leaveRange: (a, b) => `${ddmm(a)} → ${ddmm(b)}`,
  leaveRequested: (name, days) => `${name} requested ${days} ${days === 1 ? "day" : "days"} off`,
  leaveDecided: (approved) => (approved ? "Your leave request was approved" : "Your leave request was declined"),
  aiFlagged: (kinds: string[], source: string): string => `Sensitive data (${kinds.map((k) => AI_KIND_EN[k] ?? k).join(", ")}) was just sent to ${AI_SOURCE_EN[source] ?? source}`,
  aiFlaggedBody: "See who sent it and where in AI › AI adoption › Usage. This notification does not include what was sent.",
  aiPolicy: "Your company changed how AI use is recorded",
  announcement: (t: string) => `New announcement: ${t}`,
  leaveReminder: (name: string, days: number) => `Reminder: ${name}'s ${days}-day leave request is still waiting for you`,
  aiExtension: "Your company asks you to install the workspace AI extension",
  aiExtensionBody: "It takes about a minute: download it and paste the connection code from Me › AI. You can always see everything it records.",
  aiPolicyBody: (detail, answers, days) =>
    `Managers see: ${detail === "topic" ? "topics only" : detail === "summary" ? "topics and summaries" : "admins can read the full text"}; AI answers ${answers ? "are" : "are not"} kept; data is deleted after ${days} days. Details in Me › AI.`,
  quota: (pct) => (pct >= 100 ? "This month's AI quota is used up" : `${pct}% of this month's AI quota used`),
  quotaBody: "The quota resets on the 1st of next month; if you need more before then, ask an admin to raise it.",
  decisionWaiting: "Awaiting your decision",
  decisionNeeded: (t) => `Your decision needed: ${t}`,
  decided: (t) => `Decided: ${t}`,
  docCreated: (t) => `New doc: ${t}`,
  docUpdated: (t) => `${t} was updated`,
  docCommented: (t) => `New comment on ${t}`,
  agentAnswered: (agent, prompt) => `${agent} answered: ${prompt}`,
  dueSoon: (when, t) => `Due soon (${fmtDue(when, "en")}): ${t}`,
  overdue: (when, t) => `Overdue since ${fmtDue(when, "en")}: ${t}`,
  dueSoonPush: "One of your tasks is due soon",
  reminder: (t) => `Reminder: ${t}`,
  reminderPush: "You have a reminder",
  agentAsked: (code, n) => `The AI is asking on ${code}: ${n === 1 ? "1 question" : `${n} questions`} for you`,
  agentApproval: (code, step) => `The AI's work on ${code} is waiting for your approval: ${step}`,
  quickApprove: "Approve",
  quickOpen: "Open",
  quickDone: "Done. The AI carries on.",
  today: "today",
  tomorrow: "tomorrow",
  dayTitle: "Your day",
  dayCounts: (tasks, meetings, approvals) => `${n(tasks, "task")} · ${n(meetings, "meeting")} · ${n(approvals, "approval")}`,
  briefTitle: "Today at a glance",
  digest: {
    kind: { approval: "Approval", decision: "Decision to make", blocker: "Blocked task", mention: "Mentioned you", dm: "Message awaiting reply", task: "Task" },
    body: (n, meetings) => `${n} ${n === 1 ? "item needs" : "items need"} your attention${meetings ? ` · ${meetings} ${meetings === 1 ? "meeting" : "meetings"} today` : ""}.`,
    heading: "Needs your attention today",
    open: "Open workspace",
    subject: (n, meetings) => `Today: ${n} ${n === 1 ? "item" : "items"} to handle${meetings ? `, ${meetings} ${meetings === 1 ? "meeting" : "meetings"}` : ""}`,
    teamHeading: "Your team this week",
    team: (overdue, stale, blocked, done, risk = 0) =>
      `${overdue} overdue · ${risk ? `${risk} at risk · ` : ""}${stale} not updated lately · ${blocked} blocked · ${done} done in the last 7 days.`,
    teamWhy: { late: "overdue", risk: "at risk", stale: "not updated lately", blocked: "blocked" },
    teamSubject: (overdue) => (overdue ? `This week: ${overdue} overdue ${overdue === 1 ? "task" : "tasks"} in your team` : "This week: your team is on track"),
    teamOpen: "See team progress",
    myWeek: (done, doing, late) => `Last week you finished ${done} ${done === 1 ? "task" : "tasks"} · ${doing} in progress${late ? ` · ${late} overdue` : ""}.`,
  },
};

const AI_SOURCE_ZH: Record<string, string> = { ...AI_SOURCE, company: "公司 AI 助手", import: "导入的服务商数据", other: "其他 AI 工具" };
const AI_SOURCE_ES: Record<string, string> = { ...AI_SOURCE, company: "el asistente de la empresa", import: "datos importados del proveedor", other: "otra herramienta de IA" };
const AI_KIND_ZH: Record<string, string> = {
  personal_id: "身份证/护照号",
  card: "银行卡号",
  secret: "密码/API 密钥",
  contacts: "联系人列表",
  bank_account: "银行账号",
  keyword: "公司设定的关键词",
};
const AI_KIND_ES: Record<string, string> = {
  personal_id: "número de identidad",
  card: "número de tarjeta",
  secret: "contraseña/clave de API",
  contacts: "lista de contactos",
  bank_account: "cuenta bancaria",
  keyword: "palabra clave de la empresa",
};

const zh: Texts = {
  lang: "zh",
  push: {
    "task.assigned": "你被分配了一个任务",
    "approval.requested": "有一个申请需要你审批",
    mention: "有人在对话中提到了你",
    "leave.requested": "有一个休假申请需要你审批",
    "decision.proposed": "有一个决定等你确认",
    "task.mention": "有人在任务中提到了你",
    "task.agent_ask": "AI 需要你回答几个问题",
    "task.agent_approval": "有一份 AI 的结果等你审批",
  },
  pushDefault: "有事需要你处理",
  pushDm: "你有一条新私信",
  pushChannel: (name: string) => (name ? `#${name} 有新消息` : "频道有新消息"),
  pushOpen: "打开 workspace 查看",
  taskAssigned: (t) => `分配给你：${t}`,
  taskByAi: (t) => `AI 创建了任务：${t}`,
  taskFromChat: (t) => `来自对话的新任务：${t}`,
  done: (t) => `已完成：${t}`,
  blocked: (t) => `${t} 被阻塞`,
  commented: (code, t) => `${code} 有新评论：${t}`,
  taskMention: (code) => `你在 ${code} 中被提及`,
  approvalOnBehalf: "代休假的同事审批",
  approvalWaiting: "等待你审批",
  approvalNeeded: (t) => `待审批：${t}`,
  approvalDecided: (approved, t) => `${approved ? "已批准" : "已拒绝"}：${t}`,
  approvalCommented: (t) => `申请有新留言：${t}`,
  message: "消息",
  mentioned: "你被提及",
  dmWaiting: "等待你回复",
  meeting: (rescheduled, recurrence, t) =>
    `${rescheduled ? "会议有变动" : recurrence !== null ? `${({ daily: "每日", weekdays: "工作日", weekly: "每周", biweekly: "每两周", monthly: "每月" } as Record<string, string>)[recurrence] ?? "周期"}会议邀请` : "会议邀请"}：${t}`,
  leaveItem: (name, days) => `休假：${name}（${days} 天）`,
  leaveRange: (a, b) => `${ddmm(a)} → ${ddmm(b)}`,
  leaveRequested: (name, days) => `${name} 申请休假 ${days} 天`,
  leaveDecided: (approved) => (approved ? "你的休假申请已批准" : "你的休假申请被拒绝"),
  aiFlagged: (kinds: string[], source: string): string => `敏感数据（${kinds.map((k) => AI_KIND_ZH[k] ?? k).join("、")}）刚被发送到 ${AI_SOURCE_ZH[source] ?? source}`,
  aiFlaggedBody: "在 AI › AI 采用 › 用量 中查看是谁、发送到哪里。本通知不包含发送的内容。",
  aiPolicy: "公司更改了 AI 使用的记录方式",
  announcement: (t: string) => `新公告：${t}`,
  leaveReminder: (name: string, days: number) => `提醒：${name} 的 ${days} 天休假申请仍在等你审批`,
  aiExtension: "公司请你安装 workspace AI 浏览器扩展",
  aiExtensionBody: "大约一分钟：下载扩展，再粘贴 我的 › AI 中的连接码。你随时可以查看它记录的全部内容。",
  aiPolicyBody: (detail, answers, days) =>
    `管理者可见：${detail === "topic" ? "仅主题" : detail === "summary" ? "主题和摘要" : "管理员可阅读全文"}；${answers ? "保存" : "不保存"} AI 的回答；数据 ${days} 天后删除。详情见 我的 › AI。`,
  quota: (pct) => (pct >= 100 ? "本月 AI 额度已用完" : `本月 AI 额度已使用 ${pct}%`),
  quotaBody: "额度在下月 1 日重置；如需更多，请联系管理员提高额度。",
  decisionWaiting: "等待你确认",
  decisionNeeded: (t) => `需要你确认：${t}`,
  decided: (t) => `已确认：${t}`,
  docCreated: (t) => `新文档：${t}`,
  docUpdated: (t) => `${t} 已更新`,
  docCommented: (t) => `${t} 有新评论`,
  agentAnswered: (agent, prompt) => `${agent} 已回答：${prompt}`,
  dueSoon: (when, t) => `即将到期（${fmtDue(when, "zh")}）：${t}`,
  overdue: (when, t) => `已逾期（${fmtDue(when, "zh")}）：${t}`,
  dueSoonPush: "你的一个任务即将到期",
  reminder: (t) => `提醒：${t}`,
  reminderPush: "你有一条提醒",
  agentAsked: (code, n) => `AI 在 ${code} 提问：有 ${n} 个问题需要你回答`,
  agentApproval: (code, step) => `AI 在 ${code} 的结果等你审批：${step}`,
  quickApprove: "批准",
  quickOpen: "打开",
  quickDone: "已记录，AI 继续进行。",
  today: "今天",
  tomorrow: "明天",
  dayTitle: "你的今天",
  dayCounts: (tasks, meetings, approvals) => `${tasks} 个任务 · ${meetings} 个会议 · ${approvals} 个审批`,
  briefTitle: "今日概览",
  digest: {
    kind: { approval: "审批", decision: "待确认的决定", blocker: "被阻塞的任务", mention: "提到你", dm: "待回复的消息", task: "任务" },
    body: (n, meetings) => `有 ${n} 项需要你处理${meetings ? ` · 今天 ${meetings} 个会议` : ""}。`,
    heading: "今天需要你处理",
    open: "打开 workspace",
    subject: (n, meetings) => `今天：${n} 项待处理${meetings ? `，${meetings} 个会议` : ""}`,
    teamHeading: "本周团队情况",
    team: (overdue, stale, blocked, done, risk = 0) =>
      `${overdue} 个逾期 · ${risk ? `${risk} 个有逾期风险 · ` : ""}${stale} 个长期未更新 · ${blocked} 个被阻塞 · 近 7 天完成 ${done} 个。`,
    teamWhy: { late: "逾期", risk: "有逾期风险", stale: "长期未更新", blocked: "被阻塞" },
    teamSubject: (overdue) => (overdue ? `本周：团队有 ${overdue} 个逾期任务` : "本周：团队进度正常"),
    teamOpen: "查看团队进度",
    myWeek: (done, doing, late) => `上周你完成了 ${done} 个任务 · ${doing} 个进行中${late ? ` · ${late} 个逾期` : ""}。`,
  },
};

const es: Texts = {
  lang: "es",
  push: {
    "task.assigned": "Te asignaron una tarea",
    "approval.requested": "Una solicitud necesita tu aprobación",
    mention: "Te mencionaron en una conversación",
    "leave.requested": "Una solicitud de ausencia necesita tu aprobación",
    "decision.proposed": "Una decisión te espera",
    "task.mention": "Te mencionaron en una tarea",
    "task.agent_ask": "La IA necesita algunas respuestas tuyas",
    "task.agent_approval": "Un resultado de la IA espera tu aprobación",
  },
  pushDefault: "Algo necesita tu atención",
  pushDm: "Tienes un mensaje directo nuevo",
  pushChannel: (name: string) => (name ? `Mensajes nuevos en #${name}` : "Mensajes nuevos en un canal"),
  pushOpen: "Abre workspace para verlo",
  taskAssigned: (t) => `Asignada a ti: ${t}`,
  taskByAi: (t) => `La IA creó una tarea: ${t}`,
  taskFromChat: (t) => `Nueva tarea de una conversación: ${t}`,
  done: (t) => `Terminada: ${t}`,
  blocked: (t) => `${t} está bloqueada`,
  commented: (code, t) => `Nuevo comentario en ${code}: ${t}`,
  taskMention: (code) => `Te mencionaron en ${code}`,
  approvalOnBehalf: "Apruebas en nombre de alguien ausente",
  approvalWaiting: "Pendiente de tu aprobación",
  approvalNeeded: (t) => `Aprobación necesaria: ${t}`,
  approvalDecided: (approved, t) => `${approved ? "Aprobada" : "Rechazada"}: ${t}`,
  approvalCommented: (t) => `Nuevo mensaje en una solicitud: ${t}`,
  message: "Mensaje",
  mentioned: "Te mencionaron",
  dmWaiting: "Esperando tu respuesta",
  meeting: (rescheduled, recurrence, t) =>
    `${rescheduled ? "Reunión modificada" : recurrence !== null ? `Invitación a reunión ${({ daily: "diaria", weekdays: "de lunes a viernes", weekly: "semanal", biweekly: "quincenal", monthly: "mensual" } as Record<string, string>)[recurrence] ?? "periódica"}` : "Invitación a reunión"}: ${t}`,
  leaveItem: (name, days) => `Ausencia: ${name} (${days} ${days === 1 ? "día" : "días"})`,
  leaveRange: (a, b) => `${ddmm(a)} → ${ddmm(b)}`,
  leaveRequested: (name, days) => `${name} pidió ${days} ${days === 1 ? "día" : "días"} libres`,
  leaveDecided: (approved) => (approved ? "Tu solicitud de ausencia fue aprobada" : "Tu solicitud de ausencia fue rechazada"),
  aiFlagged: (kinds: string[], source: string): string =>
    `Se acaban de enviar datos sensibles (${kinds.map((k) => AI_KIND_ES[k] ?? k).join(", ")}) a ${AI_SOURCE_ES[source] ?? source}`,
  aiFlaggedBody: "Mira quién lo envió y dónde en IA › Adopción de IA › Uso. Esta notificación no incluye lo enviado.",
  aiPolicy: "Tu empresa cambió cómo se registra el uso de IA",
  announcement: (t: string) => `Nuevo anuncio: ${t}`,
  leaveReminder: (name: string, days: number) => `Recordatorio: la solicitud de ausencia de ${days} ${days === 1 ? "día" : "días"} de ${name} sigue esperando tu aprobación`,
  aiExtension: "Tu empresa te pide instalar la extensión de IA de workspace",
  aiExtensionBody: "Lleva un minuto: descárgala y pega el código de conexión de Yo › IA. Siempre puedes ver todo lo que registra.",
  aiPolicyBody: (detail, answers, days) =>
    `Los responsables ven: ${detail === "topic" ? "solo temas" : detail === "summary" ? "temas y resúmenes" : "los administradores pueden leer el texto completo"}; las respuestas de la IA ${answers ? "se guardan" : "no se guardan"}; los datos se borran a los ${days} días. Detalles en Yo › IA.`,
  quota: (pct) => (pct >= 100 ? "Se agotó la cuota de IA de este mes" : `Usado el ${pct}% de la cuota de IA de este mes`),
  quotaBody: "La cuota se renueva el día 1 del próximo mes; si necesitas más antes, pide a un administrador que la amplíe.",
  decisionWaiting: "Esperando tu decisión",
  decisionNeeded: (t) => `Necesitamos tu decisión: ${t}`,
  decided: (t) => `Decidido: ${t}`,
  docCreated: (t) => `Documento nuevo: ${t}`,
  docUpdated: (t) => `${t} se actualizó`,
  docCommented: (t) => `Nuevo comentario en ${t}`,
  agentAnswered: (agent, prompt) => `${agent} respondió: ${prompt}`,
  dueSoon: (when, t) => `Vence pronto (${fmtDue(when, "es")}): ${t}`,
  overdue: (when, t) => `Vencida desde ${fmtDue(when, "es")}: ${t}`,
  dueSoonPush: "Una de tus tareas vence pronto",
  reminder: (t) => `Recordatorio: ${t}`,
  reminderPush: "Tienes un recordatorio",
  agentAsked: (code, n) => `La IA pregunta en ${code}: ${n === 1 ? "1 pregunta" : `${n} preguntas`} para ti`,
  agentApproval: (code, step) => `El trabajo de la IA en ${code} espera tu aprobación: ${step}`,
  quickApprove: "Aprobar",
  quickOpen: "Abrir",
  quickDone: "Hecho. La IA continúa.",
  today: "hoy",
  tomorrow: "mañana",
  dayTitle: "Tu día",
  dayCounts: (tasks, meetings, approvals) =>
    `${tasks} ${tasks === 1 ? "tarea" : "tareas"} · ${meetings} ${meetings === 1 ? "reunión" : "reuniones"} · ${approvals} ${approvals === 1 ? "aprobación" : "aprobaciones"}`,
  briefTitle: "Hoy de un vistazo",
  digest: {
    kind: { approval: "Aprobación", decision: "Decisión pendiente", blocker: "Tarea bloqueada", mention: "Te mencionaron", dm: "Mensaje sin responder", task: "Tarea" },
    body: (n, meetings) =>
      `${n} ${n === 1 ? "asunto necesita" : "asuntos necesitan"} tu atención${meetings ? ` · ${meetings} ${meetings === 1 ? "reunión" : "reuniones"} hoy` : ""}.`,
    heading: "Necesita tu atención hoy",
    open: "Abrir workspace",
    subject: (n, meetings) => `Hoy: ${n} ${n === 1 ? "asunto" : "asuntos"} por atender${meetings ? `, ${meetings} ${meetings === 1 ? "reunión" : "reuniones"}` : ""}`,
    teamHeading: "Tu equipo esta semana",
    team: (overdue, stale, blocked, done, risk = 0) =>
      `${overdue} vencidas · ${risk ? `${risk} en riesgo · ` : ""}${stale} sin actualizar hace tiempo · ${blocked} bloqueadas · ${done} terminadas en los últimos 7 días.`,
    teamWhy: { late: "vencida", risk: "en riesgo", stale: "sin actualizar", blocked: "bloqueada" },
    teamSubject: (overdue) => (overdue ? `Esta semana: ${overdue} ${overdue === 1 ? "tarea vencida" : "tareas vencidas"} en tu equipo` : "Esta semana: tu equipo va al día"),
    teamOpen: "Ver el avance del equipo",
    myWeek: (done, doing, late) => `La semana pasada terminaste ${done} ${done === 1 ? "tarea" : "tareas"} · ${doing} en curso${late ? ` · ${late} vencidas` : ""}.`,
  },
};

const TEXTS: Record<Locale, Texts> = { vi, en, zh, es };
export const texts = (l: unknown): Texts => TEXTS[isLocale(l) ? l : "en"];

/**
 * A text kept as data so it can be written in whoever reads it's language later: the name of a Texts entry plus its
 * arguments (user content such as a task title travels as an argument and is never translated). Notifications store
 * these (title_msg/body_msg) and render them per request, so the inbox follows the language the reader uses now.
 */
export interface Msg {
  k: string;
  a?: unknown[];
}
export const msg = (k: keyof Texts, ...a: unknown[]): Msg => (a.length ? { k, a } : { k });
export const isMsg = (v: unknown): v is Msg => !!v && typeof v === "object" && typeof (v as Msg).k === "string";

/** The message in these texts; null for a key this version does not know (an old row after a text was removed). */
export function renderMsg(t: Texts, m: Msg): string | null {
  const v = (t as unknown as Record<string, unknown>)[m.k];
  if (typeof v === "string") return v;
  if (typeof v === "function") return String((v as (...a: unknown[]) => unknown)(...(m.a ?? [])));
  return null;
}

/** The person's language for generated text; the workspace's when unknown (no prefs row yet), English for a broadcast "*". */
export async function textsFor(c: PoolClient, userId: string): Promise<Texts> {
  if (userId === "*") return en;
  // Someone who never opened the app has no user_prefs row: their texts follow the workspace language.
  return texts(
    (
      await c.query<{ locale: string }>("SELECT coalesce((SELECT locale FROM user_prefs WHERE user_id = $1), (SELECT locale FROM workspace_settings LIMIT 1), 'en') AS locale", [
        userId,
      ])
    ).rows[0]?.locale,
  );
}
