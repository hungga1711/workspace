"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./client";
import { cx } from "./ui";
import { useT } from "./i18n/client";
import { BrandMark } from "@/components/ui/BrandMark";
import { LockIcon } from "@/components/app/icons";
import { deptTone, personTone } from "./identity";

export interface Person {
  userId: string;
  displayName: string;
  email?: string;
  status?: string;
  roles?: string[];
  /** 0 or absent: no photo (initials). Otherwise the version in the photo's URL, so a new photo is never served stale. */
  avatarVersion?: number;
  /** "Tên gọi" the person chose (Của tôi › Hồ sơ); chat shows it instead of the full name. */
  nickname?: string;
}

/** A member's photo, through the session proxy; long-cached because the URL changes with every new photo. */
const avatarUrl = (userId: string, version: number) => `/api/proxy/identity/members/${encodeURIComponent(userId)}/avatar?v=${version}`;

/**
 * `people` is who can be picked (assign, mention, invite to a channel); `byId`/`name` also cover disabled members so
 * authorship stays readable. `complete` is false when the shell shipped only the first page of a large workspace: then
 * `name()` resolves unknown ids lazily (batched `identity/members/summary?ids=`) and `people` holds that first page.
 */
interface Directory {
  me: string;
  people: Person[];
  byId: Map<string, Person>;
  name: (id: string) => string;
  /** Chat's name for someone: their nickname when they chose one, else `name`. Full names stay everywhere else. */
  short: (id: string) => string;
  names: Record<string, string>;
  complete: boolean;
  total: number;
}

const Ctx = createContext<Directory>({ me: "", people: [], byId: new Map(), name: (id) => id, short: (id) => id, names: {}, complete: true, total: 0 });

/**
 * Workspace members for names and avatars on every screen. The app layout ships the first page (up to 300, every
 * member of a small company); anyone else is looked up on first sight, so a 1,000-member workspace does not send
 * everyone with every page.
 */
export function DirectoryProvider({
  me,
  people,
  total,
  complete = true,
  children,
}: {
  me: string;
  people: Person[];
  total?: number;
  complete?: boolean;
  children: React.ReactNode;
}) {
  const t = useT();
  const [extra, setExtra] = useState<Person[]>([]);
  const pending = useRef(new Set<string>());
  const asked = useRef(new Set<string>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    // A new first page (navigation, refresh) restarts the lazy cache.
    setExtra([]);
    asked.current.clear();
  }, [people]);
  const value = useMemo<Directory>(() => {
    const all = extra.length ? [...people, ...extra] : people;
    const byId = new Map(all.map((p) => [p.userId, p]));
    const lookup = (id: string) => {
      if (complete || asked.current.has(id) || byId.has(id)) return;
      asked.current.add(id);
      pending.current.add(id);
      if (timer.current) return;
      // One request per render burst: every id seen in the next few milliseconds goes in the same call.
      timer.current = setTimeout(() => {
        timer.current = null;
        const ids = [...pending.current].slice(0, 500);
        pending.current.clear();
        void api<{ members: Person[] }>(`identity/members/summary?ids=${ids.join(",")}`)
          .then((r) => setExtra((x) => [...x, ...r.members.filter((m) => !x.some((y) => y.userId === m.userId))]))
          .catch(() => undefined);
      }, 20);
    };
    const name = (id: string) => {
      if (id === "system") return "workspace";
      if (id.startsWith("agent:")) return "Agent";
      const p = byId.get(id);
      if (!p) {
        lookup(id);
        return t("common.member");
      }
      return p.status === "disabled" ? t("common.deactivatedName", { name: p.displayName }) : p.displayName;
    };
    return {
      me,
      people: all.filter((p) => p.status !== "disabled"),
      byId,
      complete,
      total: total ?? all.length,
      // For rendering <@id> mentions: everyone, including people who have left.
      names: Object.fromEntries(all.map((p) => [p.userId, p.displayName])),
      name,
      short: (id) => {
        const p = byId.get(id);
        return p?.nickname && p.status !== "disabled" ? p.nickname : name(id);
      },
    };
  }, [me, people, extra, complete, total, t]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useDirectory = () => useContext(Ctx);

/**
 * Initials drawn by CSS rather than as text: a button around a face is named for the person ("Account: Lan Nguyen"),
 * and any text inside it, even hidden, would have to appear in that name (WCAG 2.5.3, label in name).
 */
export function Initials({ name }: { name: string }) {
  return <span data-initials={initials(name)} className="before:content-[attr(data-initials)]" />;
}

export function initials(name: string): string {
  if (name === "workspace") return "W";
  const parts = name.normalize("NFC").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  // Vietnamese names put the family name first and the given name last: "Trần Minh Hưng" → "TH". A one-word
  // name gives its first two letters ("Linh" → "LI"), so every avatar carries two initials.
  const first = Array.from(parts[0]!);
  const a = first[0] ?? "";
  const b = parts.length > 1 ? (Array.from(parts[parts.length - 1]!)[0] ?? "") : (first[1] ?? "");
  return (a + b).toLocaleUpperCase("vi");
}

// Every avatar shows two initials and is at least 24px: a single "H" or "T" at 20px could be anyone (`xs` = `sm`).
const SIZES = {
  xs: "size-6 text-[11px] tracking-[-0.02em]",
  /** A row of faces in a stack (AvatarStack): a size smaller than sm. */
  stack: "size-6 text-[11px] tracking-[-0.03em]",
  sm: "size-6 text-[11px] tracking-[-0.02em]",
  md: "size-8 text-xs",
  lg: "size-10 text-sm",
  xl: "size-16 text-xl",
} as const;
type Size = keyof typeof SIZES;

/**
 * Identity tone (lib/identity.ts): white initials on the person's own solid hue by id, or their department's when the
 * caller knows it. Faces in colour are what make a list of people scannable at a glance (grey
 * faces read as one wall of text).
 */
// Pastel faces (the hue's wash with its deep tone for the initials), still one colour per person.
const toneClass = (seed: string, dept?: string | null) => {
  const tone = dept ? deptTone(dept) : personTone(seed);
  return `${tone.wash} text-ink`;
};
const face = "relative inline-grid shrink-0 select-none place-items-center rounded-full font-medium";
const systemFace = "border-hairline bg-surface text-ink border";

/** An avatar drawn from a name (no directory lookup): guests, invites, audit rows. `seed` keeps the tint stable. */
export function AvatarFace({
  name,
  seed,
  size = "md",
  system,
  dept,
  className,
}: {
  name: string;
  seed?: string;
  size?: Size;
  system?: boolean;
  dept?: string | null;
  className?: string;
}) {
  return (
    <span className={cx(face, SIZES[size], system ? systemFace : toneClass(seed ?? name, dept), className)} aria-hidden="true" title={name}>
      {system ? <BrandMark variant="plain" className="size-[62%]" /> : <Initials name={name} />}
    </span>
  );
}

/**
 * The one avatar: a member by id, their photo when they have one (initials while it loads or if it fails). `dept`
 * tints the initials in the department's colour (team views); hover shows the full name.
 */
export function Avatar({ id, name, size = "md", online, dept, className }: { id: string; name?: string; size?: Size; online?: boolean; dept?: string | null; className?: string }) {
  const dir = useDirectory();
  const label = name ?? dir.name(id);
  const system = id === "system";
  const version = system ? 0 : (dir.byId.get(id)?.avatarVersion ?? 0);
  const [broken, setBroken] = useState(0);
  const photo = version > 0 && broken !== version;
  return (
    <span className={cx(face, SIZES[size], system ? systemFace : toneClass(id, dept), className)} aria-hidden="true" title={label}>
      {system ? <BrandMark variant="plain" className="size-[62%]" /> : <Initials name={label} />}
      {photo ? (
        // A small, already-sized photo behind the session proxy: a plain img (next/image would re-encode it).
        <img
          src={avatarUrl(id, version)}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setBroken(version)}
          className="absolute inset-0 size-full rounded-full object-cover"
        />
      ) : null}
      {online !== undefined ? <span className={cx("ring-surface absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full ring-2", online ? "bg-ok" : "bg-hairline")} /> : null}
    </span>
  );
}

