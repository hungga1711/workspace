"use client";

import dynamic from "next/dynamic";

// Admin blocks shown only to some admins or only until done (setup checklist): their own chunks, loaded
// when the server page renders them.
export const SetupChecklist = dynamic(() => import("./SetupChecklist").then((m) => m.SetupChecklist));
// The "Needs you" list: there only when something is wrong, so it stays out of the overview's own chunk.
export const AttentionQueue = dynamic(() => import("./AttentionQueue").then((m) => m.AttentionQueue));
