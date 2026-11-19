"use client";

import dynamic from "next/dynamic";

// Its own chunk: only an admin connecting Asana, ClickUp, Linear or Jira loads it.
export const TaskSyncAdmin = dynamic(() => import("@/components/admin/TaskSyncAdmin").then((m) => m.TaskSyncAdmin));
