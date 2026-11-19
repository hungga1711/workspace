"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cx, menuLabel, popover, textarea } from "@/lib/ui";

/**
 * The instruction of an AI step, written as a sentence with the things it refers to shown as chips: "Write a reply
 * to [The task] in the tone of [Answer: Tone], using [Result: 1 · Research]". Typing @ (or pressing Insert) opens a
 * menu of what can be referred to at this step. People never see the `{{steps.research}}` the server stores: the
 * value in and out of this component is that text, the chips are only how it is drawn.
 *
 * A contenteditable, kept small: text nodes, line breaks and chips (non-editable spans carrying `data-token`). The DOM
 * is rebuilt only when the value changes from outside (another step renamed, a template loaded), so the caret stays
 * where the person is typing.
 */
export interface Token {
  /** What goes between the braces: "task", "steps.research", "input.tone". */
  name: string;
  label: string;
  group: "task" | "step" | "input" | "more";
  /** The group's heading in the menu. */
  heading: string;
}

const TOKEN = /\{\{\s*([a-zA-Z_]+(?:\.[a-zA-Z0-9_-]+)?)\s*\}\}/g;
const CHIP = "mx-px inline-block max-w-full select-none truncate rounded-md px-1.5 align-baseline text-[13px] font-medium leading-[1.45] ring-1 ring-inset";
const TONE: Record<Token["group"] | "missing", string> = {
  task: "bg-sky-wash text-sky-text ring-sky-text/15",
  step: "bg-violet-wash text-violet-text ring-violet-text/15",
  input: "bg-tangerine-wash text-tangerine-text ring-tangerine-text/15",
  more: "bg-hover text-ink-soft ring-edge",
  missing: "bg-block-wash text-block ring-block/20",
};

/** The stored text of what is in the editor. A lone trailing <br> is the browser's own line-end marker, not a line. */
function serialize(root: HTMLElement): string {
  let out = "";
  const walk = (node: Node) => {
    for (const n of node.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) out += (n.nodeValue ?? "").replace(/​/g, "");
      else if (n instanceof HTMLElement) {
        if (n.dataset.token) out += `{{${n.dataset.token}}}`;
        else if (n.tagName === "BR") out += "\n";
        else {
          // A block the browser made on its own (a pasted paragraph): its own line.
          if (out && !out.endsWith("\n")) out += "\n";
          walk(n);
        }
      }
    }
  };
  walk(root);
  return root.lastChild instanceof HTMLElement && root.lastChild.tagName === "BR" ? out.slice(0, -1) : out;
}

