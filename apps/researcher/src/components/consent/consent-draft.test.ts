import { describe, expect, it } from "vitest";
import { missingConsentLocales, reconcileSavedConsentTranslation } from "./consent-draft";

describe("missingConsentLocales", () => {
  it("requires complete saved wording for every language the study offers", () => {
    expect(
      missingConsentLocales(
        ["en", "tr"],
        [{ locale: "tr", title: "Onam", body: "Araştırma ekibinin onayladığı metin." }],
      ),
    ).toEqual(["en"]);
  });

  it("treats whitespace-only persisted fields as missing", () => {
    expect(missingConsentLocales(["tr"], [{ locale: "tr", title: "Onam", body: "   " }])).toEqual([
      "tr",
    ]);
  });

  it("allows publishing only after every supported language is complete", () => {
    expect(
      missingConsentLocales(
        ["en", "tr"],
        [
          { locale: "en", title: "Consent", body: "Research-team-approved wording." },
          { locale: "tr", title: "Onam", body: "Araştırma ekibinin onayladığı metin." },
        ],
      ),
    ).toEqual([]);
  });
});

describe("reconcileSavedConsentTranslation", () => {
  const submitted = { title: " Consent ", body: " Saved wording. " };
  const saved = { title: "Consent", body: "Saved wording." };

  it("normalises fields when nothing changed during the request", () => {
    expect(reconcileSavedConsentTranslation(submitted, submitted, saved)).toEqual(saved);
  });

  it("preserves edits typed while the save request was in flight", () => {
    const edited = { title: "Consent — revised", body: "New unsaved wording." };
    expect(reconcileSavedConsentTranslation(edited, submitted, saved)).toBe(edited);
  });
});
