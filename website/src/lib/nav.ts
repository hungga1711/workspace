// The landing page's main navigation, shared by the server-rendered header and the client nav that highlights the
// section in view. Kept out of any "use client" module so the server side gets the array, not a client reference.
export const NAV = [
  { label: "Agent workflows", href: "/#workflows", id: "workflows" },
  { label: "Measure", href: "/#measure", id: "measure" },
  { label: "Workspace", href: "/#workplace", id: "workplace" },
  { label: "Self-hosting", href: "/#self-hosting", id: "self-hosting" },
  { label: "Docs", href: "/docs" },
] as const;
