import { describe, expect, it } from "vitest";
import { resetEmail } from "./reset-email.js";

const URL_EN = "https://example.org/en/reset-password?token=abc";
const URL_TR = "https://example.org/tr/reset-password?token=abc";

/**
 * The reset email is the one message a researcher receives outside the
 * application, and it is about an account security event.
 *
 * An English wall of text arriving at a Turkish researcher, asking them to
 * click a link, is precisely the message a careful person deletes — so a
 * missing translation here does not degrade the experience, it defeats the
 * feature.
 */
describe("password reset email", () => {
  it("is genuinely translated, not the English text reused", () => {
    const en = resetEmail("en", URL_EN);
    const tr = resetEmail("tr", URL_TR);

    expect(tr.subject).not.toBe(en.subject);
    expect(tr.text).not.toBe(en.text);
    expect(tr.text).toContain("bir saat");
  });

  it("carries the link, and only the link, as a URL", () => {
    for (const [locale, url] of [
      ["en", URL_EN],
      ["tr", URL_TR],
    ] as const) {
      const { text } = resetEmail(locale, url);

      expect(text).toContain(url);
      // Exactly one URL. A second link in a security email is a phishing
      // pattern and gives a reader one more thing to have to judge.
      expect(text.match(/https?:\/\//g)).toHaveLength(1);
    }
  });

  /**
   * Both languages must say the three things that make the message safe to
   * act on: it expires, it is single use, and doing nothing is safe.
   */
  it.each(["en", "tr"] as const)("%s tells the reader what the link does", (locale) => {
    const { text } = resetEmail(locale, URL_EN);

    const expectations =
      locale === "en"
        ? ["within one hour", "works once", "no action is needed"]
        : ["bir saat", "bir kez", "yapmanız gereken bir şey yok"];

    for (const phrase of expectations) expect(text).toContain(phrase);
  });

  it("is plain text with no markup", () => {
    for (const locale of ["en", "tr"] as const) {
      expect(resetEmail(locale, URL_EN).text).not.toMatch(/<[a-z]/i);
    }
  });
});
