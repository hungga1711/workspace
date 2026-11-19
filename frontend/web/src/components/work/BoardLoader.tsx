"use client";

import { useEffect } from "react";
import Board, { type BoardData } from "./Board";
import type { Project } from "./types";

/**
 * Việc & dự án opens on a project's board, so the board renders on the server with its cards
 * (no "loading" step after the page arrives); dnd-kit only wires up drag and drop on hydration.
 */
export function BoardLoader({
  initial,
  projects,
  lead,
  views,
}: {
  initial: BoardData;
  projects: Project[];
  /** The page's scope title (Việc ▾) and view switch, drawn in the board's one toolbar row. */
  lead?: React.ReactNode;
  views?: React.ReactNode;
}) {
  // Việc & dự án opens on the last board viewed (read by the server from this cookie).
  useEffect(() => {
    document.cookie = `wos_board=${initial.project.id}; path=/; max-age=31536000; samesite=lax`;
  }, [initial.project.id]);
  return <Board initial={initial} projects={projects} lead={lead} views={views} />;
}
