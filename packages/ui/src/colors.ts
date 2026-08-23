/**
 * The colour palette, named by role (PLAN.md Phase 12, NFR-15).
 *
 * ── Why these exist as tokens rather than as hex literals in components ─────
 * Contrast is a property of a PAIR — a foreground on a background — and it can
 * only be checked if both halves are written down somewhere a test can read
 * them. Scattered through JSX they are invisible to any check, and the failure
 * they produce is invisible too: text at 3:1 looks fine to the person who chose
 * it and is unreadable outdoors, on a cheap phone, or to a participant with
 * low vision. This platform is used on phones, outdoors, by people who did not
 * choose it.
 *
 * Every pair actually used is asserted against WCAG AA in `colors.test.ts`.
 */
export const colors = {
  /** Body text and headings. */
  text: "#1f2a37",
  /** Secondary text: hints, timestamps, help. Still AA on white. */
  textMuted: "#5b6472",
  /** Muted text on a tinted surface, where the tint costs a little contrast. */
  textMutedOnTint: "#56606d",

  surface: "#ffffff",
  /** Page background behind cards. */
  surfaceSunken: "#e6e8eb",
  /**
   * The hairline around a card. DECORATIVE, and deliberately not held to 3:1.
   *
   * WCAG 1.4.11 covers boundaries required to identify a control or to
   * understand content. A card is neither: it is a container, it is already
   * separated from the page by its own background, and nothing is lost if the
   * hairline is not perceived. Darkening it to pass a rule that does not apply
   * would make every screen louder for no one's benefit — and asserting it here
   * would be inventing a requirement, which devalues the ones that are real.
   */
  border: "#d8dbe0",
  /**
   * Border on an unselected control — a radio, a checkbox, a text field.
   *
   * WCAG 1.4.11 requires 3:1 for the visual information needed to IDENTIFY a
   * control, and this is that boundary: it is the only thing distinguishing an
   * empty input from the page around it. This was `#b6bcc4` (1.91:1) until the
   * contrast test was written, which is a control a participant with low vision
   * simply cannot find on a phone in daylight.
   */
  borderControl: "#858c96",

  /** Error text and borders. */
  danger: "#b42318",
  /** Error text on the error tint, which needs to be darker than `danger`. */
  dangerStrong: "#912018",
  dangerSurface: "#fef3f2",

  /** Warning text and borders. */
  warning: "#b54708",
  warningSurface: "#fffaeb",

  /** A barely-tinted surface used behind inline notices. */
  surfaceTintDanger: "#fffaf9",
} as const;

export type Colors = typeof colors;

/**
 * Relative luminance, per WCAG 2.1.
 *
 * Exported because the contrast test is the point of this module, and a test
 * that reimplemented the formula could agree with a wrong implementation.
 */
export function relativeLuminance(hex: string): number {
  const value = hex.replace("#", "");
  const full =
    value.length === 3
      ? value
          .split("")
          .map((c) => c + c)
          .join("")
      : value;

  const channels = [0, 2, 4].map((offset) => {
    const srgb = Number.parseInt(full.slice(offset, offset + 2), 16) / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : Math.pow((srgb + 0.055) / 1.055, 2.4);
  });

  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

/** WCAG contrast ratio between two colours. Ranges from 1 to 21. */
export function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const [lighter, darker] = a > b ? [a, b] : [b, a];
  return (lighter + 0.05) / (darker + 0.05);
}

/** WCAG AA: 4.5:1 for body text. */
export const AA_TEXT = 4.5;
/** WCAG AA: 3:1 for large text and for the boundary of a UI control. */
export const AA_LARGE_TEXT_OR_UI = 3;
