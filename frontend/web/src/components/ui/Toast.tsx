"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useT } from "@/lib/i18n/client";
import { CheckIcon, CloseIcon } from "@/components/app/icons";

export interface ToastInput {
  message: string;
  /** Shows "Hoàn tác"; called if the person clicks it before the toast goes away. */
  undo?: () => void | Promise<void>;
  /** A link to where the person fixes what the toast reports (e.g. a correction form). */
  action?: { label: string; href: string };
  /** ms before it goes away (default 5 s, 8 s with undo). */
  duration?: number;
}
interface ToastItem extends ToastInput {
  id: number;
}

const Ctx = createContext<((t: ToastInput) => void) | null>(null);

/** `const toast = useToast(); toast({ message: "Đã duyệt", undo: () => … })`. Outside the provider it is a no-op. */
export function useToast() {
  return useContext(Ctx) ?? (() => {});
}

/** Bottom-centre toasts (one stack, newest on top, at most 3), announced politely to screen readers. */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const remove = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const push = useCallback((t: ToastInput) => setItems((xs) => [{ ...t, id: next.current++ }, ...xs].slice(0, 3)), []);
  const value = useMemo(() => push, [push]);
  return (
    <Ctx.Provider value={value}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-20 z-[80] flex flex-col items-center gap-2 px-4 md:bottom-6 print:hidden">
        {items.map((t) => (
          <Toast key={t.id} item={t} onDone={() => remove(t.id)} />
        ))}
      </div>
    </Ctx.Provider>
  );
}

function Toast({ item, onDone }: { item: ToastItem; onDone: () => void }) {
  const tr = useT();
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    const ms = item.duration ?? (item.undo || item.action ? 8000 : 5000);
    const a = setTimeout(() => setLeaving(true), ms);
    const b = setTimeout(onDone, ms + 160);
    return () => {
      clearTimeout(a);
      clearTimeout(b);
    };
  }, [item, onDone]);
  return (
    <div
      role="status"
      className={`bg-ink text-surface shadow-popover pointer-events-auto flex min-h-10 max-w-md items-center gap-3 rounded-lg py-2 pl-3 pr-2 text-sm transition-all duration-150 ${leaving ? "translate-y-1 opacity-0" : "animate-rise"}`}
    >
      <span className="text-surface/70 [&_svg]:size-4" aria-hidden="true">
        <CheckIcon />
      </span>
      <span className="min-w-0 flex-1">{item.message}</span>
      {item.undo ? (
        <button
          type="button"
          onClick={async () => {
            setLeaving(true);
            await item.undo?.();
            onDone();
          }}
          className="hover:bg-surface/10 rounded-md px-2 py-1 text-sm font-medium underline-offset-2"
        >
          {tr("ui.undo")}
        </button>
      ) : null}
      {item.action ? (
        <Link href={item.action.href} onClick={onDone} className="hover:bg-surface/10 whitespace-nowrap rounded-md px-2 py-1 text-sm font-medium">
          {item.action.label}
        </Link>
      ) : null}
      <button type="button" aria-label={tr("ui.dismiss")} onClick={onDone} className="text-surface/60 hover:text-surface grid size-7 place-items-center rounded-md [&_svg]:size-4">
        <CloseIcon />
      </button>
    </div>
  );
}
