"use client";

import { useRouter } from "next/navigation";
import { Drawer } from "./Drawer";

/**
 * The detail view: a task, approval or meeting opened from a list, board or chat shows in the side drawer
 * over the page instead of replacing it (the one detail pattern, `Drawer`, with its "Mở trang đầy đủ" and copy-link).
 * The URL still changes (shareable, back closes it). Rendered by the intercepting routes under app/app/@peek.
 */
export function Peek({ title, href, children }: { title: string; href: string; children: React.ReactNode }) {
  const router = useRouter();
  return (
    <Drawer title={title} href={href} onClose={router.back}>
      <div className="px-5 pb-8 pt-4">{children}</div>
    </Drawer>
  );
}
