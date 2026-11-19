"use client";

import dynamic from "next/dynamic";

// AI › Hỏi đáp without a connected AI is the rare case: its chat is its own chunk, not part of the page's first load
// (next/dynamic in the server page would keep it there).
export const TaskOnlyChat = dynamic(() => import("./TaskOnlyChat").then((m) => m.TaskOnlyChat));
