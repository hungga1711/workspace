"use client";

import dynamic from "next/dynamic";

/** The Reviews tab loads its list (and the cards) only when someone opens it. */
export const ProjectReviews = dynamic(() => import("./ProjectReviews").then((m) => m.ProjectReviews), { ssr: false });
