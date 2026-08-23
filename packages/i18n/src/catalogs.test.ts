import { describe, expect, it } from "vitest";
import en from "../messages/en.json";
import tr from "../messages/tr.json";
import { parseAcceptLanguage, resolveLocale } from "./index.js";

/** Flattens a nested catalog into dotted key paths. */
function keyPaths(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    keyPaths(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe("translation catalogs", () => {
  // Catches the most common i18n regression: a string added in one language
  // and forgotten in the other, which ships as a raw key to real participants.
  it("English and Turkish define exactly the same keys", () => {
    const enKeys = keyPaths(en).sort();
    const trKeys = keyPaths(tr).sort();

    const missingInTr = enKeys.filter((k) => !trKeys.includes(k));
    const missingInEn = trKeys.filter((k) => !enKeys.includes(k));

    expect({ missingInTr, missingInEn }).toEqual({ missingInTr: [], missingInEn: [] });
  });

  /**
   * Catch a string that was added in English and pasted, untranslated, into
   * Turkish (Phase 12).
   *
   * Key parity above catches a MISSING key, which ships as a raw key and is
   * obvious. This catches the quieter failure: a present key whose Turkish is
   * still the English text. A Turkish participant then reads English in the
   * middle of an otherwise translated screen and has no way to tell whether
   * the study meant it.
   *
   * The allowlist is for entries that are legitimately identical because they
   * contain no words — a format string of placeholders and punctuation, an
   * em-dash. Anything else identical in both catalogs is untranslated.
   */
  it("has no Turkish string left identical to its English source", () => {
    const WORDLESS = new Set(["protocols.preview.occurrenceLine", "analytics.noValue"]);

    const identical = keyPaths(en).filter(
      (key) =>
        !WORDLESS.has(key) &&
        typeof resolvePath(en, key) === "string" &&
        resolvePath(en, key) === resolvePath(tr, key),
    );

    expect(identical).toEqual([]);
  });

  it("has no empty translation values", () => {
    const empties = [
      ...keyPaths(en).filter((k) => resolvePath(en, k) === ""),
      ...keyPaths(tr).filter((k) => resolvePath(tr, k) === ""),
    ];
    expect(empties).toEqual([]);
  });
});

function resolvePath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (typeof acc !== "object" || acc === null) return undefined;
    return (acc as Record<string, unknown>)[key];
  }, obj);
}

describe("resolveLocale", () => {
  it("prefers the URL segment over every other signal", () => {
    expect(
      resolveLocale({
        fromUrl: "tr",
        fromParticipantPreference: "en",
        fromStudyDefault: "en",
        fromAcceptLanguage: "en-GB",
      }),
    ).toBe("tr");
  });

  it("falls back through preference, then study default", () => {
    expect(resolveLocale({ fromUrl: null, fromParticipantPreference: "tr" })).toBe("tr");
    expect(resolveLocale({ fromUrl: null, fromStudyDefault: "tr" })).toBe("tr");
  });

  it("ignores unsupported locales rather than passing them through", () => {
    expect(resolveLocale({ fromUrl: "de", fromStudyDefault: "tr" })).toBe("tr");
  });

  it("defaults to English when nothing is usable", () => {
    expect(resolveLocale({})).toBe("en");
  });
});

describe("parseAcceptLanguage", () => {
  it("picks the highest-quality supported tag", () => {
    expect(parseAcceptLanguage("de;q=0.9,tr;q=0.8,en;q=0.7")).toBe("tr");
  });

  it("matches on the base subtag", () => {
    expect(parseAcceptLanguage("tr-TR,tr;q=0.9")).toBe("tr");
  });

  it("returns null when nothing is supported", () => {
    expect(parseAcceptLanguage("de-DE,fr;q=0.9")).toBeNull();
    expect(parseAcceptLanguage(null)).toBeNull();
  });
});
