import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every colour the participant application renders comes from the shared
 * tokens (PLAN.md Phase 12, NFR-15).
 *
 * ── Why a source scan ───────────────────────────────────────────────────────
 * `packages/ui/src/colors.test.ts` proves the PALETTE meets WCAG AA. That is
 * worth nothing if a component quietly writes its own hex literal instead —
 * the palette would stay green while the screen a participant actually sees
 * drifted below the line, and nothing would report it.
 *
 * The check is now stricter than it was: not "is this hex one of the approved
 * ones" but "is there a hex here at all". Colour belongs in
 * `@lpr/ui/theme.css`, and a literal in a component is a value that no
 * contrast test can see and that dark mode cannot follow.
 *
 * Scoped to the participant application deliberately. This is the surface a
 * participant is alone with, on a phone, inside a time-limited window.
 */
const SRC = resolve(process.cwd(), "src");

/**
 * The two places a literal is unavoidable.
 *
 * `theme-color` and the manifest are browser CHROME — the status bar and the
 * task-switcher card — read by the operating system before any stylesheet
 * exists. A CSS variable there resolves to nothing.
 */
const CHROME_COLOUR_FILES = new Set(["layout.tsx", "route.ts"]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !entry.name.includes(".test.") ? [path] : [];
  });
}

describe("participant palette", () => {
  it("declares no colour of its own", () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(SRC)) {
      const name = file.slice(file.lastIndexOf("/") + 1);
      if (CHROME_COLOUR_FILES.has(name)) continue;

      const content = readFileSync(file, "utf8");
      for (const match of content.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
        offenders.push(`${file.slice(SRC.length)}: ${match[0]}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
