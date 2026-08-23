import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The dashboard declares no colour of its own.
 *
 * ── Why this matters more than it looks ─────────────────────────────────────
 * `packages/ui/src/colors.test.ts` proves the palette meets WCAG AA. A hex
 * literal in a component sidesteps that entirely: the palette stays green while
 * the screen drifts below the line, and nothing reports it. A literal also
 * cannot follow dark mode, so one stray `#fff` is a white card on a dark page.
 *
 * Everything therefore comes from `@lpr/ui/theme.css`, whether the component
 * uses a Tailwind class (`text-muted-foreground`) or an inline style
 * (`var(--muted-foreground)` — see `lib/ui.tsx` for why some still do).
 *
 * `components/ui/` is excluded: those files are vendored from shadcn and are
 * updated by re-running its CLI, so a local edit to satisfy this test would be
 * silently reverted the next time somebody does.
 */
const SRC = resolve(process.cwd(), "src");
const VENDORED = join(SRC, "components", "ui");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (path.startsWith(VENDORED)) return [];
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !entry.name.includes(".test.") ? [path] : [];
  });
}

describe("researcher palette", () => {
  it("uses tokens rather than hex literals", () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(SRC)) {
      const content = readFileSync(file, "utf8");
      for (const match of content.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
        offenders.push(`${file.slice(SRC.length)}: ${match[0]}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
