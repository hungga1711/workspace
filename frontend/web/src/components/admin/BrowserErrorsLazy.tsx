"use client";

import dynamic from "next/dynamic";

// The error browser (groups, occurrences, resolved stacks) is its own chunk: only an admin tracing a code loads it.
// Declared in a client module because next/dynamic in the server page kept it in the page's first load.
export const BrowserErrors = dynamic(() => import("@/components/admin/BrowserErrors").then((m) => m.BrowserErrors));
