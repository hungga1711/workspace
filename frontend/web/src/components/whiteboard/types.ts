/**
 * The whiteboard REST contract (work module, `/api/work/whiteboards`) as the web uses it. Element shapes are the
 * editor's own (Excalidraw scene JSON); this module types only the fields our code reads, so it stays free of the
 * editor package and can be imported from the list and the server page.
 */
export type Visibility = "workspace" | "project" | "private";
/** What a board's or folder's access comes to, in one word (the share dialog shows the detail). */
export type AccessSummary = Visibility | "restricted";

export interface WhiteboardSummary {
  id: string;
  code: string;
  title: string;
  projectId: string | null;
  projectName: string | null;
  /** null: the top level. */
  folderId: string | null;
  /** Receives its folder's access (plus its own grants). */
  inherit: boolean;
  ownerId: string;
  visibility: AccessSummary;
  updatedAt: string;
  updatedBy: string | null;
  /** A small SVG of the board (≤ 200 KB), shown as an <img>; null until the first save. */
  thumbnail: string | null;
  canEdit: boolean;
  canManage: boolean;
}

/** A sticky turned into a task: the badge under the sticky shows the task's code and status. */
export interface WbLink {
  elementId: string;
  taskId: string;
  code: string;
  status: string;
  title: string;
}

/** The fields of an element our code reads; the rest travels untouched. */
export interface SceneElement {
  id: string;
  type: string;
  version: number;
  versionNonce: number;
  isDeleted: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Fractional index: the stacking order. */
  index?: string | null;
  updated?: number;
  text?: string;
  originalText?: string;
  containerId?: string | null;
  boundElements?: readonly { id: string; type: string }[] | null;
  backgroundColor?: string;
  strokeColor?: string;
  link?: string | null;
  fileId?: string | null;
  customData?: Record<string, unknown>;
  [key: string]: unknown;
}

/** An image on the board: the bytes live in work files (`fileId`), never as a data URL in the scene. */
export interface SceneFile {
  id: string;
  mimeType: string;
  fileId: string;
}

export interface Scene {
  elements: SceneElement[];
  appState: { viewBackgroundColor?: string; gridModeEnabled?: boolean };
  files: Record<string, SceneFile>;
}

export interface Whiteboard extends WhiteboardSummary {
  /** The folders from the top level down to the board's, for the breadcrumb. */
  path: { id: string; name: string }[];
  scene: Scene;
  sceneVersion: number;
  links: WbLink[];
}

export const TEMPLATES = ["blank", "brainstorm", "retro", "kanban", "flowchart", "user-journey", "swot", "meeting"] as const;
export type TemplateKey = (typeof TEMPLATES)[number];

/** A folder as the list shows it; `parentId` is null at the top level and for folders whose parent the reader cannot see. */
export interface WbFolder {
  id: string;
  name: string;
  parentId: string | null;
  ownerId: string;
  inherit: boolean;
  visibility: AccessSummary;
  /** Boards in it the reader can open. */
  boards: number;
  canEdit: boolean;
  canManage: boolean;
}

export interface WbFolders {
  folders: WbFolder[];
  rootBoards: number;
  total: number;
  canCreate: boolean;
}

export type Role = "view" | "edit" | "manage";
export type SubjectType = "everyone" | "department" | "user";
export interface WbGrant {
  subjectType: SubjectType;
  subjectId: string;
  role: Role;
}

/** `GET …/access`: own grants, what is inherited (with the folder it comes from) and who else manages. */
export interface WbAccess {
  ownerId: string;
  inherit: boolean;
  grants: WbGrant[];
  inherited: (WbGrant & { from: string; fromName: string })[];
  managers: string[];
  visibility: AccessSummary;
  canManage: boolean;
}
