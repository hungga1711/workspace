"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { useLocale, useT } from "@/lib/i18n/client";
import { cx, skeleton } from "@/lib/ui";
import { ScenePreview } from "./TemplatePreview";
import type { SceneElement, TemplateKey } from "./types";

export interface Template {
  key: TemplateKey;
  name: string;
  scene: { elements: SceneElement[] };
}

// One fetch per page and language: the picker, the empty list and "Insert template" share it.
const cache = new Map<string, Promise<Template[]>>();
/** The work module's templates in the reader's language (`GET work/whiteboards/templates`). */
function useTemplates(): Template[] | null {
  const locale = useLocale();
  const [list, setList] = useState<Template[] | null>(null);
  useEffect(() => {
    let p = cache.get(locale);
    if (!p) {
      p = api<{ templates: Template[] }>("work/whiteboards/templates").then((r) => r.templates);
      p.catch(() => cache.delete(locale));
      cache.set(locale, p);
    }
    let on = true;
    p.then((x) => on && setList(x)).catch(() => on && setList([]));
    return () => {
      on = false;
    };
  }, [locale]);
  return list;
}

const card = "border-hairline bg-surface flex w-full flex-col overflow-hidden rounded-xl border text-left transition-colors";
const picture = "bg-hover/60 relative block aspect-[16/10] w-full overflow-hidden";

function Loading() {
  return (
    <>
      {[0, 1, 2, 3].map((i) => (
        <span key={i} className={cx(card, "pointer-events-none")}>
          <span className={picture} />
          <span className="px-2.5 py-2.5">
            <span className={skeleton} />
          </span>
        </span>
      ))}
    </>
  );
}

/** Template cards that act at once (the empty list: one click starts a board from that template). */
export function TemplateCards({ onPick }: { onPick: (k: TemplateKey) => void }) {
  const list = useTemplates();
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
      {list === null ? (
        <Loading />
      ) : (
        list.map((tpl) => (
          <button key={tpl.key} type="button" onClick={() => onPick(tpl.key)} className={cx(card, "hover:border-edge")}>
            <span className={picture}>
              <ScenePreview elements={tpl.scene.elements} className="absolute inset-0 size-full p-2" />
            </span>
            <span className="truncate px-2.5 py-2 text-[13px] font-medium">{tpl.name}</span>
          </button>
        ))
      )}
    </div>
  );
}

/** A grid of template cards (a picture and a name); one is chosen. */
export function TemplateGrid({ value, onChange, label }: { value: TemplateKey; onChange: (k: TemplateKey) => void; label: string }) {
  const t = useT();
  const list = useTemplates();
  return (
    <div role="radiogroup" aria-label={label} aria-busy={list === null} className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
      {list === null ? (
        <Loading />
      ) : list.length ? (
        list.map((tpl) => (
          <button
            key={tpl.key}
            type="button"
            role="radio"
            aria-checked={value === tpl.key}
            onClick={() => onChange(tpl.key)}
            className={cx(card, value === tpl.key ? "border-ink ring-ink ring-1" : "hover:border-edge")}
          >
            <span className={picture}>
              <ScenePreview elements={tpl.scene.elements} className="absolute inset-0 size-full p-2" />
            </span>
            <span className="truncate px-2.5 py-2 text-[13px] font-medium">{tpl.name}</span>
          </button>
        ))
      ) : (
        <p className="text-ink-2 col-span-full m-0 text-sm">{t("common.loadFailed")}</p>
      )}
    </div>
  );
}
