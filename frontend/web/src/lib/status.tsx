"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/client";

/** Personal status (emoji + text, clears at a time) and Do not disturb, from the chat module. */
export interface UserStatus {
  userId: string;
  emoji: string;
  text: string;
  clearAt: string | null;
  dndUntil: string | null;
}

const Ctx = createContext<{ get: (userId: string) => UserStatus | null; reload: () => void; set: (s: UserStatus | null) => void; me: string | null }>({
  get: () => null,
  reload: () => undefined,
  set: () => undefined,
  me: null,
});

/** A copy of the last read for this tab, so a full page load within a minute does not ask again. */
const CACHE_KEY = "wos:statuses";
const CACHE_MS = 60_000;
function cached(): { statuses: UserStatus[]; me: string } | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    const c = raw ? (JSON.parse(raw) as { at: number; statuses: UserStatus[]; me: string }) : null;
    return c && Date.now() - c.at < CACHE_MS ? c : null;
  } catch {
    return null;
  }
}

/** Loads everyone's status once and every minute (statuses change rarely; no socket needed). */
export function StatusProvider({ children }: { children: React.ReactNode }) {
  const [list, setList] = useState<UserStatus[]>([]);
  const [me, setMe] = useState<string | null>(null);
  const reload = useCallback(() => {
    api<{ statuses: UserStatus[]; me: string }>("chat/statuses")
      .then((r) => {
        setList(r.statuses);
        setMe(r.me);
        try {
          sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), ...r }));
        } catch {
          /* storage off: the next load just asks again */
        }
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    const c = cached();
    if (c) {
      setList(c.statuses);
      setMe(c.me);
    } else reload();
    const t = setInterval(reload, 60_000);
    return () => clearInterval(t);
  }, [reload]);
  const value = useMemo(() => {
    const now = Date.now();
    const map = new Map(list.filter((s) => !s.clearAt || Date.parse(s.clearAt) > now).map((s) => [s.userId, s]));
    return {
      get: (id: string) => map.get(id) ?? null,
      reload,
      me,
      set: (s: UserStatus | null) => {
        // The cached copy no longer matches: the next load reads the server again.
        try {
          sessionStorage.removeItem(CACHE_KEY);
        } catch {
          /* storage off */
        }
        setList((cur) => [...cur.filter((x) => x.userId !== (s?.userId ?? me)), ...(s ? [s] : [])]);
      },
    };
  }, [list, reload, me]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useStatus = () => useContext(Ctx);

export function isDnd(s: UserStatus | null): boolean {
  return Boolean(s?.dndUntil && Date.parse(s.dndUntil) > Date.now());
}
