import { ENROLLMENT_CODE_ALPHABET, ENROLLMENT_CODE_LENGTH } from "@lpr/contracts";

/**
 * Public study enrollment codes (FR-01, FR-02).
 *
 * The code is printed on posters, read aloud, and typed on phones, so the
 * alphabet is Crockford base-32 with the visually ambiguous characters removed
 * (no I, L, O or U). A participant who mistypes should get "no such study",
 * never someone else's study.
 *
 * Codes are RANDOM, never sequential. A sequential study code would leak how
 * many studies the platform runs; the same reasoning applies with far more
 * force to participant codes in Phase 5 (STRUCTURE.md §6).
 *
 * Randomness is injected. This package performs no I/O and imports no crypto —
 * the caller passes bytes from a CSPRNG, which also makes the generator
 * deterministic under test.
 */

/** Bytes needed by `generateEnrollmentCode`. */
export const ENROLLMENT_CODE_BYTES = ENROLLMENT_CODE_LENGTH;

export function generateEnrollmentCode(randomBytes: Uint8Array): string {
  if (randomBytes.length < ENROLLMENT_CODE_BYTES) {
    throw new Error(
      `generateEnrollmentCode needs at least ${ENROLLMENT_CODE_BYTES} random bytes, got ${randomBytes.length}`,
    );
  }

  let code = "";
  for (let i = 0; i < ENROLLMENT_CODE_LENGTH; i += 1) {
    // 256 is an exact multiple of the 32-character alphabet, so the modulo is
    // uniform. With any other alphabet length this would bias the low
    // characters and would need rejection sampling instead.
    const byte = randomBytes[i] as number;
    code += ENROLLMENT_CODE_ALPHABET[byte % ENROLLMENT_CODE_ALPHABET.length];
  }
  return code;
}

/**
 * Canonicalise a human-typed code.
 *
 * Accepts lowercase, surrounding whitespace, and the separators people insert
 * when reading a code aloud ("abc-123"). Applies the Crockford confusion
 * mappings: `I` and `L` are read as `1`, `O` as `0`.
 *
 * `U` is NOT mapped. Crockford excludes it deliberately, and silently
 * rewriting it to something else would resolve a typo into a *different valid
 * study*. Returning null — "no such study" — is the safe failure.
 */
export function normalizeEnrollmentCode(input: string): string | null {
  const stripped = input.replace(/[\s-]/g, "").toUpperCase();
  if (stripped.length !== ENROLLMENT_CODE_LENGTH) return null;

  let normalized = "";
  for (const char of stripped) {
    const mapped = char === "I" || char === "L" ? "1" : char === "O" ? "0" : char;
    if (!ENROLLMENT_CODE_ALPHABET.includes(mapped)) return null;
    normalized += mapped;
  }
  return normalized;
}

/**
 * The participant-facing join URL (FR-01).
 *
 * Built from the participant application's origin, which is configuration —
 * the API never hard-codes a hostname. The QR code (FR-02) encodes exactly
 * this string, so the two can never disagree.
 */
export function buildEnrollmentUrl(participantOrigin: string, enrollmentCode: string): string {
  return new URL(`/join/${enrollmentCode}`, participantOrigin).toString();
}
