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
 *
 * ── Why these read CSS variables now ────────────────────────────────────────
 * Every colour comes from `@lpr/ui/theme.css`, the same file the researcher
 * dashboard uses. That is not tidiness: a status colour that means "missed" on
 * one side of the platform and something else on the other is a defect waiting
 * to be read as data, and a participant looking at a consent screen should be
 * looking at something recognisably built by the team running the study.
 *
 * It also means the participant application inherits dark mode for free, which
 * matters more here than on the dashboard — an ESM prompt at 22:00 arrives on a
 * phone that is almost certainly in night mode.
 */
export const styles = {
  page: {
    maxWidth: tokens.contentMaxWidthPx,
    margin: "0 auto",
    padding: `0 ${String(tokens.spacing.md)}px`,
  } satisfies CSSProperties,
  card: {
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
    padding: tokens.spacing.md,
    marginBottom: tokens.spacing.md,
    background: "var(--card)",
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
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    width: "100%",
    boxSizing: "border-box",
    minHeight: tokens.touchTargetMinPx,
    padding: `${String(tokens.spacing.sm)}px ${String(tokens.spacing.md)}px`,
    fontSize: 17,
    fontWeight: 500,
    borderRadius: "var(--radius)",
    border: "1px solid var(--primary)",
    background: "var(--primary)",
    color: "var(--primary-foreground)",
    cursor: "pointer",
    textDecoration: "none",
  } satisfies CSSProperties,
  secondaryButton: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    width: "100%",
    boxSizing: "border-box",
    minHeight: tokens.touchTargetMinPx,
    padding: `${String(tokens.spacing.sm)}px ${String(tokens.spacing.md)}px`,
    fontSize: 17,
    fontWeight: 500,
    borderRadius: "var(--radius)",
    border: "1px solid var(--input)",
    background: "var(--background)",
    color: "var(--foreground)",
    cursor: "pointer",
    textDecoration: "none",
  } satisfies CSSProperties,
  input: {
    width: "100%",
    // 16px exactly: iOS Safari zooms the viewport on focus for anything
    // smaller, which throws a participant out of the layout mid-form.
    fontSize: 16,
    minHeight: tokens.touchTargetMinPx,
    padding: tokens.spacing.sm,
    borderRadius: "var(--radius)",
    // `--input`, not `--border`: WCAG 1.4.11 holds a control's boundary to
    // 3:1, and an answer box a participant cannot find is an unanswered item.
    border: "1px solid var(--input)",
    background: "var(--background)",
    color: "var(--foreground)",
    boxSizing: "border-box",
  } satisfies CSSProperties,
  /** The one place a monospace face earns itself: codes that get transcribed. */
  code: {
    fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
    fontSize: 24,
    letterSpacing: 2,
    wordBreak: "break-all",
  } satisfies CSSProperties,
  /** Secondary copy: hints, timestamps, the sentence under a heading. */
  muted: {
    color: "var(--muted-foreground)",
    fontSize: 14,
  } satisfies CSSProperties,
} as const;

export function ErrorBanner({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p
      role="alert"
      className="border-danger/40 bg-danger-muted text-danger-muted-foreground mb-4 rounded-lg border px-4 py-3"
    >
      {children}
    </p>
  );
}

/**
 * A confirmation, for the moments a participant needs to be told something
 * worked.
 *
 * `role="status"` rather than `alert`: this is not urgent, and an assertive
 * announcement would interrupt whatever a screen-reader user was in the middle
 * of hearing.
 */
export function SuccessBanner({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p
      role="status"
      className="border-success/40 bg-success-muted text-success-muted-foreground mb-4 rounded-lg border px-4 py-3"
    >
      {children}
    </p>
  );
}
