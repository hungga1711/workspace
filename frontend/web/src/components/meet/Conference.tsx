"use client";

import { ReactionLayer, ReactionPicker, useMyHand, useReactions } from "./Reactions";
import {
  RoomAudioRenderer,
  useChat,
  useConnectionState,
  useIsRecording,
  useMediaDeviceSelect,
  useParticipantAttribute,
  useParticipants,
  useRoomContext,
  useStartAudio,
  useTrackToggle,
  useTracks,
} from "@livekit/components-react";
import { ConnectionState, Track, type Participant } from "livekit-client";
import { useEffect, useId, useRef, useState } from "react";
import { api } from "@/lib/client";
import { useT } from "@/lib/i18n/client";
import { btn, btnPrimary, btnSm, cx, menuItem, menuLabel, popover } from "@/lib/ui";
import { Picker } from "@/components/ui/Picker";
import {
  ChatIcon,
  HandIcon,
  ChevronDownIcon,
  CloseIcon,
  CopyIcon,
  MicIcon,
  MicOffIcon,
  MoreIcon,
  PhoneOffIcon,
  RecordIcon,
  ScreenIcon,
  UsersIcon,
  VideoIcon,
  VideoOffIcon,
} from "@/components/app/icons";
import { Menu } from "@/components/ui/Menu";
import { BrandMark } from "@/components/ui/BrandMark";
import { clock, displayName, kindOf, Monogram } from "./parts";
import { Stage, type Layout } from "./Stage";
import type { GuestAccess, MeetRoomInfo } from "./types";

interface MemberSide {
  me: string;
  room: MeetRoomInfo;
  recordingEnabled: boolean;
}

type Panel = "chat" | "people";

