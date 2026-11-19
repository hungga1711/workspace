"use client";

import { Component, type ReactNode } from "react";
import { ErrorScreen } from "@/components/ui/ErrorScreen";
import { mintErrorCode, reportClientError } from "@/components/rum/report";

type Caught = Error & { digest?: string };

/**
 * Our own boundary inside the app shell. Next's error.tsx receives only the error; a render or effect error then
 * reports a stack of React internals and nothing names the component. componentDidCatch gets the owner chain, so the
 * report filed under the C-code tells the admin which component broke.
 */
export class CatchBoundary extends Component<{ children: ReactNode; home?: string }, { error: Caught | null }> {
  override state: { error: Caught | null } = { error: null };
  static getDerivedStateFromError(error: Caught) {
    error.digest ??= mintErrorCode();
    return { error };
  }
  override componentDidCatch(error: Caught, info: { componentStack?: string | null }) {
    reportClientError({ message: error.message, stack: error.stack, componentStack: info.componentStack ?? undefined, digest: error.digest, kind: "boundary" });
  }
  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return <ErrorScreen error={error} reset={() => this.setState({ error: null })} home={this.props.home ?? "/app/home"} reported />;
  }
}
