/**
 * Continuity credential policy (STRUCTURE.md §11.3).
 *
 * A participant has no password and no account. What keeps them the same
 * person across a closed browser is a 256-bit token in an HttpOnly cookie,
 * and this file holds the two decisions that govern its life — both pure, so
 * "what happens on day 31" is a unit test rather than a month of waiting.
 *
 * ── Why rotation has a grace period ─────────────────────────────────────────
 * Rotating means minting a new token and sending a new cookie. A phone with
 * three requests in flight — a page load, an autosave, a notification
 * acknowledgement — has already sent the OLD token on two of them by the time
 * the first response rewrites the cookie. Revoking immediately would fail
 * those two, and a participant mid-questionnaire would be signed out with
 * unsaved answers.
 *
 * So the old credential stays valid for a grace period. The window is a
 * deliberate trade: a stolen token that has since been rotated keeps working
 * until the grace expires. Seven days is what STRUCTURE.md §11.3 fixed, on the
 * reasoning that a participant's device going offline for a week and returning
 * is ordinary, while the theft is not.
 */

/** A credential older than this is replaced on next use. */
export const CREDENTIAL_ROTATION_AFTER_DAYS = 30;

/** How long a rotated credential keeps working for requests already in flight. */
export const CREDENTIAL_GRACE_PERIOD_DAYS = 7;

const DAY_MS = 86_400_000;

export interface CredentialState {
  readonly issuedAt: Date;
  /**
   * Set when this credential has been superseded. Its own grace period runs
   * from that instant, not from when it was issued.
   */
  readonly rotatedAt: Date | null;
  readonly revokedAt: Date | null;
}

export type CredentialVerdict =
  | { readonly usable: true; readonly shouldRotate: boolean }
  | { readonly usable: false; readonly reason: CredentialRejection };

export type CredentialRejection = "REVOKED" | "GRACE_EXPIRED";

/**
 * May this credential be used right now, and should it be replaced?
 *
 * Deliberately separate from "is the token's hash correct" — that comparison
 * belongs where the secret lives, and keeping it out of here is what lets this
 * decision be exhaustively tested without a database or a real token.
 */
export function evaluateCredential(state: CredentialState, now: Date): CredentialVerdict {
  // Explicit revocation beats everything, including an unexpired grace period.
  // Withdrawal and recovery both revoke, and both must take effect at once.
  if (state.revokedAt !== null && state.revokedAt.getTime() <= now.getTime()) {
    return { usable: false, reason: "REVOKED" };
  }

  if (state.rotatedAt !== null) {
    const graceEnds = state.rotatedAt.getTime() + CREDENTIAL_GRACE_PERIOD_DAYS * DAY_MS;
    if (now.getTime() >= graceEnds) return { usable: false, reason: "GRACE_EXPIRED" };

    // Inside the grace period a superseded credential works, but must not
    // rotate again: it would chain replacements forever and the participant's
    // real credential is already the newer one.
    return { usable: true, shouldRotate: false };
  }

  const age = now.getTime() - state.issuedAt.getTime();
  return { usable: true, shouldRotate: age >= CREDENTIAL_ROTATION_AFTER_DAYS * DAY_MS };
}

/** When a credential rotated at `now` stops being accepted. */
export function graceExpiresAt(rotatedAt: Date): Date {
  return new Date(rotatedAt.getTime() + CREDENTIAL_GRACE_PERIOD_DAYS * DAY_MS);
}
