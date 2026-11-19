import { WorkFrame } from "@/components/work/WorkTabs";

/** Work's frame: gives every view's page header the phones' destination switcher. Each view draws its own header. */
export default function WorkLayout({ children }: { children: React.ReactNode }) {
  return <WorkFrame>{children}</WorkFrame>;
}
