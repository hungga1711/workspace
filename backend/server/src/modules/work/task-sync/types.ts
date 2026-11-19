import type { TaskStatus } from "../tasks.js";

export type Provider = "asana" | "clickup" | "linear" | "jira";
export const PROVIDERS: readonly Provider[] = ["asana", "clickup", "linear", "jira"];
export const PROVIDER_LABEL: Record<Provider, string> = { asana: "Asana", clickup: "ClickUp", linear: "Linear", jira: "Jira" };

/** What a connector needs to call its API: the token, plus Jira Cloud's site and the email the token belongs to. */
export interface Credentials {
  token: string;
  site?: string | null;
  email?: string | null;
}

/** An Asana project, a ClickUp list, a Linear team or a Jira project: what becomes one of our projects. */
export interface ExternalProject {
  id: string;
  name: string;
  /** Linear team key or Jira project key (ENG), shown next to the name. */
  key?: string | null;
}

/** A source task, normalised. Dates are ISO strings; status is already one of ours. */
export interface ExternalTask {
  id: string;
  /** The key people type (ENG-123, a ClickUp custom id); null when the tool has none (Asana). */
  key: string | null;
  title: string;
  url: string | null;
  projectId: string;
  assigneeEmail: string | null;
  status: TaskStatus;
  createdAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  dueAt: string | null;
  updatedAt: string | null;
}

/** Calls fetch; tests pass recorded responses instead of the network. */
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface Connector {
  provider: Provider;
  /** What the token can see, to choose from. Also the token check ("Test connection", the CLI). */
  listProjects(cred: Credentials, f: Fetcher): Promise<ExternalProject[]>;
  /** Tasks in the chosen projects updated after `since` (all of them when null), oldest change first where the API allows. */
  fetchTasks(cred: Credentials, projectIds: string[], since: Date | null, f: Fetcher): Promise<ExternalTask[]>;
}

/** The API answered with an error: the message is what the admin sees on the connection. */
export class SyncApiError extends Error {
  constructor(
    readonly provider: Provider,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "SyncApiError";
  }
}

/** Reads a JSON response, turning HTTP errors into a message an admin can act on. */
export async function readJson<T>(provider: Provider, res: Response): Promise<T> {
  if (res.ok) return (await res.json()) as T;
  const label = PROVIDER_LABEL[provider];
  if (res.status === 401 || res.status === 403) throw new SyncApiError(provider, res.status, `${label} refused the token (HTTP ${res.status}): check it and its access`);
  if (res.status === 404) throw new SyncApiError(provider, res.status, `${label} could not find that (HTTP 404): check the site address and the chosen projects`);
  if (res.status === 429) throw new SyncApiError(provider, res.status, `${label} is rate limiting (HTTP 429): the next sync will continue`);
  throw new SyncApiError(provider, res.status, `${label} answered HTTP ${res.status}`);
}

/** A date-only value (2026-11-20) is due at the end of that day in UTC; a timestamp is kept. */
export function dueFrom(date: string | null | undefined, at?: string | null): string | null {
  if (at) return new Date(at).toISOString();
  if (!date) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T17:00:00.000Z` : new Date(date).toISOString();
}

/** Names that mean "in review" or "in progress" on custom statuses and board sections. */
export function statusFromName(name: string | null | undefined, fallback: TaskStatus): TaskStatus {
  const n = (name ?? "").toLowerCase();
  if (/review|qa\b|testing|approval|verify/.test(n)) return "review";
  if (/progress|doing|started|active|wip|develop|working/.test(n)) return "in_progress";
  if (/cancel|won'?t|abandon|duplicate/.test(n)) return "cancelled";
  if (/\bdone\b|complete|closed|shipped|released|resolved/.test(n)) return "done";
  return fallback;
}
