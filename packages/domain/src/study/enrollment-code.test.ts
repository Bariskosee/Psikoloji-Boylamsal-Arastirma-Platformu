import { describe, expect, it } from "vitest";
import { ENROLLMENT_CODE_ALPHABET, ENROLLMENT_CODE_LENGTH } from "@lpr/contracts";
import {
  ENROLLMENT_CODE_BYTES,
  buildEnrollmentUrl,
  generateEnrollmentCode,
  normalizeEnrollmentCode,
} from "./enrollment-code.js";

describe("generateEnrollmentCode", () => {
  it("produces a code of the contracted length from the contracted alphabet", () => {
    const code = generateEnrollmentCode(Uint8Array.from([0, 1, 2, 3, 4, 5]));
    expect(code).toHaveLength(ENROLLMENT_CODE_LENGTH);
    for (const char of code) expect(ENROLLMENT_CODE_ALPHABET).toContain(char);
  });

  it("is deterministic in its input bytes, so it is testable without a CSPRNG", () => {
    const bytes = Uint8Array.from([10, 200, 33, 255, 0, 128]);
    expect(generateEnrollmentCode(bytes)).toBe(generateEnrollmentCode(bytes));
  });

  it("maps bytes uniformly across the alphabet", () => {
    // 256 is an exact multiple of 32, so byte % 32 has no modulo bias. Feeding
    // every byte value must hit all 32 characters exactly 8 times.
    const counts = new Map<string, number>();
    for (let byte = 0; byte < 256; byte += 1) {
      const char = generateEnrollmentCode(Uint8Array.from(Array(6).fill(byte)))[0] as string;
      counts.set(char, (counts.get(char) ?? 0) + 1);
    }
    expect(counts.size).toBe(ENROLLMENT_CODE_ALPHABET.length);
    for (const count of counts.values()) expect(count).toBe(8);
  });

  it("never emits a visually ambiguous character", () => {
    for (let byte = 0; byte < 256; byte += 1) {
      const code = generateEnrollmentCode(Uint8Array.from(Array(6).fill(byte)));
      expect(code).not.toMatch(/[ILOU]/);
    }
  });

  it("refuses to run on insufficient randomness rather than padding it", () => {
    expect(() => generateEnrollmentCode(new Uint8Array(ENROLLMENT_CODE_BYTES - 1))).toThrow(
      /random bytes/,
    );
  });
});

describe("normalizeEnrollmentCode", () => {
  it("accepts a canonical code unchanged", () => {
    expect(normalizeEnrollmentCode("A1B2C3")).toBe("A1B2C3");
  });

  it("accepts lowercase, whitespace, and hyphens as typed by a person", () => {
    expect(normalizeEnrollmentCode("  a1b-2c3 ")).toBe("A1B2C3");
  });

  it("applies the Crockford confusions I/L → 1 and O → 0", () => {
    expect(normalizeEnrollmentCode("IL0A2B")).toBe("110A2B");
    expect(normalizeEnrollmentCode("OO1234")).toBe("001234");
  });

  it("rejects U rather than guessing which study was meant", () => {
    // Crockford excludes U deliberately. Rewriting it to V would resolve a typo
    // into a DIFFERENT valid study, which is worse than "no such study".
    expect(normalizeEnrollmentCode("U12345")).toBeNull();
  });

  it("rejects wrong lengths and out-of-alphabet characters", () => {
    expect(normalizeEnrollmentCode("A1B2C")).toBeNull();
    expect(normalizeEnrollmentCode("A1B2C34")).toBeNull();
    expect(normalizeEnrollmentCode("A1B2C!")).toBeNull();
    expect(normalizeEnrollmentCode("")).toBeNull();
  });
});

describe("buildEnrollmentUrl", () => {
  it("builds the join URL from the configured participant origin (FR-01)", () => {
    expect(buildEnrollmentUrl("https://app.example.org", "A1B2C3")).toBe(
      "https://app.example.org/join/A1B2C3",
    );
  });

  it("works with a local development origin including a port", () => {
    expect(buildEnrollmentUrl("http://localhost:3000", "A1B2C3")).toBe(
      "http://localhost:3000/join/A1B2C3",
    );
  });
});