export function PromptEditor({
  value,
  onChange,
  tokens,
  drawn,
  label,
  placeholder,
  maxLength,
  missing,
  insertLabel,
  hint,
  quick = 3,
}: {
  value: string;
  onChange: (v: string) => void;
  /** What the menu offers at this step. */
  tokens: Token[];
  /** Everything that draws as a chip: the offered ones and those only older workflows still use. Default: `tokens`. */
  drawn?: Token[];
  label: string;
  placeholder: string;
  maxLength: number;
  /** What a chip says when the thing it refers to is gone (a deleted step, a removed question). */
  missing: string;
  insertLabel: string;
  hint: string;
  /** How many of the most likely references get their own button under the field. */
  quick?: number;
}) {
  const root = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const all = drawn ?? tokens;
  const byName = useMemo(() => new Map(all.map((x) => [x.name, x])), [all]);
  const labels = all.map((x) => `${x.name}=${x.label}`).join("|");

  const chip = useCallback(
    (name: string) => {
      const known = byName.get(name);
      const el = document.createElement("span");
      el.dataset.token = name;
      el.contentEditable = "false";
      el.className = cx(CHIP, TONE[known?.group ?? "missing"]);
      el.textContent = known?.label ?? missing;
      return el;
    },
    [byName, missing],
  );

  // Only names this editor knows how to draw become chips; anything else in braces stays as the person typed it.
  const isRef = useCallback((name: string) => byName.has(name) || name.startsWith("steps.") || name.startsWith("input."), [byName]);

  const build = useCallback(
    (text: string) => {
      const el = root.current;
      if (!el) return;
      el.replaceChildren();
      const lines = (s: string) => {
        s.split("\n").forEach((part, i) => {
          if (i) el.append(document.createElement("br"));
          if (part) el.append(document.createTextNode(part));
        });
      };
      let at = 0;
      for (const m of text.matchAll(TOKEN)) {
        if (!isRef(m[1]!)) continue;
        lines(text.slice(at, m.index));
        el.append(chip(m[1]!));
        at = m.index + m[0].length;
      }
      lines(text.slice(at));
      // A text ending in a line break needs the browser's marker to show the empty last line.
      if (text.endsWith("\n")) el.append(document.createElement("br"));
    },
    [chip, isRef],
  );

  // From outside: a different text (not what the DOM already says) rebuilds; renamed references only relabel.
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    if (serialize(el) !== value) build(value);
    else
      for (const c of el.querySelectorAll<HTMLElement>("[data-token]")) {
        const known = byName.get(c.dataset.token!);
        const text = known?.label ?? missing;
        if (c.textContent !== text) c.textContent = text;
        c.className = cx(CHIP, TONE[known?.group ?? "missing"]);
      }
    // `labels` stands for the tokens' names and labels.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, labels, missing]);

  const emit = () => {
    const el = root.current;
    if (!el) return;
    const text = serialize(el);
    onChange(text.length > maxLength ? text.slice(0, maxLength) : text);
  };

  // ── The menu ───────────────────────────────────────────────────────────────────────────────────────
  // Open with what was typed after "@" (`at` is where the "@" sits, so picking replaces it), or from the Insert button.
  const [menu, setMenu] = useState<{ query: string; x: number; y: number; at: { node: Text; from: number; to: number } | null } | null>(null);
  const [active, setActive] = useState(0);
  const saved = useRef<Range | null>(null);
  const shown = useMemo(() => {
    const q = menu?.query.trim().toLowerCase() ?? "";
    return q ? tokens.filter((x) => x.label.toLowerCase().includes(q)) : tokens;
  }, [menu?.query, tokens]);
  useEffect(() => setActive(0), [menu?.query]);

  const caret = (): Range | null => {
    const sel = window.getSelection();
    const el = root.current;
    if (!sel?.rangeCount || !el) return null;
    const r = sel.getRangeAt(0);
    return el.contains(r.startContainer) ? r : null;
  };
  const place = (r: Range | null) => {
    const box = wrap.current?.getBoundingClientRect();
    const rect = r?.getClientRects()[0] ?? r?.getBoundingClientRect();
    if (!box || !rect || (!rect.width && !rect.height && !rect.top)) return { x: 8, y: (root.current?.offsetHeight ?? 40) + 4 };
    return { x: Math.max(0, Math.min(rect.left - box.left, box.width - 288)), y: rect.bottom - box.top + 6 };
  };

  const detect = () => {
    const r = caret();
    if (!r || !r.collapsed || r.startContainer.nodeType !== Node.TEXT_NODE) return setMenu(null);
    const node = r.startContainer as Text;
    const before = (node.nodeValue ?? "").slice(0, r.startOffset);
    const m = /(?:^|[\s(])@([^\s@]{0,24})$/.exec(before);
    if (!m) return setMenu(null);
    const from = r.startOffset - m[1]!.length - 1;
    const mark = document.createRange();
    mark.setStart(node, from);
    mark.setEnd(node, from + 1);
    setMenu({ query: m[1]!, ...place(mark), at: { node, from, to: r.startOffset } });
  };

  const pick = (name: string) => {
    const el = root.current;
    if (!el) return;
    el.focus();
    const sel = window.getSelection()!;
    let r: Range;
    if (menu?.at && el.contains(menu.at.node)) {
      r = document.createRange();
      r.setStart(menu.at.node, menu.at.from);
      r.setEnd(menu.at.node, Math.min(menu.at.to, menu.at.node.length));
    } else if (saved.current && el.contains(saved.current.startContainer)) r = saved.current;
    else {
      r = document.createRange();
      r.selectNodeContents(el);
      r.collapse(false);
      // After the browser's line-end marker would be a new line: go before it.
      if (el.lastChild instanceof HTMLElement && el.lastChild.tagName === "BR") r.setStartBefore(el.lastChild);
      r.collapse(true);
    }
    r.deleteContents();
    const node = chip(name);
    const space = document.createTextNode(" ");
    r.insertNode(space);
    r.insertNode(node);
    const after = document.createRange();
    after.setStart(space, 1);
    after.collapse(true);
    sel.removeAllRanges();
    sel.addRange(after);
    saved.current = after;
    setMenu(null);
    emit();
  };

  const openMenu = () => {
    const r = caret() ?? saved.current;
    setMenu({ query: "", ...place(r && root.current?.contains(r.startContainer) ? r : null), at: null });
    root.current?.focus();
  };

  /**
   * Typed and pasted text goes in through the browser's own editing commands: they keep the caret right around line
   * breaks (placing it by hand after a <br> lands before it in Chrome) and they are what undo steps back through.
   */
  const insertText = (text: string) => {
    if (!caret()) return;
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    lines.forEach((line, i) => {
      if (i) document.execCommand("insertLineBreak");
      if (line) document.execCommand("insertText", false, line);
    });
    // A pasted instruction that names references the written way (copied from another workflow) shows them as chips.
    const el = root.current;
    if (el && /\{\{[^{}]+\}\}/.test(text)) {
      build(serialize(el));
      const end = document.createRange();
      end.selectNodeContents(el);
      end.collapse(false);
      if (el.lastChild instanceof HTMLElement && el.lastChild.tagName === "BR") end.setStartBefore(el.lastChild);
      end.collapse(true);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(end);
    }
    emit();
  };

  const quickTokens = useMemo(() => {
    const steps = tokens.filter((x) => x.group === "step");
    const first = [...tokens.filter((x) => x.group === "task"), ...steps.slice(-2).reverse(), ...tokens.filter((x) => x.group === "input")];
    return first.slice(0, quick);
  }, [tokens, quick]);

  const empty = !value;
  let heading = "";
  return (
    <div ref={wrap} className="relative grid min-w-0 gap-2">
      <div className="relative min-w-0">
        <div
          ref={root}
          role="textbox"
          aria-multiline="true"
          aria-label={label}
          contentEditable
          suppressContentEditableWarning
          spellCheck
          className={cx(textarea, "max-h-[28rem] min-h-28 overflow-y-auto whitespace-pre-wrap break-words text-sm/[1.65]")}
          onInput={() => {
            emit();
            detect();
          }}
          onKeyDown={(e) => {
            if (menu && shown.length) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => (a + (e.key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length);
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                pick(shown[Math.min(active, shown.length - 1)]!.name);
                return;
              }
            }
            if (menu && e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setMenu(null);
              return;
            }
            // One kind of line break, whatever the browser would have made (a <div>, a <p>).
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              insertText("\n");
            }
          }}
          onKeyUp={(e) => {
            if (["ArrowLeft", "ArrowRight", "Home", "End", "Backspace"].includes(e.key)) detect();
          }}
          onClick={detect}
          onPaste={(e) => {
            // Words only: pasted formatting has no meaning in an instruction.
            e.preventDefault();
            insertText(e.clipboardData.getData("text/plain"));
          }}
          onDrop={(e) => e.preventDefault()}
          onBlur={() => {
            saved.current = caret()?.cloneRange() ?? saved.current;
            // Left for the menu's own click to land first.
            setTimeout(() => {
              if (!wrap.current?.contains(document.activeElement)) setMenu(null);
            }, 120);
          }}
        />
        {empty ? (
          <p aria-hidden="true" className="text-ink-2 pointer-events-none absolute inset-x-3 top-2 m-0 text-sm/[1.65]">
            {placeholder}
          </p>
        ) : null}
      </div>

      {menu ? (
        <div
          role="listbox"
          aria-label={insertLabel}
          className={cx(popover, "absolute z-30 max-h-72 w-72 max-w-[calc(100vw-2rem)] overflow-y-auto")}
          style={{ left: menu.x, top: menu.y }}
        >
          {shown.length ? (
            shown.map((x, i) => {
              const head = x.heading !== heading ? (heading = x.heading) : null;
              return (
                <div key={x.name}>
                  {head ? <p className={menuLabel}>{head}</p> : null}
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === active}
                    // The editor keeps its caret: the choice is made on mouse down, before focus would move.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      pick(x.name);
                    }}
                    onMouseEnter={() => setActive(i)}
                    className={cx("flex min-h-9 w-full min-w-0 items-center rounded-lg px-2 text-left", i === active && "bg-hover")}
                  >
                    <span className={cx(CHIP, TONE[x.group], "mx-0")}>{x.label}</span>
                  </button>
                </div>
              );
            })
          ) : (
            <p className="text-ink-2 m-0 px-2 py-2 text-[13px]">—</p>
          )}
        </div>
      ) : null}

      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={openMenu}
          className="bg-surface ring-edge hover:bg-hover text-ink inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-[13px] font-medium ring-1 ring-inset max-md:h-8"
        >
          <span aria-hidden="true" className="text-ink-2">
            @
          </span>
          {insertLabel}
        </button>
        {quickTokens.map((x) => (
          <button
            key={x.name}
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => pick(x.name)}
            className={cx(CHIP, TONE[x.group], "mx-0 h-7 cursor-pointer leading-7 hover:brightness-95 max-md:h-8 max-md:leading-8")}
          >
            + {x.label}
          </button>
        ))}
        <span className="text-ink-2 min-w-0 text-xs">{hint}</span>
      </div>
    </div>
  );
}

/** An instruction as one plain line (a step's summary when it is closed): references read as their labels. */
export function plainPrompt(text: string, tokens: Token[], missing: string): string {
  const byName = new Map(tokens.map((x) => [x.name, x.label]));
  return text
    .replace(TOKEN, (whole, name: string) => (byName.has(name) ? `[${byName.get(name)}]` : name.startsWith("steps.") || name.startsWith("input.") ? `[${missing}]` : `[${name}]`))
    .replace(/\s+/g, " ")
    .trim();
}