/** The call: a header with time and layout, the stage, a dock of labelled controls, and a side panel. */
/** `oneToOne`: a call with one person, not a meeting: no invite link, no renaming, "End" instead of "Leave". */
export function Conference({ code, title, member, oneToOne = false }: { code: string; title: string; member: MemberSide | null; oneToOne?: boolean }) {
  const t = useT();
  const [panel, setPanel] = useState<Panel | null>(null);
  const [layout, setLayout] = useState<Layout>("grid");
  const [pinned, setPinned] = useState<string | null>(null);
  const state = useConnectionState();
  const recording = useIsRecording();
  const participants = useParticipants();
  const { chatMessages, send } = useChat();
  const [seen, setSeen] = useState(0);
  const unread = panel === "chat" ? 0 : chatMessages.length - seen;
  useEffect(() => {
    if (panel === "chat") setSeen(chatMessages.length);
  }, [panel, chatMessages.length]);

  const reactions = useReactions();
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  );
  // A pin whose person left falls back to the automatic choice.
  const pinValid = pinned && tracks.some((r) => `${r.participant.identity}:${r.source}` === pinned) ? pinned : null;

  // Members see guests waiting in the lobby (polled; a handful of rows per meeting).
  const [waiting, setWaiting] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    if (!member) return;
    let alive = true;
    const load = () =>
      api<{ waiting: { id: string; name: string }[] }>(`work/meet/rooms/${code}/lobby`)
        .then((r) => alive && setWaiting(r.waiting))
        .catch(() => undefined);
    void load();
    const timer = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [member, code]);
  const decide = async (id: string, admit: boolean) => {
    setWaiting((w) => w.filter((g) => g.id !== id));
    await api(`work/meet/rooms/${code}/lobby/${id}`, { method: "POST", body: { admit } }).catch(() => undefined);
  };

  return (
    <div className="bg-ground flex h-full min-h-0 flex-col">
      <Header
        title={title}
        code={code}
        canRename={!oneToOne && !!member && member.room.createdBy === member.me}
        shareable={!oneToOne}
        participants={participants}
        recording={recording}
        layout={layout}
        setLayout={(l) => (setLayout(l), setPinned(null))}
      />

      {state === ConnectionState.Reconnecting || state === ConnectionState.Connecting ? (
        <p role="status" className="bg-warn-wash text-warn mx-auto mb-2 rounded-lg px-3 py-1.5 text-center text-sm">
          {state === ConnectionState.Connecting ? t("meet.connecting") : t("meet.reconnecting")}
        </p>
      ) : null}

      {member && waiting.length ? (
        <div className="pointer-events-none fixed right-4 top-16 z-30 grid w-[min(100%-2rem,340px)] gap-2">
          {waiting.slice(0, 3).map((g) => (
            <div key={g.id} role="alert" className="bg-surface border-hairline shadow-popover pointer-events-auto grid gap-3 rounded-xl border p-3">
              <div className="flex items-center gap-2.5">
                <Monogram name={g.name} className="size-8 text-xs" />
                <p className="m-0 min-w-0 flex-1 text-sm font-medium">{t("meet.asksToJoin", { name: g.name })}</p>
              </div>
              <div className="flex justify-end gap-2">
                <button type="button" className={cx(btn, btnSm)} onClick={() => void decide(g.id, false)}>
                  {t("meet.deny")}
                </button>
                <button type="button" className={cx(btnPrimary, btnSm)} onClick={() => void decide(g.id, true)}>
                  {t("meet.admit")}
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 gap-3 px-3 md:px-4">
        <section aria-label={title} className="relative flex min-h-0 min-w-0 flex-1">
          <Stage tracks={tracks} layout={layout} pinned={pinValid} setPinned={setPinned} alone={!oneToOne && participants.length === 1} code={code} />
          <ReactionLayer bursts={reactions.bursts} />
        </section>

        {panel ? (
          <aside className="bg-surface border-hairline fixed inset-0 z-40 flex min-h-0 flex-col md:static md:z-auto md:w-[360px] md:rounded-xl md:border">
            <header className="border-hairline min-h-13 flex items-center gap-2 border-b px-4">
              <h2 className="m-0 flex-1 text-base font-semibold">{panel === "chat" ? t("meet.chat") : `${t("meet.people")} (${participants.length})`}</h2>
              <button type="button" className="text-ink-2 hover:bg-hover grid size-8 place-items-center rounded-md" aria-label={t("common.close")} onClick={() => setPanel(null)}>
                <CloseIcon className="size-4" />
              </button>
            </header>
            {panel === "chat" ? (
              <ChatPanel messages={chatMessages} send={send} />
            ) : (
              <PeoplePanel participants={participants} member={member} code={code} waiting={waiting} decide={decide} />
            )}
          </aside>
        ) : null}
      </div>

      <Dock
        panel={panel}
        setPanel={setPanel}
        unread={unread}
        people={participants.length}
        waiting={waiting.length}
        recording={recording}
        canRecord={!!member?.recordingEnabled}
        code={code}
        onReact={reactions.react}
        leaveLabel={oneToOne ? t("call.end") : t("meet.leave")}
      />
      <RoomAudioRenderer />
    </div>
  );
}

function Header({
  title: initialTitle,
  code,
  canRename,
  participants,
  recording,
  layout,
  setLayout,
  shareable,
}: {
  title: string;
  code: string;
  canRename: boolean;
  shareable: boolean;
  participants: Participant[];
  recording: boolean;
  layout: Layout;
  setLayout: (l: Layout) => void;
}) {
  const t = useT();
  // Whoever started the meeting can give it a real name ("Họp nhanh lúc 09:30" says little afterwards).
  const [title, setTitle] = useState(initialTitle);
  const [renaming, setRenaming] = useState(false);
  const rename = async (next: string) => {
    setRenaming(false);
    const v = next.trim();
    if (!v || v === title) return;
    setTitle(v);
    await api(`work/meet/rooms/${code}`, { method: "PATCH", body: { title: v } }).catch(() => setTitle(title));
  };
  // Meeting length counts from whoever joined first, so everyone sees the same time.
  const start = Math.min(...participants.map((p) => p.joinedAt?.getTime() ?? Date.now()));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(`${location.origin}/meet/${code}`).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  const seg = (l: Layout, label: string) => (
    <button
      type="button"
      aria-pressed={layout === l}
      onClick={() => setLayout(l)}
      className={cx("min-h-7 rounded-sm px-2.5 text-xs font-medium transition-colors", layout === l ? "bg-selected text-ink" : "text-ink-2 hover:text-ink")}
    >
      {label}
    </button>
  );
  return (
    <header className="flex min-h-14 items-center gap-3 px-4">
      <BrandMark className="hidden sm:inline-block" />
      <div className="min-w-0 flex-1">
        {renaming ? (
          <input
            autoFocus
            defaultValue={title}
            aria-label={t("meet.renameLabel")}
            maxLength={200}
            className="border-hairline bg-surface text-ink m-0 w-full max-w-[420px] rounded-md border px-2 py-0.5 text-base font-semibold"
            onBlur={(e) => void rename(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void rename(e.currentTarget.value);
              if (e.key === "Escape") setRenaming(false);
            }}
          />
        ) : canRename ? (
          <h1 className="m-0 truncate text-base/5 font-semibold">
            <button type="button" className="hover:bg-hover -mx-1 max-w-full truncate rounded px-1 text-left" title={t("meet.rename")} onClick={() => setRenaming(true)}>
              {title}
            </button>
          </h1>
        ) : (
          <h1 className="m-0 truncate text-base/5 font-semibold">{title}</h1>
        )}
        <p className="text-ink-2 m-0 flex items-center gap-1.5 text-xs">
          <span className="font-mono tabular-nums" title={t("meet.duration")}>
            {clock(now - start)}
          </span>
          <span aria-hidden="true">·</span>
          <span>{t("meet.peopleCount", { count: participants.length })}</span>
          {recording ? (
            <span className="text-block ml-1 flex items-center gap-1 font-semibold">
              <span aria-hidden="true" className="bg-block size-2 animate-pulse rounded-full" />
              {t("meet.recording")}
            </span>
          ) : null}
        </p>
      </div>
      <div role="group" aria-label={t("meet.layout")} className="bg-surface border-hairline hidden gap-0.5 rounded-lg border p-0.5 md:flex">
        {seg("grid", t("meet.layoutGrid"))}
        {seg("speaker", t("meet.layoutSpeaker"))}
      </div>
      {shareable ? (
        <button type="button" className={cx(btn, btnSm, "min-h-8")} onClick={() => void copy()}>
          <CopyIcon className="size-3.5" />
          <span aria-live="polite" className="hidden sm:inline">
            {copied ? t("meet.linkCopied") : t("meet.copyLink")}
          </span>
          <span className="sr-only sm:hidden">{t("meet.copyLink")}</span>
        </button>
      ) : null}
    </header>
  );
}

/* Dock buttons: icon over a short label on desktop, icon only on phones. Never pill-shaped. */
const dockBtn =
  "relative flex h-12 min-w-12 flex-col items-center justify-center gap-0.5 rounded-lg px-2 text-xs font-medium transition-colors disabled:opacity-50 sm:h-14 sm:min-w-[64px]";
const dockLabel = "sr-only sm:not-sr-only";

function ToggleButton({
  source,
  label,
  on,
  off,
}: {
  source: Track.Source.Microphone | Track.Source.Camera | Track.Source.ScreenShare;
  label: string;
  on: React.ReactNode;
  off: React.ReactNode;
}) {
  const { enabled, toggle, pending } = useTrackToggle({ source });
  const share = source === Track.Source.ScreenShare;
  return (
    <button
      type="button"
      aria-pressed={enabled}
      disabled={pending}
      title={label}
      aria-label={label}
      onClick={() => void toggle()}
      className={cx(
        dockBtn,
        share ? (enabled ? "bg-accent-wash text-accent-text" : "text-ink hover:bg-hover") : enabled ? "text-ink hover:bg-hover" : "bg-block-wash text-block hover:bg-block-wash/70",
        !share && "sm:rounded-r-none",
      )}
    >
      {enabled ? on : off}
      <span aria-hidden="true" className={dockLabel}>
        {label}
      </span>
    </button>
  );
}

/** Pick a microphone, speaker or camera during the call. */
function DeviceMenu({ kinds, label, enabled }: { kinds: MediaDeviceKind[]; label: string; enabled: boolean }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  return (
    <div ref={box} className="relative hidden sm:block">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        aria-label={label}
        title={label}
        onClick={() => setOpen(!open)}
        className={cx(
          "grid h-14 w-6 place-items-center rounded-r-lg transition-colors",
          enabled ? "text-ink-2 hover:bg-hover hover:text-ink" : "bg-block-wash text-block hover:bg-block-wash/70",
        )}
      >
        <ChevronDownIcon className={cx("size-3.5 transition-transform", open ? "" : "rotate-180")} />
      </button>
      {open ? (
        <div id={id} role="menu" aria-label={label} className={cx(popover, "absolute bottom-[calc(100%+10px)] left-1/2 z-30 grid w-[300px] -translate-x-1/2 gap-1")}>
          {kinds.map((k) => (
            <DeviceList key={k} kind={k} onPick={() => setOpen(false)} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function DeviceList({ kind, onPick }: { kind: MediaDeviceKind; onPick: () => void }) {
  const t = useT();
  const { devices, activeDeviceId, setActiveMediaDevice } = useMediaDeviceSelect({ kind });
  if (!devices.length) return null;
  const title = kind === "audioinput" ? t("meet.micList") : kind === "audiooutput" ? t("meet.speakerList") : t("meet.camList");
  return (
    <div role="group" aria-label={title} className="grid">
      <p className={menuLabel}>{title}</p>
      {devices.map((d, i) => {
        // Before anyone picks, the browser uses its default: the first entry.
        const active = devices.some((x) => x.deviceId === activeDeviceId) ? d.deviceId === activeDeviceId : i === 0;
        return (
          <button
            key={d.deviceId || i}
            type="button"
            role="menuitemradio"
            aria-checked={active}
            onClick={() => void setActiveMediaDevice(d.deviceId).then(onPick)}
            className={cx(menuItem, active && "bg-selected hover:bg-selected font-medium")}
          >
            <span aria-hidden="true" className={cx("size-1.5 shrink-0 rounded-full", active ? "bg-accent" : "bg-transparent")} />
            <span className="truncate">{d.label || `${title} ${i + 1}`}</span>
          </button>
        );
      })}
    </div>
  );
}

function Dock({
  panel,
  setPanel,
  unread,
  people,
  waiting,
  recording,
  canRecord,
  code,
  onReact,
  leaveLabel,
}: {
  panel: Panel | null;
  setPanel: (p: Panel | null) => void;
  unread: number;
  people: number;
  waiting: number;
  recording: boolean;
  canRecord: boolean;
  code: string;
  onReact: (emoji: string) => void;
  leaveLabel: string;
}) {
  const t = useT();
  const room = useRoomContext();
  const hand = useMyHand();
  const mic = useTrackToggle({ source: Track.Source.Microphone });
  const cam = useTrackToggle({ source: Track.Source.Camera });
  const audio = useStartAudio({ room, props: {} });
  const [busy, setBusy] = useState(false);
  const [canShare, setCanShare] = useState(false);
  // Phones cannot share a screen; the button only shows where the browser supports it.
  useEffect(() => setCanShare(!!navigator.mediaDevices && "getDisplayMedia" in navigator.mediaDevices), []);
  const toggleRecording = async () => {
    setBusy(true);
    await api(`work/meet/rooms/${code}/recording`, { method: recording ? "DELETE" : "POST" }).catch(() => undefined);
    setBusy(false);
  };
  const side = (p: Panel) => (
    <button
      type="button"
      aria-pressed={panel === p}
      aria-label={p === "chat" ? t("meet.chat") : t("meet.people")}
      title={p === "chat" ? t("meet.chat") : t("meet.people")}
      onClick={() => setPanel(panel === p ? null : p)}
      className={cx(dockBtn, panel === p ? "bg-selected text-ink" : "text-ink hover:bg-hover")}
    >
      {p === "chat" ? <ChatIcon /> : <UsersIcon />}
      <span aria-hidden="true" className={dockLabel}>
        {p === "chat" ? t("meet.chat") : t("meet.people")}
      </span>
      {p === "chat" && unread > 0 ? (
        <span className="bg-accent absolute right-2.5 top-2 size-2 rounded-full" role="img" aria-label={t("meet.newMessage", { name: "" }).trim()} />
      ) : null}
      {p === "people" ? (
        <span
          aria-hidden="true"
          className={cx("absolute right-1.5 top-1.5 rounded-sm px-1.5 text-xs tabular-nums", waiting ? "bg-accent text-on-brand" : "bg-selected text-ink-2")}
        >
          {waiting ? `+${waiting}` : people}
        </span>
      ) : null}
    </button>
  );

  return (
    <footer className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 px-3 pb-[max(env(safe-area-inset-bottom),12px)] pt-3 md:px-4">
      <p className="text-ink-2 m-0 hidden truncate font-mono text-xs tabular-nums lg:block">{code}</p>
      <div className="bg-surface border-hairline col-start-2 flex items-center gap-1 rounded-xl border p-1">
        <div className="flex">
          <ToggleButton source={Track.Source.Microphone} label={t("meet.mic")} on={<MicIcon className="size-5" />} off={<MicOffIcon className="size-5" />} />
          {/* Phones: device menus and screen sharing hide so the dock fits 390 px (the lobby picks devices). */}
          <span className="contents max-sm:hidden">
            <DeviceMenu kinds={["audioinput", "audiooutput"]} label={t("meet.chooseMic")} enabled={mic.enabled} />
          </span>
        </div>
        <div className="flex">
          <ToggleButton source={Track.Source.Camera} label={t("meet.cam")} on={<VideoIcon className="size-5" />} off={<VideoOffIcon className="size-5" />} />
          <span className="contents max-sm:hidden">
            <DeviceMenu kinds={["videoinput"]} label={t("meet.chooseCam")} enabled={cam.enabled} />
          </span>
        </div>
        {canShare ? (
          <span className="contents max-sm:hidden">
            <ToggleButton source={Track.Source.ScreenShare} label={t("meet.present")} on={<ScreenIcon className="size-5" />} off={<ScreenIcon className="size-5" />} />
          </span>
        ) : null}
        <button
          type="button"
          aria-pressed={hand.raised}
          aria-label={hand.raised ? t("meet.lowerHand") : t("meet.raiseHand")}
          title={hand.raised ? t("meet.lowerHand") : t("meet.raiseHand")}
          onClick={hand.toggle}
          className={cx(dockBtn, hand.raised ? "bg-warn-wash text-warn" : "text-ink hover:bg-hover")}
        >
          <HandIcon className="size-5" />
          <span aria-hidden="true" className={dockLabel}>
            {hand.raised ? t("meet.lowerHand") : t("meet.raiseHand")}
          </span>
        </button>
        <ReactionPicker onPick={onReact} className={cx(dockBtn, "text-ink hover:bg-hover max-sm:hidden")} />
        {canRecord ? (
          <button
            type="button"
            disabled={busy}
            aria-pressed={recording}
            aria-label={recording ? t("meet.stopRecord") : t("meet.record")}
            title={recording ? t("meet.stopRecord") : t("meet.record")}
            onClick={() => void toggleRecording()}
            className={cx(dockBtn, recording ? "bg-block-wash text-block" : "text-ink hover:bg-hover")}
          >
            <RecordIcon className="size-5" />
            <span aria-hidden="true" className={dockLabel}>
              {recording ? t("meet.stopRecord") : t("meet.record")}
            </span>
          </button>
        ) : null}
        <div className="flex sm:hidden">
          {side("chat")}
          {side("people")}
        </div>
        <span aria-hidden="true" className="bg-hairline mx-1 h-8 w-px" />
        <button
          type="button"
          onClick={() => void room.disconnect()}
          className="bg-danger-fill hover:bg-danger-fill/90 flex h-12 items-center gap-2 rounded-lg px-3.5 text-sm font-medium text-white transition-colors sm:h-14 sm:px-4"
          aria-label={leaveLabel}
          title={leaveLabel}
        >
          <PhoneOffIcon className="size-5" />
          <span aria-hidden="true" className="hidden lg:inline">
            {leaveLabel}
          </span>
        </button>
      </div>
      <div className="hidden items-center justify-end gap-1 sm:flex">
        {!audio.canPlayAudio ? (
          <button type="button" className={cx(btn, btnSm)} onClick={audio.mergedProps.onClick}>
            {t("meet.enableAudio")}
          </button>
        ) : null}
        {side("chat")}
        {side("people")}
      </div>
      {!audio.canPlayAudio ? (
        <button type="button" className={cx(btn, btnSm, "col-span-3 justify-self-center sm:hidden")} onClick={audio.mergedProps.onClick}>
          {t("meet.enableAudio")}
        </button>
      ) : null}
    </footer>
  );
}

function ChatPanel({ messages, send }: { messages: ReturnType<typeof useChat>["chatMessages"]; send: ReturnType<typeof useChat>["send"] }) {
  const t = useT();
  const [text, setText] = useState("");
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView({ block: "end" }), [messages.length]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const v = text.trim();
    if (!v) return;
    setText("");
    await send(v);
  };
  return (
    <>
      <ol className="m-0 grid min-h-0 flex-1 list-none content-start gap-4 overflow-y-auto p-4">
        {messages.length === 0 ? <li className="text-ink-2 text-sm">{t("meet.noMessages")}</li> : null}
        {messages.map((m) => {
          const who = m.from?.name || m.from?.identity || "?";
          return (
            <li key={m.id ?? m.timestamp} className="flex gap-2.5">
              <Monogram name={who} seed={m.from?.identity} className="mt-0.5 size-7 text-xs" />
              <div className="grid min-w-0 gap-0.5">
                <span className="text-ink-2 text-xs">
                  <b className="text-ink font-semibold">{m.from?.isLocal ? t("meet.you2") : who}</b>{" "}
                  <span className="font-mono tabular-nums">{new Date(m.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                </span>
                <span className="whitespace-pre-wrap break-words text-sm">{m.message}</span>
              </div>
            </li>
          );
        })}
        <div ref={end} />
      </ol>
      <form onSubmit={(e) => void submit(e)} className="border-hairline flex gap-2 border-t p-3">
        <input
          className="border-hairline bg-ground text-ink focus:border-ink-2 min-h-10 min-w-0 flex-1 rounded-md border px-3 text-sm focus:outline-none"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t("meet.message")}
          aria-label={t("meet.message")}
          maxLength={2000}
        />
        <button type="submit" className={btnPrimary} disabled={!text.trim()}>
          {t("meet.send")}
        </button>
      </form>
    </>
  );
}

function PeoplePanel({
  participants,
  member,
  code,
  waiting,
  decide,
}: {
  participants: Participant[];
  member: MemberSide | null;
  code: string;
  waiting: { id: string; name: string }[];
  decide: (id: string, admit: boolean) => Promise<void>;
}) {
  const t = useT();
  const host = member && member.room.createdBy === member.me;
  const [access, setAccess] = useState<GuestAccess>(member?.room.guestAccess ?? "lobby");
  // Host controls go through the server (LiveKit admin API); participants cannot do this to each other.
  const act = async (identity: string, action: "mute" | "remove") => {
    await api(`work/meet/rooms/${code}/participants/${encodeURIComponent(identity)}/${action}`, { method: "POST" }).catch(() => undefined);
  };
  const change = async (v: GuestAccess) => {
    setAccess(v);
    await api(`work/meet/rooms/${code}`, { method: "PATCH", body: { guestAccess: v } }).catch(() => undefined);
  };
  return (
    <div className="grid min-h-0 flex-1 content-start gap-5 overflow-y-auto p-4">
      {host ? (
        <div className="grid gap-1.5 text-sm font-semibold">
          {t("meet.guestAccess")}
          <Picker
            variant="field"
            className="font-normal"
            label={t("meet.guestAccess")}
            value={access}
            onChange={(v) => void change(v as GuestAccess)}
            options={(["lobby", "open", "off"] as const).map((v) => ({ value: v, label: t(`meet.access_${v}`) }))}
          />
        </div>
      ) : null}
      {member && waiting.length ? (
        <section className="grid gap-2">
          <h3 className="text-ink-2 m-0 text-xs font-semibold">{t("meet.lobbyTitle")}</h3>
          {waiting.map((g) => (
            <div key={g.id} className="bg-accent-wash flex items-center gap-2 rounded-lg p-2">
              <Monogram name={g.name} className="size-7 text-xs" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{g.name}</span>
              <button type="button" className={cx(btn, btnSm)} onClick={() => void decide(g.id, false)}>
                {t("meet.deny")}
              </button>
              <button type="button" className={cx(btnPrimary, btnSm)} onClick={() => void decide(g.id, true)}>
                {t("meet.admit")}
              </button>
            </div>
          ))}
        </section>
      ) : null}
      <ul className="m-0 grid list-none gap-0.5 p-0">
        {participants.map((p) => (
          <li key={p.identity} className="flex min-h-11 items-center gap-2.5">
            <Monogram name={displayName(p)} seed={p.identity} className={cx("size-8 text-xs", p.isSpeaking && "ring-accent ring-2")} />
            <span className="min-w-0 flex-1 truncate text-sm">
              {displayName(p)} {p.isLocal ? <span className="text-ink-2">{t("meet.you")}</span> : null}
              {kindOf(p) === "guest" ? <span className="text-ink-2"> · {t("meet.guest")}</span> : null}
            </span>
            <HandMark participant={p} />
            {p.isMicrophoneEnabled ? <MicIcon className="text-ink-2 size-4" /> : <MicOffIcon className="text-block size-4" />}
            {host && !p.isLocal ? (
              <Menu
                label={t("meet.manage", { name: displayName(p) })}
                trigger={
                  <span className="text-ink-2 hover:bg-hover grid size-8 place-items-center rounded-md">
                    <MoreIcon className="size-4" />
                  </span>
                }
                items={[
                  ...(p.isMicrophoneEnabled ? [{ label: t("meet.muteThem"), onSelect: () => void act(p.identity, "mute") }] : []),
                  { label: t("meet.removeThem"), danger: true, onSelect: () => void act(p.identity, "remove") },
                ]}
              />
            ) : null}
          </li>
        ))}
      </ul>
      {host ? (
        <button
          type="button"
          className={cx(btn, "text-block justify-self-start")}
          onClick={() => {
            if (window.confirm(t("meet.endConfirm"))) void api(`work/meet/rooms/${code}/end`, { method: "POST" }).catch(() => undefined);
          }}
        >
          <PhoneOffIcon className="size-4" />
          {t("meet.endForAll")}
        </button>
      ) : null}
    </div>
  );
}

function HandMark({ participant }: { participant: Participant }) {
  const t = useT();
  const hand = useParticipantAttribute("hand", { participant });
  return hand ? (
    <span role="img" aria-label={t("meet.handRaised", { name: displayName(participant) })} className="text-warn">
      <HandIcon className="size-4" />
    </span>
  ) : null;
}
