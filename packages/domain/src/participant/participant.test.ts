import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_GRACE_PERIOD_DAYS,
  CREDENTIAL_ROTATION_AFTER_DAYS,
  evaluateCredential,
  graceExpiresAt,
} from "./continuity.js";
import { allocateGroup, type AllocatableGroup } from "./group-allocation.js";
import {
  HANDOFF_CODE_BYTES,
  HANDOFF_CODE_LENGTH,
  HANDOFF_CODE_TTL_HOURS,
  evaluateHandoffCode,
  generateHandoffCode,
  handoffExpiresAt,
} from "./handoff.js";
import { generatePublicCode, generateRecoveryCode, normalizeRecoveryCode } from "./identity.js";

const DAY = 86_400_000;
const T0 = new Date("2026-01-01T00:00:00Z");
const at = (days: number): Date => new Date(T0.getTime() + days * DAY);

describe("participant codes", () => {
  const bytes = (values: number[]): Uint8Array => new Uint8Array(values);

  it("prefixes a public code and uses the unambiguous alphabet", () => {
    const code = generatePublicCode(bytes([0, 1, 2, 3, 4, 5, 6, 7]));

    expect(code).toMatch(/^P-[0-9A-HJKMNP-TV-Z]{6}$/);
  });

  it("produces an eight-character recovery code", () => {
    const code = generateRecoveryCode(bytes([9, 8, 7, 6, 5, 4, 3, 2]));

    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
  });

  it("refuses to generate from too few bytes rather than repeating them", () => {
    expect(() => generateRecoveryCode(bytes([1, 2]))).toThrow(/random bytes/);
  });

  it("is a pure function of the bytes, so a test can pin an exact code", () => {
    const first = generatePublicCode(bytes([0, 0, 0, 0, 0, 0]));
    const second = generatePublicCode(bytes([0, 0, 0, 0, 0, 0]));

    expect(first).toBe(second);
    expect(first).toBe("P-000000");
  });

  describe("normalising a typed recovery code", () => {
    it("accepts lowercase, spaces and the separators people insert", () => {
      expect(normalizeRecoveryCode(" a1b2-c3d4 ")).toBe("A1B2C3D4");
    });

    it("corrects the Crockford confusions rather than rejecting the attempt", () => {
      // Someone reading off a screen types O for 0 and I or L for 1. Those
      // characters are not in the alphabet, so the correction is unambiguous.
      expect(normalizeRecoveryCode("O0IL")).toBe("0011");
    });
  });
});

describe("continuity credential", () => {
  it("is usable and not yet due for rotation when fresh", () => {
    const verdict = evaluateCredential({ issuedAt: T0, rotatedAt: null, revokedAt: null }, at(1));

    expect(verdict).toEqual({ usable: true, shouldRotate: false });
  });

  it("asks to rotate once it passes the rotation age", () => {
    const verdict = evaluateCredential(
      { issuedAt: T0, rotatedAt: null, revokedAt: null },
      at(CREDENTIAL_ROTATION_AFTER_DAYS),
    );

    expect(verdict).toEqual({ usable: true, shouldRotate: true });
  });

  it("keeps a superseded credential working inside the grace period", () => {
    // The reason the grace period exists: requests already in flight carry the
    // old token, and failing them signs a participant out mid-questionnaire.
    const verdict = evaluateCredential(
      { issuedAt: T0, rotatedAt: at(30), revokedAt: null },
      at(30 + CREDENTIAL_GRACE_PERIOD_DAYS - 1),
    );

    expect(verdict).toEqual({ usable: true, shouldRotate: false });
  });

  it("does not rotate a credential that has already been superseded", () => {
    // Rotating again would chain replacements forever, and the participant's
    // real credential is already the newer one.
    const verdict = evaluateCredential(
      { issuedAt: T0, rotatedAt: at(30), revokedAt: null },
      at(31),
    );

    expect(verdict).toMatchObject({ usable: true, shouldRotate: false });
  });

  it("stops accepting it once the grace period ends", () => {
    const verdict = evaluateCredential(
      { issuedAt: T0, rotatedAt: at(30), revokedAt: null },
      at(30 + CREDENTIAL_GRACE_PERIOD_DAYS),
    );

    expect(verdict).toEqual({ usable: false, reason: "GRACE_EXPIRED" });
  });

  it("treats revocation as immediate, even inside an unexpired grace period", () => {
    // Withdrawal and recovery both revoke, and both have to take effect now.
    const verdict = evaluateCredential(
      { issuedAt: T0, rotatedAt: at(30), revokedAt: at(31) },
      at(32),
    );

    expect(verdict).toEqual({ usable: false, reason: "REVOKED" });
  });

  it("ignores a revocation timestamped in the future", () => {
    const verdict = evaluateCredential({ issuedAt: T0, rotatedAt: null, revokedAt: at(10) }, at(5));

    expect(verdict).toMatchObject({ usable: true });
  });

  it("reports when a rotated credential stops working", () => {
    expect(graceExpiresAt(at(30)).toISOString()).toBe(
      at(30 + CREDENTIAL_GRACE_PERIOD_DAYS).toISOString(),
    );
  });
});

