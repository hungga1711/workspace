"use client";
import SearchDialog from "@/components/search";
import { RootProvider } from "fumadocs-ui/provider/next";
import { type ReactNode } from "react";

export function Provider({ children }: { children: ReactNode }) {
  // The docs open light and can be switched to dark (the toggle sits in the sidebar); the landing page keeps its
  // own dark palette either way (.landing in global.css).
  return (
    <RootProvider search={{ SearchDialog }} theme={{ defaultTheme: "light", enableSystem: false }}>
      {children}
    </RootProvider>
  );
}
