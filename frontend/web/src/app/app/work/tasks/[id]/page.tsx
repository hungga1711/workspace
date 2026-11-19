import { TaskDetailView } from "@/components/work/TaskDetailView";
import type { Task } from "@/components/work/types";
import { loadTask, refParam } from "@/components/work/loaders";
import type { DepRow } from "@/components/work/TaskDependencies";
import type { Metadata } from "next";
import { gwOnce } from "@/lib/gateway";
import type { TaskAsk } from "@/components/workflows/types";
import { ReadFailed } from "@/components/ui/ReadFailed";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const r = await gwOnce<TaskDetail>(`/api/work/tasks/${refParam(id)}`).catch(() => null);
  return r ? { title: `${r.task.code} ${r.task.title}` } : {};
}

export interface TaskDetail {
  task: Task;
  /** `agent`: a workflow's result, shown under its name (the author is who started the run). */
  comments: { id: string; authorId: string; agent?: string | null; body: string; createdAt: string; editedAt?: string | null }[];
  activity: { actor: string; action: string; changes: Record<string, { from: unknown; to: unknown }>; at: string }[];
  subtasks: Task[];
  files: { id: string; name: string; contentType: string; size: number }[];
  dependencies?: { waitingOn: DepRow[]; blocking: DepRow[] };
  /** Whether "Xoá việc" would be allowed (the creator, or `task.delete` on it). */
  canDelete?: boolean;
  /** The open rounds of questions from the task's agent (work/agent-ask.ts). */
  agentAsks?: TaskAsk[];
  /** People following the task (task_watchers), and whether the viewer is one of them. */
  watchers?: string[];
  watching?: boolean;
}

export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await loadTask(id);
  if (!r.data) return <ReadFailed status={r.failed} />;
  const t = r.data;
  return <TaskDetailView key={t.detail.task.version} detail={t.detail} projects={t.projects} fields={t.fields} aiEnabled={t.aiEnabled} />;
}
