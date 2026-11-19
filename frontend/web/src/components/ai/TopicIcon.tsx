import type { ComponentType } from "react";
import { CalendarIcon, ChartIcon, ChatIcon, CodeIcon, MegaphoneIcon, PencilIcon, SearchIcon, TranslateIcon, UsersIcon, WhiteboardIcon } from "@/components/app/icons";

const ICON: Record<string, ComponentType<{ className?: string }>> = {
  code: CodeIcon,
  writing: PencilIcon,
  analysis: ChartIcon,
  translation: TranslateIcon,
  research: SearchIcon,
  sales: MegaphoneIcon,
  hr: UsersIcon,
  design: WhiteboardIcon,
  planning: CalendarIcon,
};

/** A conversation's topic as a small grey icon (Linear's sidebar items each carry one); unknown topics a speech bubble. */
export function TopicIcon({ topic, className }: { topic: string; className?: string }) {
  const Icon = ICON[topic] ?? ChatIcon;
  return <Icon className={className} />;
}
