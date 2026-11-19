import type { AnswerBlock, ChartBlock, TableBlock } from "./answer-blocks.js";

/**
 * The charts and tables of the report and task tools, built from the rows each tool already wrote for the
 * model: pure functions, so what is drawn is exactly what the tool read. `vi` picks the labels' language (the tool
 * results' own: English or Vietnamese).
 */

type Lang = { vi: boolean };
const L = (x: Lang, en: string, vi: string) => (x.vi ? vi : en);
const personUrl = (userId: string) => `/app/work/people/${encodeURIComponent(userId)}`;
const taskUrl = (code: string) => `/app/work/tasks/${encodeURIComponent(code)}`;
/** "2026-11-10" → "10/11", the week as people say it. */
const weekLabel = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

/** Done and added per week, oldest first (person_progress, trend_metric). */
export function flowChart(x: Lang & { id: string; of: string }, weeks: { week: string; done: number; added: number }[]): ChartBlock | null {
  if (weeks.length < 2) return null;
  return {
    kind: "chart",
    id: x.id,
    title: L(x, `Tasks done and added per week · ${x.of}`, `Việc xong và việc mới theo tuần · ${x.of}`),
    chart: "trend",
    series: [L(x, "Done", "Xong"), L(x, "Added", "Thêm")],
    rows: weeks.map((w) => ({ label: weekLabel(w.week), value: w.done, compare: w.added })),
  };
}

/** Overdue tasks at the end of each week (trend_metric). */
export function overdueChart(x: Lang & { id: string; of: string }, weeks: { week: string; overdue: number }[]): ChartBlock | null {
  if (weeks.length < 2) return null;
  return {
    kind: "chart",
    id: x.id,
    title: L(x, `Overdue at the end of each week · ${x.of}`, `Việc trễ hạn cuối mỗi tuần · ${x.of}`),
    chart: "trend",
    rows: weeks.map((w) => ({ label: weekLabel(w.week), value: w.overdue })),
  };
}

/** Open tasks per person, overloaded ones in the accent; a bar opens the person (workload_balance). */
export function workloadChart(x: Lang, people: { userId: string; displayName: string; open: number; dueSoon: number; load: string }[]): ChartBlock | null {
  if (!people.length) return null;
  return {
    kind: "chart",
    id: "workload",
    title: L(x, "Open tasks per person", "Việc đang mở theo người"),
    chart: "bars",
    series: [L(x, "Open", "Đang mở"), L(x, "Due in 7 days", "Hạn trong 7 ngày")],
    rows: [...people]
      .sort((a, b) => b.open - a.open)
      .slice(0, 20)
      .map((p) => ({ label: p.displayName, value: p.open, compare: p.dueSoon, highlight: p.load === "overloaded", drill: { url: personUrl(p.userId) } })),
  };
}

/** Departments side by side; a row asks about that department (department_compare). */
export function departmentTable(
  x: Lang & { weeks: number },
  rows: { name: string | null; people: number; done: number; open: number; overdue: number; overdueShare: number; blocked: number; onTimeRate: number | null; health: string }[],
): TableBlock | null {
  if (!rows.length) return null;
  const none = L(x, "(no department)", "(chưa có phòng ban)");
  return {
    kind: "table",
    id: "departments",
    title: L(x, `Departments, last ${x.weeks} week(s)`, `Phòng ban, ${x.weeks} tuần qua`),
    columns: [
      { key: "name", label: L(x, "Department", "Phòng ban") },
      { key: "people", label: L(x, "People", "Người"), num: true },
      { key: "done", label: L(x, "Done", "Xong"), num: true },
      { key: "open", label: L(x, "Open", "Mở"), num: true },
      { key: "overdue", label: L(x, "Overdue", "Trễ"), num: true },
      { key: "blocked", label: L(x, "Blocked", "Bị chặn"), num: true },
      { key: "onTime", label: L(x, "On time", "Đúng hạn"), num: true },
    ],
    rows: rows.map((d) => ({
      cells: {
        name: d.name ?? none,
        people: d.people,
        done: d.done,
        open: d.open,
        overdue: d.overdueShare ? `${d.overdue} (${d.overdueShare}%)` : d.overdue,
        blocked: d.blocked,
        onTime: d.onTimeRate === null ? "–" : `${d.onTimeRate}%`,
      },
      highlight: d.health === "risk",
      ...(d.name ? { drill: { ask: L(x, `How is ${d.name} doing?`, `Phòng ${d.name} đang thế nào?`) } } : {}),
    })),
  };
}

