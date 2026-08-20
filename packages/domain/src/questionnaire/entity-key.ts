import { ENTITY_KEY_ALPHABET, ENTITY_KEY_LENGTH } from "@lpr/contracts";

/**
 * `question_key` and `option_key` generation (FR-43, STRUCTURE.md §6).
 *
 * These are the export column keys, and must stay stable across every edit
 * and every future publish of the question or option they name — assigned
 * once at creation and never regenerated. Randomness is injected: this
 * package performs no I/O and imports no crypto module, so the generator
 * stays deterministic under test. Mirrors @lpr/domain's enrollment-code
 * generator.
 */

/** Bytes needed by `generateEntityKey`. */
export const ENTITY_KEY_BYTES = ENTITY_KEY_LENGTH;

export function generateEntityKey(prefix: "q" | "o", randomBytes: Uint8Array): string {
  if (randomBytes.length < ENTITY_KEY_BYTES) {
    throw new Error(
      `generateEntityKey needs at least ${ENTITY_KEY_BYTES} random bytes, got ${randomBytes.length}`,
    );
  }

  // 256 is not an exact multiple of the 36-character alphabet, so the modulo
  // gives four characters a very slightly higher chance than the other 32.
  // Unlike the enrollment code, this key is never guessed or brute-forced —
  // it only has to stay stable and collision-free as an export column name —
  // so the bias is immaterial and rejection sampling would be ceremony
  // without a purpose.
  let body = "";
  for (let i = 0; i < ENTITY_KEY_LENGTH; i += 1) {
    const byte = randomBytes[i] as number;
    body += ENTITY_KEY_ALPHABET[byte % ENTITY_KEY_ALPHABET.length];
  }
  return `${prefix}_${body}`;
}

export function generateQuestionKey(randomBytes: Uint8Array): string {
  return generateEntityKey("q", randomBytes);
}

export function generateOptionKey(randomBytes: Uint8Array): string {
  return generateEntityKey("o", randomBytes);
}
