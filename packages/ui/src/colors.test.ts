import { describe, expect, it } from "vitest";
import { AA_LARGE_TEXT_OR_UI, AA_TEXT, colors, contrastRatio } from "./colors";

/**
 * Contrast, checked arithmetically (PLAN.md Phase 12).
 *
 * ── Why here and not in axe ─────────────────────────────────────────────────
 * axe computes contrast by rasterising rendered text, which needs a canvas.
 * Under jsdom the rule does not fail — it SKIPS, and a suite that reports a
 * contrast check which never ran is worse than one that admits it has none.
 * The formula is short and fully specified, so it is checked directly against
 * the palette instead, and the axe rule is switched off explicitly where it
 * cannot run.
 */
describe("palette contrast (WCAG AA)", () => {
  it("computes the reference ratios from WCAG correctly", () => {
    // Black on white is exactly 21:1 and white on white exactly 1:1. If the
    // implementation is wrong, these move, and every assertion below would be
    // measuring the wrong thing while looking convincing.
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    // A published mid-grey: #767676 on white is the canonical 4.54:1 boundary.
    expect(contrastRatio("#767676", "#ffffff")).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrastRatio("#777777", "#ffffff")).toBeLessThan(AA_TEXT);
  });

  const bodyTextPairs: [name: string, fg: string, bg: string][] = [
    ["body text on white", colors.text, colors.surface],
    ["muted text on white", colors.textMuted, colors.surface],
    ["muted text on the sunken page background", colors.textMutedOnTint, colors.surfaceSunken],
    ["error text on white", colors.danger, colors.surface],
    ["error text on the error tint", colors.dangerStrong, colors.dangerSurface],
    ["error text on the faint error tint", colors.danger, colors.surfaceTintDanger],
    ["warning text on the warning tint", colors.warning, colors.warningSurface],
    ["white text on the selected control", colors.surface, colors.text],
  ];

  it.each(bodyTextPairs)("%s reaches AA for body text", (_name, fg, bg) => {
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  /**
   * Control boundaries have a lower bar (3:1) but are not exempt.
   *
   * An unselected radio whose outline is invisible is a control a participant
   * cannot find. This is the pair most often got wrong, because it looks
   * "clean" to the person choosing it.
   */
  const uiPairs: [name: string, fg: string, bg: string][] = [
    ["unselected control border on white", colors.borderControl, colors.surface],
  ];

  // `colors.border` is absent on purpose. It is a decorative card hairline, not
  // a control boundary, and WCAG 1.4.11 does not reach it — see the note on the
  // token. Asserting it would be inventing a requirement.

  it.each(uiPairs)("%s reaches AA for a UI boundary", (_name, fg, bg) => {
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(AA_LARGE_TEXT_OR_UI);
  });
});
