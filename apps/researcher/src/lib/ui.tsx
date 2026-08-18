"use client";

import type { CSSProperties, ReactNode } from "react";
import { tokens } from "@lpr/ui";

/**
 * Minimal presentational primitives for the Phase 2 screens.
 *
 * Deliberately small. AGENT.md §10 asks the researcher interface to favour
 * information density and clarity over ornament, and @lpr/ui exists so that
 * components arrive with the screens that need them rather than as a
 * speculative library nobody uses.
 */

export const styles = {
  page: { maxWidth: 900, margin: "0 auto" } satisfies CSSProperties,
  card: {
    border: "1px solid #d8dbe0",
    borderRadius: tokens.radiusPx,
    padding: tokens.spacing.md,
    marginBottom: tokens.spacing.md,
    background: "#fff",
  } satisfies CSSProperties,
  label: {
    display: "block",
    marginBottom: tokens.spacing.xs,
    fontWeight: 600,
    fontSize: 14,
  } satisfies CSSProperties,
  input: {
    width: "100%",
    padding: tokens.spacing.sm,
    fontSize: 16,
    minHeight: tokens.touchTargetMinPx,
    borderRadius: tokens.radiusPx,
    border: "1px solid #b6bcc4",
    boxSizing: "border-box",
  } satisfies CSSProperties,
  field: { marginBottom: tokens.spacing.md } satisfies CSSProperties,
  button: {
    minHeight: tokens.touchTargetMinPx,
    padding: `${tokens.spacing.sm}px ${tokens.spacing.md}px`,
    fontSize: 16,
    borderRadius: tokens.radiusPx,
    border: "1px solid #1f2a37",
    background: "#1f2a37",
    color: "#fff",
    cursor: "pointer",
  } satisfies CSSProperties,
  secondaryButton: {
    minHeight: tokens.touchTargetMinPx,
    padding: `${tokens.spacing.sm}px ${tokens.spacing.md}px`,
    fontSize: 16,
    borderRadius: tokens.radiusPx,
    border: "1px solid #b6bcc4",
    background: "#fff",
    color: "#1f2a37",
    cursor: "pointer",
  } satisfies CSSProperties,
  table: { width: "100%", borderCollapse: "collapse", fontSize: 14 } satisfies CSSProperties,
  cell: {
    textAlign: "left",
    padding: tokens.spacing.sm,
    borderBottom: "1px solid #e6e8eb",
  } satisfies CSSProperties,
} as const;

/**
 * An error banner.
 *
 * `role="alert"` so a screen reader announces a failed login without the user
 * having to go looking for it (NFR-15).
 */
export function ErrorBanner({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p
      role="alert"
      style={{
        padding: tokens.spacing.sm,
        border: "1px solid #b42318",
        background: "#fef3f2",
        color: "#912018",
        borderRadius: tokens.radiusPx,
      }}
    >
      {children}
    </p>
  );
}

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
        border: "1px solid #b6bcc4",
        background: "#f4f5f7",
      }}
    >
      {status}
    </span>
  );
}
