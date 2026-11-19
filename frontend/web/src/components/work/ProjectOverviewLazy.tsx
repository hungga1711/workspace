"use client";

import dynamic from "next/dynamic";

// A client boundary for the lazy import: next/dynamic called from the server page still ships the Overview (charts,
// the weekly status form) with every board view; from here it is its own chunk, fetched only when Overview is open.
export const ProjectOverview = dynamic(() => import("./ProjectOverview").then((m) => m.ProjectOverview));
