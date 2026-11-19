import { PeekModal } from "@/components/ui/PeekModal";
import { ReadFailed } from "@/components/ui/ReadFailed";
import { TaskDetailView } from "@/components/work/TaskDetailView";
import { loadTask } from "@/components/work/loaders";
import { taskHref } from "@/lib/links";

/**
 * A task as a large centred dialog over the page, like an issue tracker's issue view, opened from a list, board,
 * Home or chat through the intercepting route: the address is the task's own (/app/work/tasks/T-1), so a reload or
 * a shared link opens its full page, and back or close returns to the page underneath as it was.
 */
export async function TaskPeek({ id }: { id: string }) {
  const r = await loadTask(id);
  if (!r.data)
    return (
      <PeekModal flush title={id} href={`/app/work/tasks/${id}`}>
        <ReadFailed status={r.failed} />
      </PeekModal>
    );
  const t = r.data;
  const task = t.detail.task;
  // The drawer's header gives the context (code · project); the task's name is the body's one title.
  const project = t.projects.find((p) => p.id === task.projectId)?.name;
  return (
    <PeekModal flush code={task.code} context={project} title={project ? `${task.code} · ${project}` : task.code} href={taskHref(task)}>
      <TaskDetailView key={task.id} detail={t.detail} projects={t.projects} fields={t.fields} aiEnabled={t.aiEnabled} peek />
    </PeekModal>
  );
}
