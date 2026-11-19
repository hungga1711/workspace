/** What Follow-up (GET work/followup/team) returns: the team, per person and department. */
export interface TaskLine {
  id: string;
  code: string;
  title: string;
  status: string;
  dueAt: string | null;
  overdue?: boolean;
  stale?: boolean;
  progress?: number | null;
  etaAt?: string | null;
  atRisk?: boolean;
}
export interface DelegatedTask extends TaskLine {
  assigneeId: string;
  updatedAt: string;
  blockedReason: string | null;
  completedAt: string | null;
}
export interface Delegated {
  summary: { open: number; overdue: number; atRisk?: number; stale: number; blocked: number; done14: number };
  tasks: DelegatedTask[];
}
export interface TeamPerson {
  userId: string;
  displayName: string;
  title?: string | null;
  open: number;
  inProgress: number;
  overdue: number;
  atRisk?: number;
  stale: number;
  blocked: number;
  done7: number;
  department?: string | null;
  done28?: number;
  onTimeRate?: number | null;
  avgProgress?: number | null;
  lastActivityAt: string | null;
  now: TaskLine[];
  late: TaskLine[];
  doneRecently: { id: string; code: string; title: string; completedAt: string }[];
  tasks: (TaskLine & { blockedReason: string | null; lastNote?: { text: string; at: string } })[];
}
export interface DepartmentStatus {
  name: string | null;
  people: number;
  userIds: string[];
  open: number;
  inProgress: number;
  overdue: number;
  atRisk: number;
  stale: number;
  blocked: number;
  done7: number;
  onTimeRate: number | null;
  avgProgress: number | null;
  doneWeeks?: number[];
  health: "risk" | "watch" | "ok";
}
export interface Team {
  scope: "reports" | "everyone" | "none";
  departments?: DepartmentStatus[];
  totals: { open: number; overdue: number; atRisk?: number; stale: number; blocked: number; done7: number };
  people: TeamPerson[];
}
