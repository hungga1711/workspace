export const MEET_CODE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

export type GuestAccess = "open" | "lobby" | "off";

export interface MeetRoomInfo {
  id: string;
  code: string;
  title: string;
  eventId: string | null;
  createdBy: string;
  guestAccess: GuestAccess;
  createdAt: string;
  lastUsedAt: string;
}

export interface JoinGrant {
  url: string;
  token: string;
}

export type GuestResult =
  | ({ status: "admitted" } & JoinGrant)
  | { status: "waiting"; requestId?: string; secret?: string }
  | { status: "denied" | "expired" | "not_found" | "members_only" }
  | { status: "error"; error: string };
