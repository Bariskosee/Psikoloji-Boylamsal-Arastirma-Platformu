import { ENROLLMENT_CODE_ALPHABET } from "@lpr/contracts";

/**
 * Participant identity codes (STRUCTURE.md §6, §11.3).
 *
 * Two codes, deliberately different in purpose and in what leaking one costs:
 *
 * **`public_code`** — `P-` plus six Crockford base-32 characters. It is the
 * pseudonym a researcher sees in a dashboard and an export. It identifies a
 * participant but grants nothing: knowing it does not let anyone act as them.
 *
 * **Recovery code** — eight characters, shown once at enrollment, redeemable
 * once. It DOES grant identity, which is why it is hashed at rest, rate
 * limited on redemption, and never shown again.
 *
 * Both are random, never sequential. A sequential participant code leaks
 * enrollment order and sample size — from a single participant's own code an
 * observer could infer how many people are in the study and roughly when each
 * joined, which is a re-identification lever in a small cohort.
 *
 * Randomness is injected: this package does no I/O and imports no crypto, so
 * every generator here is deterministic under test.
 */

export const PUBLIC_CODE_PREFIX = "P-";
export const PUBLIC_CODE_LENGTH = 6;
export const PUBLIC_CODE_BYTES = PUBLIC_CODE_LENGTH;

/**
 * Eight characters rather than six.
 *
 * A study code identifies a study, and guessing one gains an attacker a public
 * information page. A recovery code IS the participant, so its search space
 * has to absorb online guessing that the rate limiter only slows down. Eight
 * Crockford characters is 32^8 ≈ 1.1 × 10^12.
 */
export const RECOVERY_CODE_LENGTH = 8;
export const RECOVERY_CODE_BYTES = RECOVERY_CODE_LENGTH;

function encode(randomBytes: Uint8Array, length: number, what: string): string {
  if (randomBytes.length < length) {
    throw new Error(
      `${what} needs at least ${String(length)} random bytes, got ${String(randomBytes.length)}`,
    );
  }

  let code = "";
  for (let index = 0; index < length; index += 1) {
    // 256 is an exact multiple of the 32-character alphabet, so this modulo is
    // uniform. Any other alphabet length would bias the low characters and
    // would need rejection sampling instead.
    const byte = randomBytes[index] as number;
    code += ENROLLMENT_CODE_ALPHABET[byte % ENROLLMENT_CODE_ALPHABET.length];
  }
  return code;
}

export function generatePublicCode(randomBytes: Uint8Array): string {
  return PUBLIC_CODE_PREFIX + encode(randomBytes, PUBLIC_CODE_LENGTH, "generatePublicCode");
}

export function generateRecoveryCode(randomBytes: Uint8Array): string {
  return encode(randomBytes, RECOVERY_CODE_LENGTH, "generateRecoveryCode");
}

/**
 * Canonicalise a human-typed recovery code.
 *
 * Someone reading a code off a screen types lowercase, adds the separators
 * people insert when reading aloud, and hits the Crockford confusions: O for
 * 0, I or L for 1. Correcting those here means a participant who typed it
 * faithfully gets in, while the code space itself stays unambiguous.
 */
export function normalizeRecoveryCode(input: string): string {
  return input.trim().toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
}
