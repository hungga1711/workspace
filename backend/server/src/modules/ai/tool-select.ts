/**
 * Which workspace tools one question is offered. With the area tools (tools-*.ts) there are ~70, about
 * 40 KB of specs sent with every model turn: costly on a hosted model, and more than a small self-hosted model reads
 * well in its instructions (the prompted protocol). Each question gets the core set (search, read, the first tools)
 * plus the areas its words point to, the place it was asked in (a channel: the chat tools; a task: the task tools).
 *
 * Only what the model is SHOWN is narrowed: every tool stays callable, so a paused answer resumed later, or a model
 * that names a tool it saw earlier in the conversation, still runs. Deterministic and cheap (no model call).
 */

export type Area = "tasks" | "chat" | "reports" | "ai" | "docs" | "whiteboard" | "workflow" | "data" | "people" | "assist" | "web" | "office" | "picture";

export const AREA_TOOLS: Record<Area, readonly string[]> = {
  tasks: ["overdue_tasks", "find_duplicate_tasks", "task_history", "estimate_due_date", "assign_task", "split_task", "move_tasks_bulk", "link_tasks", "onboarding_checklist"],
  chat: ["summarize_channel", "extract_action_items", "unanswered_questions", "draft_reply", "pin_message", "create_poll"],
  reports: ["person_progress", "department_compare", "weekly_report", "weekly_report_text", "workload_balance", "blockers_report", "trend_metric"],
  ai: ["ai_usage_vs_output", "prompt_topics", "ai_spend", "suggest_ai_adoption"],
  docs: ["summarize_document", "compare_document_versions", "doc_to_tasks", "translate_document"],
  whiteboard: ["create_whiteboard_diagram"],
  workflow: ["create_workflow_from_description", "workflow_run_status"],
  data: ["import_preview", "import_tasks", "export_report"],
  people: ["find_meeting_slot", "attendance_summary", "org_chart", "who_reports_to", "request_leave", "schedule_reminder"],
  assist: ["plan_my_day", "draft_update"],
  web: ["read_webpage"],
  office: [
    "read_office_file",
    "analyze_sheet",
    "explain_formula",
    "check_formulas",
    "create_word_document",
    "fill_word_template",
    "create_spreadsheet",
    "edit_spreadsheet",
    "create_presentation",
    "convert_office",
  ],
  // A table read from the question's pictures: only with pictures attached (selectTools' `pictures`).
  picture: ["image_to_spreadsheet"],
};