describe("group allocation", () => {
  const group = (key: string, weight: number, isActive = true): AllocatableGroup => ({
    id: `id-${key}`,
    key,
    allocationWeight: weight,
    isActive,
  });

  it("returns null for a study with no groups", () => {
    // A study without groups behaves as a single-group study (FR-45), so this
    // is an ordinary answer rather than an error the caller special-cases.
    expect(allocateGroup([], 0.5)).toBeNull();
  });

  it("splits an even two-way allocation at the midpoint", () => {
    const groups = [group("a", 1), group("b", 1)];

    expect(allocateGroup(groups, 0.49)?.key).toBe("a");
    expect(allocateGroup(groups, 0.51)?.key).toBe("b");
  });

  it("honours unequal weights", () => {
    const groups = [group("control", 3), group("treatment", 1)];

    expect(allocateGroup(groups, 0.74)?.key).toBe("control");
    expect(allocateGroup(groups, 0.76)?.key).toBe("treatment");
  });

  it("skips a group that is defined but not recruiting", () => {
    const groups = [group("closed", 5, false), group("open", 1)];

    expect(allocateGroup(groups, 0.1)?.key).toBe("open");
    expect(allocateGroup(groups, 0.9)?.key).toBe("open");
  });

  it("skips a zero-weight group", () => {
    const groups = [group("paused", 0), group("open", 1)];

    expect(allocateGroup(groups, 0)?.key).toBe("open");
  });

  it("still allocates at the boundary rather than un-grouping the participant", () => {
    // A draw of exactly 1 would otherwise fall off the end and return null,
    // silently leaving a participant ungrouped in a study that has groups.
    const groups = [group("a", 1), group("b", 1)];

    expect(allocateGroup(groups, 1)?.key).toBe("b");
    expect(allocateGroup(groups, 0)?.key).toBe("a");
  });
});

/**
 * The install handoff (STRUCTURE.md §11.4, ADR-007, FR-41).
 *
 * The properties asserted here are the ones that justify putting a secret in a
 * URL at all: it works once, it dies in a day, and it is 128 bits wide.
 */
describe("the install handoff code", () => {
  const bytes = (values: number[]): Uint8Array => new Uint8Array(values);
  const HOUR = 3_600_000;

  it("encodes the full 128 bits as hex", () => {
    const code = generateHandoffCode(
      bytes([0, 1, 15, 16, 127, 128, 200, 255, 1, 2, 3, 4, 5, 6, 7, 8]),
    );

    expect(code).toBe("00010f107f80c8ff0102030405060708");
    expect(code).toHaveLength(HANDOFF_CODE_LENGTH);
    expect(HANDOFF_CODE_LENGTH).toBe(HANDOFF_CODE_BYTES * 2);
  });

  it("refuses to mint a code from too few bytes", () => {
    // Silently padding would produce a short code that still looks right and
    // is orders of magnitude easier to guess.
    expect(() => generateHandoffCode(bytes([1, 2, 3]))).toThrow(/at least 16 random bytes/);
  });

  it("expires twenty-four hours after minting", () => {
    expect(handoffExpiresAt(T0).getTime()).toBe(T0.getTime() + HANDOFF_CODE_TTL_HOURS * HOUR);
  });

  it("is redeemable inside its window", () => {
    const state = { expiresAt: handoffExpiresAt(T0), redeemedAt: null };

    // The flow it has to survive: read instructions, install, get distracted,
    // come back, tap the link.
    expect(evaluateHandoffCode(state, new Date(T0.getTime() + 23 * HOUR))).toEqual({
      redeemable: true,
    });
  });

  it("stops being redeemable exactly at expiry", () => {
    const state = { expiresAt: handoffExpiresAt(T0), redeemedAt: null };

    expect(evaluateHandoffCode(state, handoffExpiresAt(T0))).toEqual({
      redeemable: false,
      reason: "EXPIRED",
    });
  });

  it("refuses a second redemption", () => {
    const state = {
      expiresAt: handoffExpiresAt(T0),
      redeemedAt: new Date(T0.getTime() + HOUR),
    };

    expect(evaluateHandoffCode(state, new Date(T0.getTime() + 2 * HOUR))).toEqual({
      redeemable: false,
      reason: "ALREADY_REDEEMED",
    });
  });

  it("reports a used-then-expired code as used", () => {
    // "You already used this link, you are probably fine" and "that link
    // expired, here is another" send the participant in different directions,
    // and only one of them is true here.
    const state = {
      expiresAt: handoffExpiresAt(T0),
      redeemedAt: new Date(T0.getTime() + HOUR),
    };

    expect(evaluateHandoffCode(state, new Date(T0.getTime() + 48 * HOUR))).toEqual({
      redeemable: false,
      reason: "ALREADY_REDEEMED",
    });
  });
});
