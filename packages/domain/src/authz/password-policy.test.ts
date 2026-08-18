import { describe, expect, it } from "vitest";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "@lpr/contracts";
import { checkPassword } from "./password-policy.js";

describe("checkPassword", () => {
  it("accepts a reasonable passphrase", () => {
    expect(checkPassword("correct horse battery staple", "ada@example.org")).toEqual({
      ok: true,
      reasons: [],
    });
  });

  it("rejects anything under the minimum length", () => {
    const result = checkPassword("a".repeat(MIN_PASSWORD_LENGTH - 1));
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("TOO_SHORT");
  });

  it("rejects an unbounded password, which is unbounded argon2id CPU", () => {
    const result = checkPassword("x".repeat(MAX_PASSWORD_LENGTH + 1));
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("TOO_LONG");
  });

  it("rejects a password built from the account's own email", () => {
    const result = checkPassword("researcher2026!", "researcher@example.org");
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("CONTAINS_EMAIL");
  });

  it("ignores an email local part too short to mean anything", () => {
    expect(checkPassword("ab-quiet-forest-lake", "ab@example.org").ok).toBe(true);
  });

  it("rejects long but near-entropy-free strings", () => {
    expect(checkPassword("aaaaaaaaaaaaaaaa").reasons).toContain("TOO_REPETITIVE");
    expect(checkPassword("abababababababab").reasons).toContain("TOO_REPETITIVE");
    expect(checkPassword("abcdabcdabcdabcd").reasons).toContain("TOO_REPETITIVE");
  });

  it("rejects well-known weak choices regardless of case", () => {
    expect(checkPassword("Password1234").reasons).toContain("COMMON_PASSWORD");
    expect(checkPassword("parola123456").reasons).toContain("COMMON_PASSWORD");
  });

  it("reports every failing reason at once, so the user fixes them in one pass", () => {
    const result = checkPassword("aaaa", "aaaa@example.org");
    expect(result.ok).toBe(false);
    expect(result.reasons).toEqual(expect.arrayContaining(["TOO_SHORT", "TOO_REPETITIVE"]));
  });

  it("imposes no character-class rule (NIST SP 800-63B)", () => {
    expect(checkPassword("the quiet forest hums").ok).toBe(true);
  });
});
