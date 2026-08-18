import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "@lpr/contracts";

/**
 * Researcher password policy.
 *
 * Length plus a small number of substantive checks. Composition rules
 * ("one uppercase, one digit, one symbol") are deliberately absent: they
 * measurably push people toward predictable shapes like `Password1!` and are
 * discouraged by NIST SP 800-63B. Length and not-obviously-guessable are what
 * actually resist an offline attack against an argon2id hash.
 *
 * Pure, so the policy is testable without a database and identical wherever it
 * is applied — the API on write, and the interface when it tells the user why.
 */

export type PasswordRejectionReason =
  "TOO_SHORT" | "TOO_LONG" | "CONTAINS_EMAIL" | "TOO_REPETITIVE" | "COMMON_PASSWORD";

export interface PasswordCheckResult {
  ok: boolean;
  reasons: PasswordRejectionReason[];
}

/**
 * A short list of the passwords an unsophisticated attacker tries first.
 *
 * Not a substitute for a breach-corpus check (that belongs in Phase 12
 * hardening if the research team wants it). It exists so the obvious cases
 * cannot be chosen at all, and it is compared against the lowercase form so
 * `Password1234` is caught too.
 */
const COMMON_PASSWORDS: readonly string[] = [
  "password",
  "password1",
  "password123",
  "password1234",
  "passw0rd",
  "qwertyuiop",
  "123456789012",
  "1234567890123",
  "letmein12345",
  "administrator",
  "researchdata",
  "sifre123456",
  "parola123456",
];

export function checkPassword(password: string, email?: string): PasswordCheckResult {
  const reasons: PasswordRejectionReason[] = [];

  if (password.length < MIN_PASSWORD_LENGTH) reasons.push("TOO_SHORT");
  if (password.length > MAX_PASSWORD_LENGTH) reasons.push("TOO_LONG");

  const lower = password.toLowerCase();

  // The email is the one string an attacker of this specific account is
  // guaranteed to know, so it must not be a component of the password.
  if (email) {
    const localPart = email.split("@")[0]?.toLowerCase() ?? "";
    if (localPart.length >= 3 && lower.includes(localPart)) reasons.push("CONTAINS_EMAIL");
  }

  // `aaaaaaaaaaaa` and `ababababababab` clear a length rule while carrying
  // almost no entropy.
  if (isRepetitive(password)) reasons.push("TOO_REPETITIVE");

  if (COMMON_PASSWORDS.includes(lower)) reasons.push("COMMON_PASSWORD");

  return { ok: reasons.length === 0, reasons };
}

/** True when the string is a short unit repeated to fill its length. */
function isRepetitive(password: string): boolean {
  if (password.length === 0) return false;
  for (let unit = 1; unit <= 4; unit += 1) {
    if (password.length % unit !== 0) continue;
    const head = password.slice(0, unit);
    if (head.repeat(password.length / unit) === password) return true;
  }
  return false;
}
