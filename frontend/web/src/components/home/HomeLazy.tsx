"use client";

import dynamic from "next/dynamic";

// Home pieces most people never see (the first-week checklist, the push opt-in): a client boundary so the server page
// fetches them as their own chunks only when it renders them.
export const StartChecklist = dynamic(() => import("./StartChecklist").then((m) => m.StartChecklist));
export const PushPrompt = dynamic(() => import("./PushPrompt").then((m) => m.PushPrompt), { ssr: false });
