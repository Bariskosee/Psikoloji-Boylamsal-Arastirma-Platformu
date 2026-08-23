import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { colors } from "@lpr/ui";

/**
 * Every colour the participant application renders is one the contrast test
 * knows about (PLAN.md Phase 12, NFR-15).
 *
 * ── Why a source scan rather than a rendering check ─────────────────────────
 * `packages/ui/src/colors.test.ts` proves the PALETTE meets WCAG AA. That is
 * worth nothing if a component quietly writes its own hex literal instead —
 * the palette would stay green while the screen a participant actually sees
 * drifted below the line, and nothing would report it.
 *
 * This closes that gap from the other end: the set of colours in the source
 * must be a subset of the set that was checked. It is a crude test and it is
 * the only one that makes the contrast test load-bearing.
 *
 * Scoped to the participant application deliberately. This is the surface a
 * participant is alone with, on a phone, inside a time-limited window; the
 * researcher dashboard has not been migrated and is noted as such in PLAN.md.
 */
// Resolved from the Vitest root (the app directory) rather than from
// `import.meta.url`: the jsdom environment does not give the module a file URL.
const SRC = resolve(process.cwd(), "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !entry.name.includes(".test.") ? [path] : [];
  });
}

describe("participant palette", () => {
  it("uses no colour that the contrast test has not checked", () => {
    const allowed = new Set(
      Object.values(colors).map((value) => value.toLowerCase()),
      // `#fff` and `#ffffff` are the same colour written two ways.
    );
    allowed.add("#fff");

    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const content = readFileSync(file, "utf8");
      for (const match of content.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
        const hex = match[0].toLowerCase();
        if (!allowed.has(hex)) offenders.push(`${file.slice(SRC.length)}: ${hex}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
