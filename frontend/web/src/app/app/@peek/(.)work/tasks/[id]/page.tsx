import { TaskPeek } from "@/components/work/TaskPeek";

/** A task opened from a list, board, Home or chat: a large centred dialog over the page, like Jira's issue view. */
export default async function TaskPeekPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TaskPeek id={id} />;
}
