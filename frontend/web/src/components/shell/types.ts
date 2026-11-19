export interface ChannelSummary {
  id: string;
  kind: string;
  name: string | null;
  /** How people read the channel ("Kỹ thuật"); null shows `name`. */
  displayName?: string | null;
  topic?: string;
  unread: number;
  mentions: number;
  lastSeq: number;
  lastReadSeq: number;
  dmUserId: string | null;
  starred?: boolean;
  muted?: boolean;
  notify?: "all" | "mentions" | "none" | null;
  mutedUntil?: string | null;
  lastMessageAt?: string | null;
  memberCount?: number;
}
export interface ShellUser {
  userId: string;
  name: string;
  email: string;
  isAdmin: boolean;
}
/** Attendance for the top bar's check-in pill: null when the workspace does not use it. */
export interface ShellAttendance {
  today: { checkIn: string; checkOut: string | null } | null;
}
