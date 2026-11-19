/** Line icons, 24px grid, stroke = currentColor. Decorative unless given a label by the caller. */
const p = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
type I = { className?: string };
const svg = (d: React.ReactNode) =>
  function Icon({ className = "size-[18px]" }: I) {
    return (
      <svg viewBox="0 0 24 24" className={className} {...p}>
        {d}
      </svg>
    );
  };

export const HomeIcon = svg(<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />);
export const ChatIcon = svg(<path d="M4 5h16v11H8l-4 4z" />);
export const WorkIcon = svg(
  <>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16M15 4v16" />
  </>,
);
export const MeIcon = svg(
  <>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" />
  </>,
);
export const BellIcon = svg(
  <>
    <path d="M6 16V11a6 6 0 1 1 12 0v5l2 2H4z" />
    <path d="M10 20a2 2 0 0 0 4 0" />
  </>,
);
export const SearchIcon = svg(
  <>
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-4-4" />
  </>,
);
export const PlusIcon = svg(<path d="M12 5v14M5 12h14" />);
export const ShareIcon = svg(
  <>
    <path d="M12 15V4M8 8l4-4 4 4" />
    <path d="M6 12v6.5A1.5 1.5 0 0 0 7.5 20h9a1.5 1.5 0 0 0 1.5-1.5V12" />
  </>,
);
export const HashIcon = svg(<path d="M5 9h14M5 15h14M10 4L8 20M16 4l-2 16" />);
export const LockIcon = svg(
  <>
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </>,
);
export const PinIcon = svg(
  <>
    <path d="M9 4h6l-1 6 3 3H7l3-3z" />
    <path d="M12 13v7" />
  </>,
);
export const BookmarkIcon = svg(<path d="M6 4h12v17l-6-4-6 4z" />);
/** A raised hand (meetings): line art, so the dock reads as one set of icons. */
export const HandIcon = svg(
  <path d="M8 13V6.5a1.5 1.5 0 0 1 3 0V12M11 11.5V5a1.5 1.5 0 0 1 3 0v6.5M14 11.5V6.5a1.5 1.5 0 0 1 3 0V14c0 3.9-2.6 7-6.2 7-2.2 0-3.6-.8-4.9-2.6l-2.4-3.6a1.5 1.5 0 0 1 2.4-1.8L8 15" />,
);
export const SmileIcon = svg(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M8.5 14a4 4 0 0 0 7 0M9 9.5h.01M15 9.5h.01" />
  </>,
);
// A speech bubble with lines of text (Slack's "reply in thread"). Two overlapping square bubbles read as a lorry at
// 16px; this one reuses ChatIcon's outline, which also keeps the shared icon chunk under the routes' budgets.
export const ThreadIcon = svg(
  <>
    <path d="M4 5h16v11H8l-4 4z" />
    <path d="M8 9h8M8 12h5" />
  </>,
);
export const PencilIcon = svg(<path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4" />);
export const TrashIcon = svg(<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />);
export const CameraIcon = svg(
  <>
    <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
    <circle cx="12" cy="13" r="3.5" />
  </>,
);
export const MoreIcon = svg(<path d="M6 12h.01M12 12h.01M18 12h.01" />);
export const CalendarIcon = svg(
  <>
    <rect x="3" y="5" width="18" height="16" rx="2" />
    <path d="M3 10h18M8 3v4M16 3v4" />
  </>,
);
/** Gantt: staggered bars on a timeline. */
export const GanttIcon = svg(
  <>
    <path d="M4 6h8" />
    <path d="M8 12h9" />
    <path d="M13 18h7" />
    <path d="M3 3v18" />
  </>,
);
export const CheckIcon = svg(<path d="M5 12.5l4.5 4.5L19 7" />);
export const InboxIcon = svg(
  <>
    <path d="M4 13l2.2-7.1A1.5 1.5 0 0 1 7.6 5h8.8a1.5 1.5 0 0 1 1.4.9L20 13" />
    <path d="M4 13v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5h-4.5a3.5 3.5 0 0 1-7 0z" />
  </>,
);
export const CheckCircleIcon = svg(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M8 12.5l3 3 5-6" />
  </>,
);
export const FileIcon = svg(
  <>
    <path d="M6 3h8l4 4v14H6z" />
    <path d="M14 3v4h4M9 12h6M9 16h6" />
  </>,
);
export const FolderIcon = svg(<path d="M3 6h6l2 2h10v11H3z" />);
export const UsersIcon = svg(
  <>
    <circle cx="9" cy="8" r="3.5" />
    <path d="M2.5 20c1-3.5 3.5-5 6.5-5s5.5 1.5 6.5 5" />
    <path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 15c2 .8 3.2 2.4 3.5 5" />
  </>,
);
export const SettingsIcon = svg(
  <>
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    <circle cx="12" cy="12" r="3" />
  </>,
);
export const LogoutIcon = svg(<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11" />);
export const PaperclipIcon = svg(<path d="M20 11l-8.5 8.5a5 5 0 0 1-7-7L13 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L14 7" />);
export const ChevronDownIcon = svg(<path d="M6 9l6 6 6-6" />);
export const ChevronLeftIcon = svg(<path d="M15 6l-6 6 6 6" />);
/** Light theme. */
export const SunIcon = svg(
  <>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4" />
  </>,
);
/** Do not disturb; the dark theme. */
export const MoonIcon = svg(<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />);
/** Translate: a speech bubble with a language mark. */
export const TranslateIcon = svg(
  <>
    <path d="M4 5h9M8.5 3v2M11 5c-.8 3.7-3.3 6.4-6 7.5M6.5 8.5c1.2 1.6 2.8 2.8 4.5 3.5" />
    <path d="M13 20l3.5-8 3.5 8M14.2 17.5h4.6" />
  </>,
);
export const CloseIcon = svg(<path d="M6 6l12 12M18 6L6 18" />);
export const ClockIcon = svg(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </>,
);
export const FlagIcon = svg(<path d="M5 21V4M5 4h11l-2 4 2 4H5" />);
export const ApprovalIcon = svg(
  <>
    <path d="M9 11l2 2 4-4" />
    <rect x="4" y="3" width="16" height="18" rx="2" />
  </>,
);
export const AtIcon = svg(
  <>
    <circle cx="12" cy="12" r="4" />
    <path d="M16 12v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3.5 7.1" />
  </>,
);
export const MegaphoneIcon = svg(<path d="M4 10v4h3l6 4V6L7 10zM17 9a4 4 0 0 1 0 6" />);
export const SendIcon = svg(<path d="M4 12l16-8-6 16-3-7z" />);
export const LinkIcon = svg(<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />);
export const ShieldIcon = svg(<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />);
export const BotIcon = svg(
  <>
    <rect x="5" y="8" width="14" height="11" rx="3" />
    <path d="M12 4v4M9 13h.01M15 13h.01M3 13v2M21 13v2" />
  </>,
);
export const ChartIcon = svg(<path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />);
export const ListIcon = svg(<path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />);
export const BoardIcon = svg(
  <>
    <rect x="3" y="4" width="5" height="16" rx="1" />
    <rect x="10" y="4" width="5" height="10" rx="1" />
    <rect x="17" y="4" width="4" height="13" rx="1" />
  </>,
);
/** AI: a four-point sparkle. */
/** AI: a small "AI" monogram in a frame (not a sparkle, the stock sign of generated UI). */
export const SparkleIcon = svg(
  <>
    <rect x="3" y="4.5" width="18" height="15" rx="3.5" />
    <path d="M7.5 15.5 10 8.5l2.5 7M8.4 13.2h3.2M16 8.5v7" />
  </>,
);
export const StarIcon = svg(<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.9z" />);
export const BellOffIcon = svg(
  <>
    <path d="M6 16V11a6 6 0 0 1 9.5-4.9M18 11v5l2 2H8" />
    <path d="M10 20a2 2 0 0 0 4 0M3 3l18 18" />
  </>,
);
export const ChevronRightIcon = svg(<path d="M9 6l6 6-6 6" />);
export const BoldIcon = svg(<path d="M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z" />);
export const ItalicIcon = svg(<path d="M11 5h7M6 19h7M14 5l-4 14" />);
export const CodeIcon = svg(<path d="M9 8l-4 4 4 4M15 8l4 4-4 4" />);
export const QuoteIcon = svg(<path d="M5 6v12M10 8h9M10 12h9M10 16h6" />);
export const StrikeIcon = svg(<path d="M5 12h14M16 7.5C15.4 6 13.9 5 12 5c-2.5 0-4 1.3-4 3 0 1.4.9 2.4 3 3M8 16.5c.6 1.6 2.2 2.5 4 2.5 2.5 0 4-1.3 4-3 0-.6-.1-1-.4-1.5" />);
export const HeadingIcon = svg(<path d="M6 5v14M16 5v14M6 12h10" />);
export const ListOrderedIcon = svg(<path d="M10 6h10M10 12h10M10 18h10M4 5h1.5v4M4 9h3M4 14.5c.4-.7 1-1 1.6-1 .8 0 1.4.5 1.4 1.2 0 1.2-3 2-3 3.3h3" />);
export const ChecklistIcon = svg(<path d="M4 6l1.5 1.5L8 5M4 12l1.5 1.5L8 11M4 18l1.5 1.5L8 17M11 6h9M11 12h9M11 18h9" />);
export const ArrowDownIcon = svg(<path d="M12 5v14M6 13l6 6 6-6" />);
export const CopyIcon = svg(
  <>
    <rect x="8" y="8" width="12" height="12" rx="2" />
    <path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" />
  </>,
);
export const EyeOffIcon = svg(
  <>
    <path d="M3 12s3.5-6 9-6c2 0 3.7.8 5 1.8M21 12s-3.5 6-9 6c-2 0-3.7-.8-5-1.8" />
    <path d="M3 3l18 18" />
  </>,
);
export const CloudOffIcon = svg(<path d="M3 3l18 18M7.4 7.4A5 5 0 0 0 7 17h10.6M10.6 5.2A6 6 0 0 1 18 10.2a3.8 3.8 0 0 1 2.4 6.5" />);
export const RefreshIcon = svg(<path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6" />);
/** Two arrows pointing out (make a dialog larger) and in (back to the compact size). */
export const ExpandIcon = svg(<path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7" />);
export const CollapseIcon = svg(<path d="M20 4l-6 6M14 5v5h5M4 20l6-6M10 19v-5H5" />);
export const PanelIcon = svg(
  <>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M15 4v16" />
  </>,
);
export const GlobeIcon = svg(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z" />
  </>,
);
export const DownloadIcon = svg(<path d="M12 4v11M7 10l5 5 5-5M5 20h14" />);
export const FilterIcon = svg(<path d="M4 5h16l-6 8v5l-4 2v-7z" />);
export const HelpIcon = svg(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.7M12 17h.01" />
  </>,
);
export const VideoIcon = svg(
  <>
    <rect x="3" y="6" width="13" height="12" rx="2" />
    <path d="M16 10l5-3v10l-5-3z" />
  </>,
);
export const VideoOffIcon = svg(
  <>
    <path d="M16 16v0a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h1M10 6h4a2 2 0 0 1 2 2v2l5-3v10" />
    <path d="M3 3l18 18" />
  </>,
);
export const MicIcon = svg(
  <>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </>,
);
export const MicOffIcon = svg(
  <>
    <path d="M15 10V6a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 4.6 2.5M5 11a7 7 0 0 0 11.4 5.4M19 11a7 7 0 0 1-.6 2.8M12 18v3" />
    <path d="M3 3l18 18" />
  </>,
);
export const ScreenIcon = svg(
  <>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M8 20h8M12 16v4M12 13V7M9 10l3-3 3 3" />
  </>,
);
export const PhoneIcon = svg(<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2" />);
export const PhoneOffIcon = svg(<path d="M3.5 13.5c4.7-4.7 12.3-4.7 17 0l-2.2 2.2-3.3-1.4V12a11 11 0 0 0-6 0v2.3l-3.3 1.4z" />);
export const RecordIcon = svg(
  <>
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="4" fill="currentColor" />
  </>,
);
export const ForwardIcon = svg(<path d="M14 5l7 7-7 7M21 12H10a6 6 0 0 0-6 6v1" />);
export const CartIcon = svg(
  <>
    <path d="M3 4h2l2.4 11.2a1 1 0 0 0 1 .8h8.8a1 1 0 0 0 1-.8L20 8H6.2" />
    <circle cx="9" cy="20" r="1.3" />
    <circle cx="17" cy="20" r="1.3" />
  </>,
);
export const CardIcon = svg(
  <>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M3 10h18M7 15h4" />
  </>,
);
export const CashIcon = svg(
  <>
    <rect x="2.5" y="6" width="19" height="12" rx="2" />
    <circle cx="12" cy="12" r="2.5" />
    <path d="M6 9.5v5M18 9.5v5" />
  </>,
);
export const PlaneIcon = svg(<path d="M10.5 13.5L4 11l1.5-1.5 7 .5 4.5-4.5a2.1 2.1 0 0 1 3 3L15.5 13l.5 7-1.5 1.5-2.5-6.5L9 18v2.5L7.5 22l-1-4-4-1L4 15.5h2.5z" />);
export const ArrowRightIcon = svg(<path d="M5 12h14M13 6l6 6-6 6" />);
export const ArrowUpIcon = svg(<path d="M12 19V5M6 11l6-6 6 6" />);
export const InfoIcon = svg(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8h.01" />
  </>,
);
export const TrendIcon = svg(<path d="M3 17l6-6 4 4 8-8M15 7h6v6" />);
export const GridIcon = svg(
  <>
    <rect x="4" y="4" width="7" height="7" rx="1.5" />
    <rect x="13" y="4" width="7" height="7" rx="1.5" />
    <rect x="4" y="13" width="7" height="7" rx="1.5" />
    <rect x="13" y="13" width="7" height="7" rx="1.5" />
  </>,
);
/** Whiteboard: a board on an easel. */
export const WhiteboardIcon = svg(
  <>
    <rect x="3" y="4" width="18" height="12" rx="1.5" />
    <path d="M8 20l2-4M16 20l-2-4M7 9.5c1.5-1.5 3-1.5 4 0s2.5 1.5 4 0" />
  </>,
);
/** A sticky note with a folded corner. */
export const StickyIcon = svg(<path d="M5 4h14v10l-5 6H5zM14 20v-6h5" />);
export const PlayIcon = svg(<path d="M8 5.5v13a.6.6 0 0 0 .9.5l10.2-6.5a.6.6 0 0 0 0-1L8.9 5a.6.6 0 0 0-.9.5z" />);
/** Stop a run: a rounded square. */
export const StopIcon = svg(<rect x="6" y="6" width="12" height="12" rx="2" />);
export const WorkflowIcon = svg(
  <>
    <rect x="3" y="4" width="6" height="5" rx="1.5" />
    <rect x="15" y="15" width="6" height="5" rx="1.5" />
    <path d="M6 9v3a2 2 0 0 0 2 2h8a2 2 0 0 1 2 2" />
  </>,
);
export const TerminalIcon = svg(
  <>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M7 9l3 3-3 3M13 15h4" />
  </>,
);
/** Six dots: a drag handle (board columns). */
export const GripIcon = svg(
  <>
    <circle cx="9" cy="6" r="1" />
    <circle cx="15" cy="6" r="1" />
    <circle cx="9" cy="12" r="1" />
    <circle cx="15" cy="12" r="1" />
    <circle cx="9" cy="18" r="1" />
    <circle cx="15" cy="18" r="1" />
  </>,
);
