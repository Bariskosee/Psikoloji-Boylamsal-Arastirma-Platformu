"use client";

import type { CSSProperties, ReactNode } from "react";

/**
 * The bridge between the inline-styled screens and the design tokens.
 *
 * ── Why this file still exists after the shadcn migration ───────────────────
 * The two builders — questionnaire and protocol — carry several hundred lines
 * of dense, well-tested editor markup whose behaviour is the risky part of this
 * application. Rewriting all of it as Tailwind would be a large diff through
 * the code most likely to break a study, for a visual result these few objects
 * achieve directly.
 *
 * So instead of hard-coded hex and pixel values, every property here now reads
 * a CSS custom property from `@lpr/ui/theme.css` — the same variables the
 * shadcn components use. An `<input style={styles.input}>` and a `<Input />`
 * therefore render the same control, and changing the palette changes both.
 *
 * New screens should use the components in `components/ui/`. This is for the
 * ones that already existed.
 */

const CONTROL_HEIGHT = 36;

export const styles = {
  page: { maxWidth: 900, margin: "0 auto" } satisfies CSSProperties,
  card: {
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
    padding: 16,
    marginBottom: 16,
    background: "var(--card)",
  } satisfies CSSProperties,
  label: {
    display: "block",
    marginBottom: 6,
    fontWeight: 500,
    fontSize: 14,
    color: "var(--foreground)",
  } satisfies CSSProperties,
  input: {
    width: "100%",
    padding: "6px 10px",
    fontSize: 14,
    minHeight: CONTROL_HEIGHT,
    borderRadius: "calc(var(--radius) - 2px)",
    // `--input` rather than `--border`: this is the boundary of a CONTROL,
    // which WCAG 1.4.11 holds to 3:1, and an input nobody can find is an input
    // nobody fills in.
    border: "1px solid var(--input)",
    background: "var(--background)",
    color: "var(--foreground)",
    boxSizing: "border-box",
  } satisfies CSSProperties,
  field: { marginBottom: 16 } satisfies CSSProperties,
  button: {
    minHeight: CONTROL_HEIGHT,
    padding: "6px 14px",
    fontSize: 14,
    fontWeight: 500,
    borderRadius: "calc(var(--radius) - 2px)",
    border: "1px solid var(--primary)",
    background: "var(--primary)",
    color: "var(--primary-foreground)",
    cursor: "pointer",
  } satisfies CSSProperties,
  secondaryButton: {
    minHeight: CONTROL_HEIGHT,
    padding: "6px 12px",
    fontSize: 14,
    fontWeight: 500,
    borderRadius: "calc(var(--radius) - 2px)",
    border: "1px solid var(--input)",
    background: "var(--background)",
    color: "var(--foreground)",
    cursor: "pointer",
  } satisfies CSSProperties,
  table: { width: "100%", borderCollapse: "collapse", fontSize: 14 } satisfies CSSProperties,
  cell: {
    textAlign: "left",
    padding: "10px 12px",
    borderBottom: "1px solid var(--border)",
  } satisfies CSSProperties,
} as const;

/**
 * Wraps a table so a narrow screen scrolls the TABLE rather than the PAGE.
 *
 * `width: 100%` alone does not prevent overflow — a table still grows to fit
 * its content, so on a phone the members table pushed its last column past the
 * viewport and the whole document scrolled sideways, taking the header and
 * every other section with it.
 *
 * `tabIndex={0}` because a scrollable region has to be reachable by keyboard;
 * without it the overflowing columns are unreachable without a pointer.
 */
export function TableScroll({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <div
      className="max-w-full overflow-x-auto"
      style={{ WebkitOverflowScrolling: "touch" }}
      tabIndex={0}
      role="region"
      aria-label={label}
    >
      {children}
    </div>
  );
}

/**
 * An error banner.
 *
 * `role="alert"` so a screen reader announces a failure without the user
 * having to go looking for it (NFR-15).
 */
export function ErrorBanner({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p
      role="alert"
      className="border-danger/40 bg-danger-muted text-danger-muted-foreground mb-4 rounded-lg border px-4 py-3 text-sm"
    >
      {children}
    </p>
  );
}

/**
 * A neutral status pill, for the inline-styled screens.
 *
 * New code should use `components/ui/status-badge`, which colours a status by
 * what it MEANS. This one stays neutral on purpose: it is used where the value
 * is a version number or a free label rather than a known state, and guessing a
 * colour for an unknown string is how a badge ends up claiming something.
 */
export function StatusBadge({ status }: { status: string }) {
  return (
    <span className="bg-muted text-muted-foreground inline-block rounded-full px-2 py-0.5 text-xs font-medium">
      {status}
    </span>
  );
}
