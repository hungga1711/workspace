"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { useFormat } from "@/lib/i18n/client";
import { Avatar, useDirectory } from "@/lib/people";
import { cx, skeleton } from "@/lib/ui";
import { Drawer } from "@/components/ui/Drawer";
import { AttachmentList } from "./attachments";
import { filesOf, FilesList, LoadError, MembersList, pinsOf, PinsList, useChannelList } from "./ChannelDrawers";
import { Segmented } from "@/components/ui/Segmented";
import { drawerTool } from "@/components/ui/Drawer";
import { SettingsIcon } from "@/components/app/icons";
import { RichText } from "./RichText";
import { PersonTrigger } from "./PersonTrigger";
import type { ChannelInfo } from "./Conversation";

const SHOWN = 5;
const MEMBERS = 8;

export type DetailsTab = "about" | "members" | "pins" | "files";

/**
 * A conversation's "Chi tiết", the one place for everything about it: an overview (about, members, pins
 * and files at a glance), then members, pins and files as tabs of the same side drawer. "Xem tất cả" switches tab;
 * the header's member avatars open it on "Thành viên".
 */
export function ChannelDetails({
  channel,
  title,
  topic,
  members,
  tab,
  onTab,
  onMembersChange,
  onClose,
  onOpenPin,
  onSettings,
  filesKey = 0,
  pinsKey = 0,
}: {
  channel: ChannelInfo;
  title: string;
  topic: string;
  members: string[];
  tab: DetailsTab;
  onTab: (tab: DetailsTab) => void;
  onMembersChange: (ids: string[]) => void;
  onClose: () => void;
  onOpenPin: (id: string) => void;
  onSettings?: () => void;
  /** Change to re-fetch files / pins (a message with attachments arrived, something was pinned). */
  filesKey?: string | number;
  pinsKey?: string | number;
}) {
  const dir = useDirectory();
  const { t, dayLabel, time } = useFormat();
  const pins = useChannelList(`chat/channels/${channel.id}/pins`, pinsOf, pinsKey);
  const files = useChannelList(`chat/channels/${channel.id}/files`, filesOf, filesKey);
  const [online, setOnline] = useState<Record<string, boolean>>({});
  const shownMembers = members.slice(0, MEMBERS);
  const key = shownMembers.join(",");
  // Presence is decoration: on failure everyone simply shows without the green dot, as in the drawer.
  useEffect(() => {
    if (!key) return;
    api<{ presence: Record<string, boolean> | { userId: string; online: boolean }[] }>(`chat/presence?userIds=${key}`)
      .then((r) => setOnline(Array.isArray(r.presence) ? Object.fromEntries(r.presence.map((x) => [x.userId, x.online])) : r.presence))
      .catch(() => undefined);
  }, [key]);
  const dm = channel.kind === "dm";
  const onMembers = () => onTab("members");
  const onPins = () => onTab("pins");
  const onFiles = () => onTab("files");

  return (
    <Drawer
      title={t("chat.details.title")}
      label={t("chat.details.region", { title })}
      onClose={onClose}
      actions={
        onSettings ? (
          <button type="button" className={drawerTool} onClick={onSettings} aria-label={t("chat.conv.settings")} title={t("chat.conv.settings")}>
            <SettingsIcon />
          </button>
        ) : null
      }
    >
      <div className="border-divider-soft border-b px-4 py-2.5">
        <Segmented
          size="sm"
          label={t("chat.details.title")}
          value={tab}
          onChange={onTab}
          options={[
            { value: "about" as const, label: t("chat.details.overviewTab") },
            ...(!dm ? [{ value: "members" as const, label: t("chat.details.membersTab"), count: members.length }] : []),
            { value: "pins" as const, label: t("chat.details.pinsTab") },
            { value: "files" as const, label: t("chat.details.files") },
          ]}
        />
      </div>
      {tab === "members" && !dm ? (
        <MembersList channel={channel} members={members} onChange={onMembersChange} />
      ) : tab === "pins" ? (
        <PinsList channelId={channel.id} onOpen={onOpenPin} refreshKey={pinsKey} />
      ) : tab === "files" ? (
        <FilesList channelId={channel.id} refreshKey={filesKey} />
      ) : (
        <div className="divide-divider-soft divide-y text-sm">
          <Block
            title={t(dm ? "chat.details.dm" : "chat.details.about")}
            action={
              // Workspace admins can take the whole history out (JSON, streamed by /app/chat/[id]/export).
              !dm && channel.canManage ? (
                <a href={`/app/chat/${channel.id}/export`} download className="text-accent-text text-xs font-semibold hover:underline">
                  {t("chat.details.export")}
                </a>
              ) : null
            }
          >
            {dm ? (
              <div className="flex items-center gap-3">
                <Avatar id={channel.dmUserId ?? ""} size="lg" />
                <span className="min-w-0">
                  <span className="block truncate font-semibold">{title}</span>
                  <span className="text-ink-2 block text-xs">{t("chat.details.dmPrivate")}</span>
                </span>
              </div>
            ) : topic ? (
              <p className="leading-snug">{topic}</p>
            ) : (
              <p className="text-ink-2">
                {t("chat.details.noTopic")}
                {onSettings ? (
                  <>
                    {" "}
                    <button type="button" className="text-brand-text underline" onClick={onSettings}>
                      {t("chat.details.addTopic")}
                    </button>
                  </>
                ) : null}
              </p>
            )}
          </Block>

          {!dm ? (
            <Block
              title={t("chat.details.members", { count: members.length })}
              action={
                <button type="button" className="text-accent-text text-xs font-semibold hover:underline" onClick={onMembers}>
                  {t(members.length > MEMBERS ? "common.seeAll" : "chat.details.manage")}
                </button>
              }
            >
              <ul className="m-0 grid list-none gap-0.5 p-0">
                {shownMembers.map((id) => (
                  <li key={id}>
                    <PersonTrigger userId={id} className="hover:bg-hover -mx-2 flex w-[calc(100%+16px)] items-center gap-2.5 rounded-md px-2 py-1 transition-colors">
                      <Avatar id={id} size="sm" online={online[id] ?? false} />
                      <span className="min-w-0 flex-1 truncate">
                        {dir.name(id)}
                        {id === dir.me ? <span className="text-ink-2">{t("chat.details.you")}</span> : null}
                      </span>
                    </PersonTrigger>
                  </li>
                ))}
              </ul>
            </Block>
          ) : null}

          <Block
            title={t("chat.details.pins")}
            action={
              pins.items?.length ? (
                <button type="button" className="text-accent-text text-xs font-semibold hover:underline" onClick={onPins}>
                  {t("common.seeAll")}
                </button>
              ) : null
            }
          >
            {pins.error ? (
              <LoadError what={t("chat.drawers.pinsWhat")} onRetry={pins.retry} />
            ) : pins.items === null ? (
              <Loading />
            ) : pins.items.length === 0 ? (
              <p className="text-ink-2">{t("chat.drawers.noPins")}</p>
            ) : (
              <ul className="m-0 grid list-none gap-1 p-0">
                {pins.items.slice(0, SHOWN).map((m) => (
                  <li key={m.id}>
                    <button type="button" onClick={() => onOpenPin(m.id)} className="hover:bg-hover -mx-2 grid w-[calc(100%+16px)] gap-0.5 rounded-lg px-2 py-1.5 text-left">
                      <span className="flex items-baseline gap-2 text-xs">
                        <span className="font-semibold">{dir.name(m.authorType === "system" ? "system" : m.authorId)}</span>
                        <span className="text-ink-2 text-xs tabular-nums">
                          {dayLabel(m.createdAt)} {time(m.createdAt)}
                        </span>
                      </span>
                      <span className="line-clamp-2">
                        <RichText text={m.body} names={dir.names} compact />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Block>

          <Block
            title={t("chat.details.files")}
            action={
              files.items?.length ? (
                <button type="button" className="text-accent-text text-xs font-semibold hover:underline" onClick={onFiles}>
                  {t("common.seeAll")}
                </button>
              ) : null
            }
          >
            {files.error ? (
              <LoadError what={t("chat.drawers.filesWhat")} onRetry={files.retry} />
            ) : files.items === null ? (
              <Loading />
            ) : files.items.length === 0 ? (
              <p className="text-ink-2">{t("chat.details.noFiles")}</p>
            ) : (
              <AttachmentList items={files.items.slice(0, SHOWN)} />
            )}
          </Block>
        </div>
      )}
    </Drawer>
  );
}

function Block({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="grid gap-2.5 px-5 py-4">
      <div className="flex items-baseline gap-2">
        <h3 className="text-ink-2 m-0 min-w-0 flex-1 truncate text-xs font-medium">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function Loading() {
  return (
    <div className="grid grid-cols-1 gap-2" aria-busy="true">
      <span className={skeleton} />
      <span className={cx(skeleton, "w-3/5")} />
    </div>
  );
}
