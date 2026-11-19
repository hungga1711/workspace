"use client";

import { useMediaDevices, usePersistentUserChoices, usePreviewTracks, useTrackVolume, type LocalUserChoices } from "@livekit/components-react";
import type { LocalAudioTrack, LocalVideoTrack } from "livekit-client";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { api } from "@/lib/client";
import { useT } from "@/lib/i18n/client";
import { btn, btnPrimary, cx, input } from "@/lib/ui";
import { Picker } from "@/components/ui/Picker";
import { CopyIcon, MicIcon, MicOffIcon, VideoIcon, VideoOffIcon } from "@/components/app/icons";
import { Monogram } from "./parts";

interface Props {
  code: string;
  title: string;
  guest: boolean;
  lobby: boolean;
  defaultName: string;
  busy: boolean;
  error?: string;
  onJoin: (c: LocalUserChoices) => void;
}

/**
 * Before the call: a large camera preview with mic and camera switches and a live mic level, and a
 * room card with who is already inside, the display name and the join button.
 */
export function PreJoin({ code, title, guest, lobby, defaultName, busy, error, onJoin }: Props) {
  const t = useT();
  const nameId = useId();
  const {
    userChoices: saved,
    saveAudioInputEnabled,
    saveVideoInputEnabled,
    saveAudioInputDeviceId,
    saveVideoInputDeviceId,
    saveUsername,
  } = usePersistentUserChoices({
    defaults: { username: defaultName, audioEnabled: true, videoEnabled: true },
  });
  const [name, setName] = useState(defaultName || saved.username);
  const [audioOn, setAudioOn] = useState(saved.audioEnabled);
  const [videoOn, setVideoOn] = useState(saved.videoEnabled);
  const [audioId, setAudioId] = useState(saved.audioDeviceId);
  const [videoId, setVideoId] = useState(saved.videoDeviceId);
  const [deviceError, setDeviceError] = useState(false);

  // Separate previews so switching the mic does not restart the camera (and the reverse).
  const audioOpts = useMemo(() => ({ audio: audioOn ? { deviceId: audioId } : false, video: false }), [audioOn, audioId]);
  const videoOpts = useMemo(() => ({ audio: false, video: videoOn ? { deviceId: videoId } : false }), [videoOn, videoId]);
  // Stable: the hook restarts the devices whenever this function changes.
  const onError = useCallback(() => setDeviceError(true), []);
  const audioTrack = usePreviewTracks(audioOpts, onError)?.[0] as LocalAudioTrack | undefined;
  const videoTrack = usePreviewTracks(videoOpts, onError)?.[0] as LocalVideoTrack | undefined;
  // The hook keeps the last (stopped) track after a switch is turned off.
  const audio = audioOn ? audioTrack : undefined;
  const video = videoOn ? videoTrack : undefined;
  const level = useTrackVolume(audio);

  const el = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = el.current;
    if (!video || !v) return;
    video.attach(v);
    return () => void video.detach(v);
  }, [video]);

  const mics = useMediaDevices({ kind: "audioinput" });
  const cams = useMediaDevices({ kind: "videoinput" });

  // Members see who is already in the call.
  const [here, setHere] = useState<{ participants: number; names?: string[] } | null>(null);
  useEffect(() => {
    if (guest) return;
    let alive = true;
    const load = () =>
      api<{ participants: number; names?: string[] }>(`work/meet/rooms/${code}/presence`)
        .then((r) => alive && setHere(r))
        .catch(() => undefined);
    void load();
    const timer = setInterval(load, 10_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [guest, code]);

  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(`${location.origin}/meet/${code}`).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const username = name.trim();
    if (!username || busy) return;
    saveUsername(username);
    onJoin({ username, audioEnabled: audioOn, videoEnabled: videoOn, audioDeviceId: audioId, videoDeviceId: videoId });
  };

  const toggle = (on: boolean) =>
    cx(
      "grid size-11 place-items-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2",
      on ? "bg-black/55 text-white hover:bg-black/70" : "bg-block text-white hover:bg-block/90",
    );
  const shown = here?.names?.slice(0, 3) ?? [];

  return (
    <div className="grid w-full gap-6 md:grid-cols-[minmax(0,1fr)_360px] md:items-center md:gap-10">
      <section aria-label={t("meet.devices")} className="grid gap-3">
        <div className="bg-ink relative aspect-video overflow-hidden rounded-xl">
          {video ? (
            <video ref={el} muted playsInline className="size-full -scale-x-100 object-cover" />
          ) : (
            <div className="grid size-full place-items-center content-center gap-3 text-white/80">
              {videoOn && !deviceError ? <span className="text-sm">{t("meet.previewStarting")}</span> : <Monogram name={name || "?"} className="size-24 text-3xl" />}
              {!videoOn ? <span className="text-sm">{t("meet.camOff")}</span> : null}
            </div>
          )}
          {/* Live mic level: five bars that fill with the voice, so people can check before joining. */}
          {audioOn && audio ? (
            <span aria-hidden="true" className="absolute left-3 top-3 flex h-5 items-end gap-0.5 rounded-md bg-black/55 px-1.5 py-1">
              {[0.08, 0.18, 0.3, 0.45, 0.6].map((x) => (
                <span key={x} className={cx("w-1 rounded-full transition-colors", level > x ? "bg-accent" : "bg-white/30")} style={{ height: `${30 + x * 110}%` }} />
              ))}
            </span>
          ) : null}
          <div className="absolute inset-x-0 bottom-0 flex justify-center gap-2 pb-3">
            <button
              type="button"
              aria-pressed={audioOn}
              aria-label={t("meet.mic")}
              title={t("meet.mic")}
              className={toggle(audioOn)}
              onClick={() => {
                setAudioOn(!audioOn);
                saveAudioInputEnabled(!audioOn);
              }}
            >
              {audioOn ? <MicIcon className="size-5" /> : <MicOffIcon className="size-5" />}
            </button>
            <button
              type="button"
              aria-pressed={videoOn}
              aria-label={t("meet.cam")}
              title={t("meet.cam")}
              className={toggle(videoOn)}
              onClick={() => {
                setVideoOn(!videoOn);
                saveVideoInputEnabled(!videoOn);
              }}
            >
              {videoOn ? <VideoIcon className="size-5" /> : <VideoOffIcon className="size-5" />}
            </button>
          </div>
        </div>
        {deviceError ? (
          <p role="alert" className="bg-warn-wash text-warn m-0 rounded-lg px-3 py-2 text-sm">
            {t("meet.permission")}
          </p>
        ) : null}
        <div className="grid gap-2 sm:grid-cols-2">
          <DeviceSelect
            label={t("meet.micList")}
            icon={<MicIcon className="size-4" />}
            devices={mics}
            value={audioId}
            onChange={(id) => (setAudioId(id), saveAudioInputDeviceId(id))}
          />
          <DeviceSelect
            label={t("meet.camList")}
            icon={<VideoIcon className="size-4" />}
            devices={cams}
            value={videoId}
            onChange={(id) => (setVideoId(id), saveVideoInputDeviceId(id))}
          />
        </div>
      </section>

      <section aria-labelledby={`${nameId}-title`} className="bg-surface border-hairline grid gap-5 rounded-xl border p-6">
        <div className="grid gap-1.5">
          <p className="text-ink-2 m-0 font-mono text-xs">{code}</p>
          <h1 id={`${nameId}-title`} className="m-0 text-2xl/tight font-semibold tracking-tight [overflow-wrap:anywhere]">
            {title}
          </h1>
          {here ? (
            <div className="mt-1 flex items-center gap-2.5">
              {shown.length ? (
                <span className="flex -space-x-1.5">
                  {shown.map((n, i) => (
                    <Monogram key={`${n}${i}`} name={n} className="ring-surface size-7 text-xs ring-2" />
                  ))}
                </span>
              ) : null}
              <p className="text-ink-2 m-0 text-sm">
                {here.participants === 0
                  ? t("meet.nobodyYet")
                  : shown.length === 0
                    ? t("meet.alreadyIn", { names: t("meet.peopleCount", { count: here.participants }) })
                    : here.participants > shown.length
                      ? t("meet.alreadyInMore", { names: shown.join(", "), count: here.participants - shown.length })
                      : t("meet.alreadyIn", { names: shown.join(", ") })}
              </p>
            </div>
          ) : null}
        </div>

        <form onSubmit={submit} aria-busy={busy} className="grid gap-3">
          <label htmlFor={nameId} className="text-sm font-semibold">
            {t("meet.joinedAs")}
          </label>
          <input
            id={nameId}
            className={input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("meet.yourName")}
            maxLength={60}
            autoComplete="name"
            required
          />
          {error ? (
            <p role="alert" className="bg-block-wash text-block m-0 rounded-lg px-3 py-2 text-sm">
              {error}
            </p>
          ) : null}
          <button type="submit" className={cx(btnPrimary, "min-h-11 w-full text-base")} disabled={!name.trim() || busy}>
            {busy ? t("meet.connecting") : guest ? t("meet.joinAsGuest") : t("meet.join")}
          </button>
          {guest ? <p className="text-ink-2 m-0 text-xs">{lobby ? `${t("meet.guestNote")} ${t("meet.lobbyNote")}` : t("meet.guestNote")}</p> : null}
        </form>

        {!guest ? (
          <div className="border-hairline grid gap-2 border-t pt-4">
            <p className="text-ink-2 m-0 text-xs">{t("meet.shareHint")}</p>
            <button type="button" className={cx(btn, "justify-self-start")} onClick={() => void copy()}>
              <CopyIcon className="size-4" />
              <span aria-live="polite">{copied ? t("meet.linkCopied") : t("meet.copyLink")}</span>
            </button>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function DeviceSelect({
  label,
  icon,
  devices,
  value,
  onChange,
}: {
  label: string;
  icon: React.ReactNode;
  devices: MediaDeviceInfo[];
  value: string;
  onChange: (id: string) => void;
}) {
  if (devices.length === 0) return null;
  return (
    <Picker
      variant="field"
      label={label}
      value={devices.some((d) => d.deviceId === value) ? value : (devices[0]?.deviceId ?? "")}
      onChange={onChange}
      options={devices.map((d, i) => ({ value: d.deviceId, label: d.label || `${label} ${i + 1}`, icon: <span className="text-ink-2 [&_svg]:size-4">{icon}</span> }))}
    />
  );
}