export function AvatarStack({ ids, max = 4 }: { ids: string[]; max?: number }) {
  const shown = ids.slice(0, max);
  return (
    // Faces touch but do not overlap: the white ring separates them and every face keeps its initials whole.
    <span className="flex">
      {shown.map((id) => (
        <Avatar key={id} id={id} size="stack" className="ring-surface ring-2" />
      ))}
      {ids.length > max ? (
        <span className="bg-selected text-ink-soft ring-surface grid h-6 min-w-6 place-items-center rounded-full px-1.5 text-[11px] font-semibold tabular-nums ring-2">
          +{ids.length - max}
        </span>
      ) : null}
    </span>
  );
}

// Group/channel pictures: a square tile in the channel's identity colour with its first letter in white.
const CHANNEL_SIZES = {
  xs: "size-6 text-xs rounded-md",
  sm: "size-6 text-xs rounded-md",
  md: "size-8 text-sm rounded-md",
  lg: "size-10 text-base rounded-lg",
  xl: "size-12 text-xl rounded-lg",
} as const;

/**
 * The picture of a conversation: the other person's avatar for a direct message, otherwise a
 * flat tile with the channel's first letter in the channel's identity colour.
 */
export function ChannelAvatar({
  c,
  size = "md",
  className,
}: {
  c: { kind: string; name: string | null; dmUserId?: string | null };
  size?: keyof typeof CHANNEL_SIZES;
  className?: string;
}) {
  if (c.kind === "dm") return <Avatar id={c.dmUserId ?? ""} size={size} className={className} />;
  // Channels and groups are a neutral "#" tile: colour stays for people, a channel reads
  // the same "#" as in the sidebar; a private channel is a lock in that tile.
  return (
    <span aria-hidden="true" className={cx("bg-selected text-ink-soft inline-grid shrink-0 select-none place-items-center font-semibold", CHANNEL_SIZES[size], className)}>
      {c.kind === "private" ? <LockIcon className="size-[1em]" /> : "#"}
    </span>
  );
}
