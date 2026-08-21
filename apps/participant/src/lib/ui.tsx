"use client";

import type { CSSProperties, ReactNode } from "react";
import { tokens } from "@lpr/ui";

/**
 * Participant-facing primitives.
 *
 * Mobile-first, unlike the researcher dashboard: participants answer on phones,
 * repeatedly, for weeks (AGENT.md §3.5). Every control is at least
 * `touchTargetMinPx`, the column is capped at reading width, and nothing
 * depends on hover.
 */
export const styles = {
  page: {
    maxWidth: tokens.contentMaxWidthPx,
    margin: "0 auto",
    padding: `0 ${String(tokens.spacing.md)}px`,
  } satisfies CSSProperties,
  card: {
    border: "1px solid #d8dbe0",
    borderRadius: tokens.radiusPx,
    padding: tokens.spacing.md,
    marginBottom: tokens.spacing.md,
    background: "#fff",
  } satisfies CSSProperties,
  /** Consent text: generous line height, because it is meant to be read. */
  prose: {
    whiteSpace: "pre-wrap",
    lineHeight: 1.7,
    fontSize: 16,
  } satisfies CSSProperties,
  /**
   * `boxSizing` is load-bearing, not tidiness.
   *
   * These styles are applied to `<a>` as well as `<button>` — a link that looks
   * like a button is how every navigation on the participant screens is drawn.
   * Form controls inherit `border-box` from the user-agent stylesheet and
   * anchors do not, so `width: 100%` plus padding and a border made an anchor
   * two pixels wider than its parent and put a horizontal scrollbar on the home
   * screen at 320px. Stated here so both element types measure the same way.
   */
  button: {
    display: "block",
    width: "100%",
    boxSizing: "border-box",
    minHeight: tokens.touchTargetMinPx,
    padding: `${String(tokens.spacing.sm)}px ${String(tokens.spacing.md)}px`,
    fontSize: 17,
    borderRadius: tokens.radiusPx,
    border: "1px solid #1f2a37",
    background: "#1f2a37",
    color: "#fff",
    cursor: "pointer",
  } satisfies CSSProperties,
  secondaryButton: {
    display: "block",
    width: "100%",
    boxSizing: "border-box",
    minHeight: tokens.touchTargetMinPx,
    padding: `${String(tokens.spacing.sm)}px ${String(tokens.spacing.md)}px`,
    fontSize: 17,
    borderRadius: tokens.radiusPx,
    border: "1px solid #b6bcc4",
    background: "#fff",
    color: "#1f2a37",
    cursor: "pointer",
  } satisfies CSSProperties,
  input: {
    width: "100%",
    // 16px exactly: iOS Safari zooms the viewport on focus for anything
    // smaller, which throws a participant out of the layout mid-form.
    fontSize: 16,
    minHeight: tokens.touchTargetMinPx,
    padding: tokens.spacing.sm,
    borderRadius: tokens.radiusPx,
    border: "1px solid #b6bcc4",
    boxSizing: "border-box",
  } satisfies CSSProperties,
  /** The one place a monospace face earns itself: codes that get transcribed. */
  code: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 24,
    letterSpacing: 2,
    wordBreak: "break-all",
  } satisfies CSSProperties,
} as const;

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
