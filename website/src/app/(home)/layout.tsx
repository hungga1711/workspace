import { AmbientBackground } from "@/components/home/ambient-background";
import { SiteFooter, SiteHeader } from "@/components/home/site-chrome";

export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <div className="landing relative isolate flex min-h-screen flex-col text-ink">
      <AmbientBackground />
      <SiteHeader />
      <main className="flex-1">{children}</main>
      <SiteFooter />
    </div>
  );
}