/** Late and at-risk tasks, most late first; a row opens the task (overdue_tasks). */
export function lateTable(
  x: Lang & { now: number; day: (iso: string | null) => string },
  late: { code: string; title: string; assignee: string; dueAt: string | null; overdue: boolean; progress: number | null }[],
): TableBlock | null {
  if (!late.length) return null;
  const days = (iso: string | null) => (iso ? Math.max(0, Math.floor((x.now - Date.parse(iso)) / 86_400_000)) : 0);
  const sorted = [...late].sort((a, b) => Number(b.overdue) - Number(a.overdue) || days(b.dueAt) - days(a.dueAt));
  return {
    kind: "table",
    id: "late",
    title: L(x, "Overdue and at-risk tasks", "Việc trễ và có nguy cơ trễ"),
    columns: [
      { key: "task", label: L(x, "Task", "Việc") },
      { key: "who", label: L(x, "Assignee", "Người làm") },
      { key: "due", label: L(x, "Due", "Hạn"), num: true },
      { key: "late", label: L(x, "Late", "Trễ"), num: true },
      { key: "progress", label: L(x, "Progress", "Tiến độ"), num: true },
    ],
    rows: sorted.map((t) => ({
      cells: {
        task: `${t.code} ${t.title}`,
        who: t.assignee,
        due: x.day(t.dueAt),
        late: t.overdue ? L(x, `${days(t.dueAt)}d`, `${days(t.dueAt)} ngày`) : L(x, "at risk", "nguy cơ"),
        progress: t.progress === null ? "–" : `${t.progress}%`,
      },
      highlight: t.overdue,
      drill: { url: taskUrl(t.code) },
    })),
  };
}

/** Spend by department and by model (ai_spend). */
export function spendCharts(x: Lang, departments: { name: string | null; costUsd: number }[], models: { model: string; costUsd: number | null; tokens: number }[]): AnswerBlock[] {
  const out: AnswerBlock[] = [];
  const none = L(x, "(no department)", "(chưa có phòng ban)");
  const depts = departments.filter((d) => d.costUsd > 0);
  if (depts.length)
    out.push({
      kind: "chart",
      id: "spend-departments",
      title: L(x, "AI spend by department (USD)", "Chi phí AI theo phòng ban (USD)"),
      chart: "bars",
      unit: "$",
      rows: depts
        .sort((a, b) => b.costUsd - a.costUsd)
        .map((d) => ({
          label: d.name ?? none,
          value: d.costUsd,
          ...(d.name ? { drill: { ask: L(x, `Who in ${d.name} uses the most AI?`, `Ai ở phòng ${d.name} dùng AI nhiều nhất?`) } } : {}),
        })),
    });
  const priced = models.filter((m) => (m.costUsd ?? 0) > 0);
  if (priced.length)
    out.push({
      kind: "chart",
      id: "spend-models",
      title: L(x, "AI spend by model (USD)", "Chi phí AI theo model (USD)"),
      chart: "bars",
      unit: "$",
      rows: priced.sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0)).map((m) => ({ label: m.model, value: m.costUsd ?? 0 })),
    });
  return out;
}

/** AI uses beside tasks done, per person (ai_usage_vs_output). */
export function aiOutputTable(
  x: Lang & { days: number },
  people: { userId: string; displayName: string; uses: number; usesChange: number | null; done: number; doneChange: number | null; onTimeRate: number | null }[],
): TableBlock | null {
  if (!people.length) return null;
  const signed = (n: number | null) => (n === null || n === 0 ? "" : ` (${n > 0 ? "+" : ""}${n}%)`);
  return {
    kind: "table",
    id: "ai-output",
    title: L(x, `AI use and tasks done, ${x.days} days`, `Dùng AI và việc xong, ${x.days} ngày`),
    columns: [
      { key: "name", label: L(x, "Person", "Người") },
      { key: "uses", label: L(x, "AI uses", "Lượt dùng AI"), num: true },
      { key: "done", label: L(x, "Done", "Xong"), num: true },
      { key: "onTime", label: L(x, "On time", "Đúng hạn"), num: true },
    ],
    rows: people.map((p) => ({
      cells: { name: p.displayName, uses: `${p.uses}${signed(p.usesChange)}`, done: `${p.done}${signed(p.doneChange)}`, onTime: p.onTimeRate === null ? "–" : `${p.onTimeRate}%` },
      drill: { url: personUrl(p.userId) },
    })),
  };
}

/** Attendance per person, most absences first (attendance_summary). */
export function attendanceTable(
  x: Lang & { period: string },
  people: { userId: string; displayName: string; presentDays: number; hours: number; lateDays: number; leaveDays: number; absentDays: number }[],
): TableBlock | null {
  if (!people.length) return null;
  return {
    kind: "table",
    id: "attendance",
    title: L(x, `Attendance ${x.period}`, `Chấm công ${x.period}`),
    columns: [
      { key: "name", label: L(x, "Person", "Người") },
      { key: "in", label: L(x, "Days in", "Ngày làm"), num: true },
      { key: "hours", label: L(x, "Hours", "Giờ"), num: true },
      { key: "late", label: L(x, "Late", "Đi muộn"), num: true },
      { key: "leave", label: L(x, "Leave", "Nghỉ phép"), num: true },
      { key: "absent", label: L(x, "Absent", "Vắng"), num: true },
    ],
    rows: people.map((p) => ({
      cells: { name: p.displayName, in: p.presentDays, hours: p.hours, late: p.lateDays, leave: p.leaveDays, absent: p.absentDays },
      highlight: p.absentDays > 0,
      drill: { url: personUrl(p.userId) },
    })),
  };
}
