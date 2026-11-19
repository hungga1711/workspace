"use client";

import dynamic from "next/dynamic";

/** Each Work tab loads only its own code (bundle budgets); the server still renders it, so nothing waits. */
export const MeetingsView = dynamic(() => import("@/components/work/MeetingsView").then((m) => m.MeetingsView));
export const ProjectList = dynamic(() => import("@/components/work/ProjectList").then((m) => m.ProjectList));
export const CalendarView = dynamic(() => import("@/components/work/CalendarView").then((m) => m.CalendarView));
export const GanttView = dynamic(() => import("@/components/work/GanttView").then((m) => m.GanttView));
export const BoardLoader = dynamic(() => import("@/components/work/BoardLoader").then((m) => m.BoardLoader));
export const TaskList = dynamic(() => import("@/components/work/TaskList").then((m) => m.TaskList));
// Bảng trắng's list: cards and the template picker only; the canvas loads on the board's own page.
export const WhiteboardList = dynamic(() => import("@/components/whiteboard/WhiteboardList").then((m) => m.WhiteboardList));
export const DocsHome = dynamic(() => import("@/components/docs/DocsHome").then((m) => m.DocsHome));
export const DriveView = dynamic(() => import("@/components/drive/DriveView").then((m) => m.DriveView));
export const OpsView = dynamic(() => import("@/components/work/OpsView").then((m) => m.OpsView));
export const AiOversightView = dynamic(() => import("@/components/work/AiOversightView").then((m) => m.AiOversightView));
export const GoalsView = dynamic(() => import("@/components/work/GoalsView").then((m) => m.GoalsView));
// The scope menu in the header (server-rendered too, so the header does not shift).
export const ScopeCrumb = dynamic(() => import("@/components/work/ScopeCrumb").then((m) => m.ScopeCrumb));
// Staff's Tiến độ › AI. Declared in this client module: next/dynamic in the server page kept it in the first load.
export const MyAi = dynamic(() => import("@/components/me/MyAi").then((m) => m.MyAi));