/** Words that point to an area, matched on the folded question (no accents, lower case): vi, en, zh, es. */
const AREA_WORDS: Record<Area, RegExp> = {
  // A page outside the app (its own screens are /app/… and the workspace tools read them).
  web: /https?:\/\/(?![^\s/]+\/app\/)(?!localhost)[^\s]+/,
  tasks:
    /\b(viec|task|nhiem vu|cong viec|giao|assign|subtasks?|tach|chia nho|split|tre|qua han|overdue|late|trung|duplicate|lich su|history|uoc tinh|estimate|bao lau|deadline|han|phu thuoc|depend\w*|chan|block\w*|onboard\w*|nhan vien moi|new hire|hang loat|bulk|trang thai|status|tarea\w*|atrasad\w*)\b|[a-z]+-\d+|任务|逾期|指派/,
  chat: /\b(kenh|channel|chat|tin nhan|messages?|thread|bo lo|miss(ed)?|catch me up|tom tat|summar\w*|recap|chua tra loi|unanswered|tra loi|repl(y|ies|ied)|answer(ed)?|respond\w*|ghim|pin|binh chon|polls?|vote|action items?|viec can lam|cau hoi|questions?|canal|mensajes?)\b|频道|消息|总结/,
  reports:
    /\b(tien do|progress|bao cao|reports?|tuan|weekly|thang|phong|department\w*|team|doi|nhan vien|qua tai|overload\w*|workload|ranh|capacity|chan|blocked|stuck|ket|xu huong|trend\w*|so sanh|compare|nang suat|productiv\w*|dang lam gi|doing|who|ai dang|ai lam|equipo|departamento|informe)\b|进展|报告|部门|团队|趋势/,
  ai: /\b(chatgpt|claude|gemini|copilot|prompts?|tokens?|adoption|ap dung ai|dung ai|su dung ai|xai ai|ung dung ai|chi phi ai|ai usage|ai spend|ai cost|use ai|using ai|uses ai|uso de ia|ia)\b|使用ai|ai使用/,
  docs: /\b(trang (tai lieu|doc|wiki|nay|do)|pages?|docs?|documents?|tai lieu|van ban|spec|ke hoach|plan|phien ban|versions?|dich|translat\w*|tom tat|summar\w*|documento|traduc\w*)\b|文档|翻译/,
  whiteboard: /\b(whiteboards?|bang trang|so do|diagram\w*|flow\w*|mind ?map|ve so do|ve flow|draw|pizarra)\b|白板|流程图/,
  workflow: /\b(workflows?|quy trinh|tu dong\w*|automat\w*|agents?|lan chay|runs?|flujo)\b|工作流/,
  data: /\b(import\w*|nhap|csv|jira|trello|asana|clickup|notion|excel|export\w*|xuat|tai xuong|download|importar|exportar)\b|导入|导出/,
  people:
    /\b(hop|gap|meet(ings?)?|lich|calendar|schedul\w*|book|gio trong|free|slots?|ranh|nghi|leave|phep|cham cong|attendance|di muon|vang|absent|to chuc|org\w*|bao cao cho|reports? to|quan ly|manager|cap duoi|direct reports|nhac|remind\w*|reunion|vacaciones|recordar\w*)\b|会议|请假|考勤|提醒|组织/,
  office:
    /\b(word|excel|powerpoint|ppt|pptx|xlsx|docx|csv|pdf|slides?|deck|trinh chieu|thuyet trinh|bai trinh bay|bang tinh|spreadsheets?|workbook|sheets?|cong thuc|formulas?|vlookup|xlookup|sumif\w*|pivot|tao file|xuat file|file (word|excel|ppt)|tep|bieu mau|mau (don|hop dong|van ban)|templates?|tron thu|mail merge|bien ban|hop dong|to trinh|cong van|bao gia|hoa don|bang luong|cham diem|loc du lieu|tong hop du lieu|presentaci\w*|hoja de calculo|plantilla)\b|\.(docx|xlsx|pptx|csv|pdf)\b|幻灯片|演示|表格|公式|文档模板/,
  // Asked with pictures: the words that want their content as a table.
  picture:
    /\b(bang|excel|xlsx|sheets?|spreadsheets?|tables?|bang tinh|nhap (lieu|vao)|chuyen (thanh|sang)|lap bang|ke bang|hoa don|phieu( chi| thu)?|bien lai|bien nhan|chung tu|receipts?|invoices?|bills?|danh thiep|name ?cards?|business cards?|bao gia|bang gia|price list|chi phi|expenses?|tabla|factura|recibo)\b|表格|发票|收据|名片/,
  assist:
    /\b(ke hoach|plan\w*|lam gi truoc|nen lam|lam truoc|bat dau tu|uu tien|priorit\w*|hom nay|today|first|cuoi ngay|end of day|eod|daily|standup|bao cao ngay|cap nhat|update|draft|soan|viet (giup|ho)|nho (ho tro|giup)|xin ho tro|can giup|help|stuck|vuong|planifica\w*|informe diario)\b|计划|日报|先做/,
};

/** Where the question was asked: the place's own tools come with it. */
export type Surface = "ask" | "channel" | "task";
const SURFACE_AREAS: Record<Surface, Area[]> = { ask: [], channel: ["chat"], task: ["tasks"] };

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase();

/** The areas a question points to; the picture tools only when pictures came with it. */
export function areasOf(question: string, surface: Surface = "ask", pictures = false): Set<Area> {
  const q = fold(question);
  const out = new Set<Area>(SURFACE_AREAS[surface]);
  for (const [area, words] of Object.entries(AREA_WORDS) as [Area, RegExp][]) if ((area !== "picture" || pictures) && words.test(q)) out.add(area);
  return out;
}

const IN_AREA = new Map(Object.entries(AREA_TOOLS).flatMap(([area, names]) => names.map((n) => [n, area as Area] as const)));

/**
 * The tool names to show for a question, among `names`: every tool outside the areas (the core set), and the tools of
 * the areas the question points to. No question (a resumed answer): all of them.
 */
export function selectTools(names: readonly string[], question: string | undefined, surface: Surface = "ask", pictures = false): Set<string> {
  if (!question?.trim()) return new Set(names);
  const areas = areasOf(question, surface, pictures);
  return new Set(names.filter((n) => !IN_AREA.has(n) || areas.has(IN_AREA.get(n)!)));
}
