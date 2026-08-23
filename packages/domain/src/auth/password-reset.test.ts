import { describe, expect, it } from "vitest";
import {
  RESET_TOKEN_BYTES,
  RESET_TOKEN_LENGTH,
  RESET_TOKEN_TTL_MINUTES,
  evaluateResetToken,
  generateResetToken,
  isResetTokenShape,
  resetExpiresAt,
} from "./password-reset.js";

const NOW = new Date("2026-08-23T12:00:00.000Z");

describe("reset token generation", () => {
  it("encodes the full entropy as hex", () => {
    const bytes = new Uint8Array(Array.from({ length: RESET_TOKEN_BYTES }, (_, i) => i));

    const token = generateResetToken(bytes);

    expect(token).toHaveLength(RESET_TOKEN_LENGTH);
    expect(token.startsWith("000102")).toBe(true);
    expect(isResetTokenShape(token)).toBe(true);
  });

  /**
   * A byte below 16 must not lose its leading zero.
   *
   * Without the pad, a token containing small bytes comes out SHORTER, which
   * silently reduces entropy and — worse — makes two different byte sequences
   * encode to the same string. Two accounts could then share a reset token.
   */
  it("pads every byte, so no two byte sequences collide", () => {
    const a = generateResetToken(new Uint8Array(RESET_TOKEN_BYTES).fill(1));
    const b = new Uint8Array(RESET_TOKEN_BYTES).fill(1);
    b[0] = 16;

    expect(a).toHaveLength(RESET_TOKEN_LENGTH);
    expect(generateResetToken(b)).toHaveLength(RESET_TOKEN_LENGTH);
    expect(generateResetToken(b)).not.toBe(a);
  });

  it("refuses to mint a token from too little randomness", () => {
    expect(() => generateResetToken(new Uint8Array(RESET_TOKEN_BYTES - 1))).toThrow(
      /at least 32 random bytes/,
    );
  });

  it("rejects anything that is not a full-length lowercase hex string", () => {
    expect(isResetTokenShape("")).toBe(false);
    expect(isResetTokenShape("a".repeat(RESET_TOKEN_LENGTH - 1))).toBe(false);
    expect(isResetTokenShape("A".repeat(RESET_TOKEN_LENGTH))).toBe(false);
    expect(isResetTokenShape(`${"a".repeat(RESET_TOKEN_LENGTH - 1)}!`)).toBe(false);
  });
});

describe("reset token expiry", () => {
  it("expires an hour after it was issued", () => {
    expect(resetExpiresAt(NOW).toISOString()).toBe("2026-08-23T13:00:00.000Z");
    expect(RESET_TOKEN_TTL_MINUTES).toBe(60);
  });

  it("is usable inside the window", () => {
    const state = { expiresAt: resetExpiresAt(NOW), usedAt: null };

    expect(evaluateResetToken(state, new Date(NOW.getTime() + 59 * 60_000))).toEqual({
      usable: true,
    });
  });

  /**
   * The boundary is closed, not open: a token expiring exactly now is spent.
   *
   * An off-by-one in the other direction keeps a credential alive for one more
   * tick, which is the wrong way for a defence to fail.
   */
  it("is not usable at the instant it expires", () => {
    const expiresAt = resetExpiresAt(NOW);

    expect(evaluateResetToken({ expiresAt, usedAt: null }, expiresAt)).toEqual({
      usable: false,
      reason: "EXPIRED",
    });
  });

  it("is not usable twice", () => {
    const state = { expiresAt: resetExpiresAt(NOW), usedAt: new Date(NOW.getTime() + 60_000) };

    expect(evaluateResetToken(state, new Date(NOW.getTime() + 120_000))).toEqual({
      usable: false,
      reason: "ALREADY_USED",
    });
  });

  /**
   * Both wrong at once reports EXPIRED, because that is the one the researcher
   * can do something about: request another link. "Already used" would send
   * somebody looking for a link they have lost.
   */
  it("reports expiry rather than reuse when a token is both", () => {
    const expiresAt = resetExpiresAt(NOW);

    expect(
      evaluateResetToken(
        { expiresAt, usedAt: new Date(NOW.getTime() + 60_000) },
        new Date(expiresAt.getTime() + 1),
      ),
    ).toEqual({ usable: false, reason: "EXPIRED" });
  });
});
