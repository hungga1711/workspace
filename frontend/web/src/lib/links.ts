/**
 * Addresses of tasks, projects, documents, requests, meetings and whiteboards by their code (`/app/work/tasks/T-041`,
 * `/app/work/approvals/YC-007`, `/app/work/meetings/H-012-3`), the form people read, say
 * and paste into chat. The code is optional: a record known only by id (an older payload) links by id, and the
 * pages accept both.
 */
type Ref = { id: string; code?: string | null };
const seg = (r: Ref) => encodeURIComponent(r.code || r.id);

export const taskHref = (t: Ref) => `/app/work/tasks/${seg(t)}`;
export const projectHref = (p: Ref) => `/app/work/projects/${seg(p)}`;
export const docHref = (d: Ref) => `/app/work/docs/${seg(d)}`;
export const approvalHref = (a: Ref) => `/app/work/approvals/${seg(a)}`;
export const meetingHref = (m: Ref) => `/app/work/meetings/${seg(m)}`;
export const whiteboardHref = (w: Ref) => `/app/work/whiteboards/${seg(w)}`;

/** A path with record ids and codes collapsed (`/app/work/tasks/:id`), for grouping measurements by route. */
export const routeOf = (path: string) =>
  path.replace(/[0-9A-HJKMNP-TV-Z]{26}/g, ":id").replace(/(\/app\/work\/(?:tasks|projects|docs|approvals|meetings|whiteboards)\/)[^/?#]+/, "$1:id");
