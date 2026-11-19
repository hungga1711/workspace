"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { Avatar } from "@/lib/people";
import { useStatus } from "@/lib/status";
import { PersonTrigger } from "./PersonTrigger";

interface Profile {
  title: string | null;
  department: string | null;
}

/**
 * A direct message's header: the person's face and name, with their job and status under it, the
 * same facts the hover card opens with. Clicking anywhere opens that card. The job comes from the employee record,
 * fetched once; the directory only knows names.
 */
export function DmHeading({ userId, name }: { userId: string; name: string }) {
  const [p, setP] = useState<Profile | null>(null);
  const status = useStatus().get(userId);
  useEffect(() => {
    let alive = true;
    api<Profile>(`employee/employees/${encodeURIComponent(userId)}`)
      .then((r) => alive && setP(r))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [userId]);
  const job = [p?.title, p?.department].filter(Boolean).join(" · ");
  const statusText = [status?.emoji, status?.text].filter(Boolean).join(" ");
  const sub = [job, statusText].filter(Boolean).join(" · ");
  return (
    <PersonTrigger userId={userId} className="hover:bg-hover -mx-1.5 flex min-w-0 max-w-[55%] shrink-0 items-center gap-2.5 rounded-md px-1.5 py-1 text-left">
      <Avatar id={userId} size="md" />
      <span className="min-w-0">
        <span className="text-ink block truncate text-[15px]/5 font-semibold">{name}</span>
        {sub ? <span className="text-ink-2 block truncate text-xs/4">{sub}</span> : null}
      </span>
    </PersonTrigger>
  );
}
