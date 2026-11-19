import type { Metadata } from "next";
import { getT } from "@/lib/i18n/server";

/** The page itself is a client form, so its title (and noindex, like sign-in) lives here. */
export async function generateMetadata(): Promise<Metadata> {
  const tx = await getT();
  return { title: tx("signIn.forgotPasswordPage.quen_mat_khau"), robots: { index: false } };
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
